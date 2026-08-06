import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProductWorkloadIdentity } from
  "../../modules/authorization/domain/session-access-grant.js";
import type { ErrorCode, ErrorResponse } from "../../generated/contracts/openapi/platform-public/types.gen.js";
import { zErrorResponse } from "../../generated/contracts/openapi/platform-public/zod.gen.js";
import type { ArtifactDeliveryWorkloadBinding } from
  "../../modules/artifact/application/contracts.js";
import { ArtifactDeliveryRangeError } from
  "../../modules/artifact/application/artifact-delivery-service.js";
import {
  createPlatformPublicOperationRegistry,
  definePlatformPublicOperation,
} from "./platform-public-operation-registry.js";
import {
  parsePlatformPublicRequestTarget,
  platformPublicRequestHeaders,
} from "./platform-public.js";

const OPERATION_ID = "redeemArtifactDeliveryAuthorization" as const;
const ROUTE_PREFIX = "/v1/artifact-delivery-authorizations/";
const MAXIMUM_CAPABILITY_BYTES = 4_096;
const MAXIMUM_STREAM_CHUNK_BYTES = 8 * 1024 * 1024;
const MAXIMUM_ARTIFACT_BYTES = 32 * 1024 * 1024;
const binaryRegistry = createPlatformPublicOperationRegistry([
  definePlatformPublicOperation({
    operationId: OPERATION_ID,
    execute: () => Promise.reject(new Error("ARTIFACT_BINARY_HANDLER_EXECUTION_FORBIDDEN")),
  }),
], [OPERATION_ID]);

export { ArtifactDeliveryRangeError };

export interface ArtifactDataPlaneHttpHandler {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}

export interface ArtifactDeliveryDataPlanePort {
  redeem(input: Readonly<{
    authorizationRef: string;
    deliveryCapability: string;
    workload: ArtifactDeliveryWorkloadBinding;
    audience: "site-bff.artifact-delivery";
    requestRef: string;
    rangeHeader?: string | undefined;
    signal: AbortSignal;
  }>): Promise<Readonly<{
    status: 200 | 206;
    headers: Readonly<{
      contentType: string;
      contentLength: string;
      acceptRanges: "bytes";
      contentDisposition: string;
      eTag: string;
      contentRange?: string | undefined;
    }>;
    body: AsyncIterable<Uint8Array>;
  }>>;
}

/** Dedicated binary transport. It never invokes the generic JSON response parser. */
export function createArtifactDataPlaneHttpHandler(input: Readonly<{
  workloads: Readonly<{
    authenticate(request: IncomingMessage, operation: typeof OPERATION_ID):
      Pick<ProductWorkloadIdentity, "workloadIdentityId" | "siteRef" | "siteReleaseRef" |
        "bindingEpoch" | "siteSecurityEpoch">;
  }>;
  delivery: ArtifactDeliveryDataPlanePort;
  requestId: () => string;
}>): ArtifactDataPlaneHttpHandler {
  return Object.freeze({
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      if (request.url === undefined || !request.url.startsWith(ROUTE_PREFIX)) return false;
      let target;
      try {
        target = parsePlatformPublicRequestTarget(request.url);
      } catch {
        sendProblem(response, 400, input.requestId(), "INVALID_REQUEST");
        return true;
      }
      const matched = binaryRegistry.match(request.method, target.pathname);
      if (matched === null) return false;
      const requestRef = input.requestId();
      applyBaseHeaders(response, requestRef);
      const abort = new AbortController();
      let finished = false;
      const abortRequest = () => abort.abort(new Error("ARTIFACT_DELIVERY_CLIENT_ABORTED"));
      const abortResponse = () => { if (!finished) abortRequest(); };
      request.once("aborted", abortRequest);
      response.once("close", abortResponse);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (Object.keys(target.query).length !== 0) throw new Error("ARTIFACT_DELIVERY_INPUT_INVALID");
        const path = matched.definition.requestSchemas.path?.parse(matched.path) as
          Readonly<{ authorizationRef: string }>;
        const parsedHeaders = deliveryHeaders(
          matched.definition.requestSchemas.headers,
          request,
        );
        const workload = input.workloads.authenticate(request, OPERATION_ID);
        const deliveryCapability = capability(request.headers["x-kokoro-artifact-delivery-capability"]);
        timer = setTimeout(() => abort.abort(new Error("ARTIFACT_DELIVERY_DEADLINE_EXCEEDED")),
          parsedHeaders.deadlineMs);
        timer.unref();
        const delivery = await input.delivery.redeem({
          authorizationRef: path.authorizationRef,
          deliveryCapability,
          workload: workloadBinding(workload),
          audience: "site-bff.artifact-delivery",
          requestRef,
          ...(parsedHeaders.rangeHeader === undefined ? {} : { rangeHeader: parsedHeaders.rangeHeader }),
          signal: abort.signal,
        });
        const expectedBytes = validateDeliveryResponse(delivery);
        response.statusCode = delivery.status;
        response.setHeader("content-type", delivery.headers.contentType);
        response.setHeader("content-length", delivery.headers.contentLength);
        response.setHeader("content-disposition", delivery.headers.contentDisposition);
        response.setHeader("accept-ranges", "bytes");
        if (delivery.headers.contentRange !== undefined) {
          response.setHeader("content-range", delivery.headers.contentRange);
        }
        await streamBody(delivery.body, expectedBytes, response, abort.signal);
        finished = true;
        response.end();
        return true;
      } catch (error) {
        if (error instanceof ArtifactDeliveryRangeError && !response.headersSent) {
          sendUnsatisfiedRange(response, error.totalBytes, requestRef);
        } else if (!response.headersSent) {
          const problem = safeProblem(error);
          sendProblem(response, problem.status, requestRef, problem.code);
        } else {
          response.destroy(error instanceof Error ? error : undefined);
        }
        return true;
      } finally {
        finished = true;
        if (timer !== undefined) clearTimeout(timer);
        request.off("aborted", abortRequest);
        response.off("close", abortResponse);
      }
    },
  });
}

function deliveryHeaders(
  schema: NonNullable<ReturnType<typeof binaryRegistry.match>>["definition"]["requestSchemas"]["headers"],
  request: IncomingMessage,
): Readonly<{ deadlineMs: number; rangeHeader?: string | undefined }> {
  if (schema === null) throw new Error("ARTIFACT_DELIVERY_CONTRACT_INVALID");
  const projected = platformPublicRequestHeaders(schema, request.headers);
  const rangeValue = request.headers.range;
  if (rangeValue !== undefined && typeof rangeValue !== "string") {
    throw new Error("ARTIFACT_DELIVERY_INPUT_INVALID");
  }
  let parsed: Readonly<Record<string, unknown>>;
  try {
    parsed = schema.parse(projected) as Readonly<Record<string, unknown>>;
  } catch (error) {
    if (typeof rangeValue !== "string" || rangeValue.length > 64) throw error;
    const withoutRange = { ...projected };
    delete withoutRange.Range;
    parsed = schema.parse(withoutRange) as Readonly<Record<string, unknown>>;
  }
  const deadlineMs = parsed["X-Kokoro-Request-Deadline-Ms"];
  if (typeof deadlineMs !== "number") throw new Error("ARTIFACT_DELIVERY_CONTRACT_INVALID");
  return Object.freeze({ deadlineMs, ...(rangeValue === undefined ? {} : { rangeHeader: rangeValue }) });
}

function workloadBinding(input: Pick<ProductWorkloadIdentity,
"workloadIdentityId" | "siteRef" | "siteReleaseRef" | "bindingEpoch" | "siteSecurityEpoch">
): ArtifactDeliveryWorkloadBinding {
  return Object.freeze({
    siteRef: input.siteRef,
    siteReleaseRef: input.siteReleaseRef,
    workloadIdentityRef: input.workloadIdentityId,
    workloadBindingEpoch: epoch(input.bindingEpoch),
    siteSecurityEpoch: epoch(input.siteSecurityEpoch),
  });
}

function epoch(value: string): bigint {
  if (!/^[1-9][0-9]{0,18}$/u.test(value)) throw new Error("ARTIFACT_DELIVERY_WORKLOAD_INVALID");
  return BigInt(value);
}

function capability(value: string | string[] | undefined): string {
  if (
    typeof value !== "string" || value.length < 32 || value.length > MAXIMUM_CAPABILITY_BYTES ||
    value.trim() !== value || [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 32 || code === 127;
    })
  ) throw new Error("ARTIFACT_DELIVERY_CAPABILITY_INVALID");
  return value;
}

function validateDeliveryResponse(input: Awaited<ReturnType<ArtifactDeliveryDataPlanePort["redeem"]>>): bigint {
  const length = canonicalPositiveDecimal(input.headers.contentLength);
  if (
    length > BigInt(MAXIMUM_ARTIFACT_BYTES) ||
    !["image/png", "image/jpeg", "image/webp"].includes(input.headers.contentType) ||
    input.headers.acceptRanges !== "bytes" ||
    !/^"[a-f0-9]{64}"$/u.test(input.headers.eTag) ||
    !safeHeader(input.headers.contentDisposition, 2_048)
  ) throw new Error("ARTIFACT_DELIVERY_RESPONSE_INVALID");
  if (input.status === 200) {
    if (input.headers.contentRange !== undefined) throw new Error("ARTIFACT_DELIVERY_RESPONSE_INVALID");
    return length;
  }
  const match = /^bytes ([0-9]+)-([0-9]+)\/([1-9][0-9]*)$/u.exec(input.headers.contentRange ?? "");
  if (match === null) throw new Error("ARTIFACT_DELIVERY_RESPONSE_INVALID");
  const start = BigInt(match[1]!);
  const end = BigInt(match[2]!);
  const total = BigInt(match[3]!);
  if (end < start || end >= total || end - start + 1n !== length ||
      length > BigInt(MAXIMUM_STREAM_CHUNK_BYTES)) {
    throw new Error("ARTIFACT_DELIVERY_RESPONSE_INVALID");
  }
  return length;
}

async function streamBody(
  body: AsyncIterable<Uint8Array>,
  expectedBytes: bigint,
  response: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  let observed = 0n;
  for await (const chunk of body) {
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    if (!(chunk instanceof Uint8Array) || chunk.byteLength < 1 ||
        chunk.byteLength > MAXIMUM_STREAM_CHUNK_BYTES) {
      throw new Error("ARTIFACT_DELIVERY_BODY_INVALID");
    }
    observed += BigInt(chunk.byteLength);
    if (observed > expectedBytes) throw new Error("ARTIFACT_DELIVERY_BODY_OVERRUN");
    if (!response.write(chunk)) await once(response, "drain", { signal });
  }
  if (observed !== expectedBytes) throw new Error("ARTIFACT_DELIVERY_BODY_TRUNCATED");
}

function canonicalPositiveDecimal(value: string): bigint {
  if (!/^[1-9][0-9]{0,19}$/u.test(value)) throw new Error("ARTIFACT_DELIVERY_RESPONSE_INVALID");
  return BigInt(value);
}

function safeHeader(value: string, maximum: number): boolean {
  return value.length > 0 && value.length <= maximum && [...value].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 32 && code !== 127;
  });
}

function applyBaseHeaders(response: ServerResponse, requestRef: string): void {
  response.setHeader("x-request-id", requestRef);
  response.setHeader("cache-control", "private, no-store");
  response.setHeader("x-content-type-options", "nosniff");
}

function sendUnsatisfiedRange(response: ServerResponse, totalBytes: bigint, requestRef: string): void {
  if (totalBytes < 1n || totalBytes > BigInt(MAXIMUM_ARTIFACT_BYTES)) {
    sendProblem(response, 404, requestRef, "NOT_FOUND");
    return;
  }
  response.setHeader("content-range", `bytes */${totalBytes}`);
  response.setHeader("accept-ranges", "bytes");
  sendProblem(response, 416, requestRef, "ARTIFACT_RANGE_NOT_SATISFIABLE");
}

type ArtifactProblemCode = Extract<ErrorCode,
"INVALID_REQUEST" | "NOT_FOUND" | "ARTIFACT_TEMPORARILY_UNAVAILABLE" |
"ARTIFACT_RANGE_NOT_SATISFIABLE">;

function safeProblem(error: unknown): Readonly<{
  status: 400 | 404 | 503;
  code: ArtifactProblemCode;
}> {
  if (error instanceof Error && [
    "ARTIFACT_DELIVERY_INPUT_INVALID",
    "ARTIFACT_DELIVERY_CONTRACT_INVALID",
  ].includes(error.message)) return Object.freeze({ status: 400, code: "INVALID_REQUEST" });
  if (error instanceof Error && (
    error.message === "ARTIFACT_DELIVERY_DEADLINE_EXCEEDED" ||
    error.message === "ARTIFACT_DELIVERY_CLIENT_ABORTED"
  )) return Object.freeze({ status: 503, code: "ARTIFACT_TEMPORARILY_UNAVAILABLE" });
  return Object.freeze({ status: 404, code: "NOT_FOUND" });
}

function sendProblem(
  response: ServerResponse,
  status: 400 | 404 | 416 | 503,
  requestRef: string,
  code: ArtifactProblemCode,
): void {
  applyBaseHeaders(response, requestRef);
  response.statusCode = status;
  const parsed = zErrorResponse.parse(Object.freeze({
    code,
    correlationId: requestRef,
    requestId: requestRef,
    retryClass: status === 503 ? "after_delay" : "never",
    safeMessage: safeProblemMessage(code),
  }));
  const body: ErrorResponse = Object.freeze({ code: parsed.code,
    correlationId: parsed.correlationId, requestId: parsed.requestId,
    retryClass: parsed.retryClass, safeMessage: parsed.safeMessage });
  const encoded = Buffer.from(JSON.stringify(body));
  response.setHeader("content-type", "application/problem+json; charset=utf-8");
  response.setHeader("content-length", String(encoded.byteLength));
  response.end(encoded);
}

function safeProblemMessage(code: ArtifactProblemCode): string {
  if (code === "INVALID_REQUEST") return "The request is invalid.";
  if (code === "ARTIFACT_TEMPORARILY_UNAVAILABLE") return "Artifact delivery is temporarily unavailable.";
  if (code === "ARTIFACT_RANGE_NOT_SATISFIABLE") {
    return "The requested artifact byte range is not satisfiable.";
  }
  return "The requested artifact is unavailable.";
}
