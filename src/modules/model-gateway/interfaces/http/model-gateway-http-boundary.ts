import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  ModelGatewayInvocationResult,
  ModelGatewayService,
} from "../../application/model-gateway-service.js";

const reference = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
const requestSchema = z.object({
  modelAuthorizationHandle: reference.regex(/^model-authorization:sha256:[0-9a-f]{64}$/u),
  logicalCallRef: reference,
  attemptRef: reference,
  producerContext: reference,
  producerGeneration: z.string().regex(/^[1-9][0-9]{0,18}$/u).transform((value) => BigInt(value)),
  request: z.object({
    protocol: z.literal("openai.chat.completions.v1"),
    model: reference,
    messages: z.array(z.object({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string().min(1).max(2 * 1024 * 1024),
    }).strict()).min(1).max(512),
    maxOutputTokens: z.number().int().min(1).max(1_000_000),
  }).strict(),
}).strict();

const reconcileSchema = z.object({
  modelAuthorizationHandle: reference.regex(/^model-authorization:sha256:[0-9a-f]{64}$/u),
  logicalCallRef: reference,
  requestDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  outcome: z.object({
    kind: z.enum(["succeeded", "failed"]),
    responseBodyBase64url: z.string().min(1).max(12 * 1024 * 1024).regex(/^[A-Za-z0-9_-]+$/u),
    usage: z.array(z.object({
      dimensionKey: reference,
      sourceUnit: reference,
      quantity: z.string().regex(/^(?:0|[1-9][0-9]{0,37})$/u).transform((value) => BigInt(value)),
    }).strict()).min(1).max(64).nullable(),
    sourceDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    occurredAt: z.string().datetime({ offset: true }),
  }).strict(),
}).strict();

export type ModelGatewayHttpRequest = Readonly<{
  method: string;
  path: string;
  contentType: string | undefined;
  body: Uint8Array;
  callerScopes: readonly ("invoke" | "reconcile")[];
  signal: AbortSignal;
}>;

export type ModelGatewayHttpResponse = Readonly<{
  status: number;
  contentType: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}>;

export function createModelGatewayHttpBoundary(input: Readonly<{
  service: Pick<ModelGatewayService, "invoke" | "reconcileOutcome">;
}>): (request: ModelGatewayHttpRequest) => Promise<ModelGatewayHttpResponse> {
  return async (request) => {
    const invoke = request.method === "POST" && request.path === "/internal/v1/model-invocations";
    const reconcile = request.method === "POST" &&
      request.path === "/internal/v1/model-invocations/reconcile";
    if (!invoke && !reconcile) {
      return error(404, "not_found");
    }
    const requiredScope = reconcile ? "reconcile" : "invoke";
    if (!request.callerScopes.includes(requiredScope)) return error(403, "not_authorized");
    const maximumBytes = reconcile ? 12 * 1024 * 1024 : 2 * 1024 * 1024;
    if (request.contentType === undefined ||
        !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(request.contentType) ||
        request.body.byteLength < 1 || request.body.byteLength > maximumBytes ||
        !(request.signal instanceof AbortSignal)) {
      return error(400, "invalid_request");
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.body));
    } catch {
      return error(400, "invalid_request");
    }
    let result: ModelGatewayInvocationResult;
    try {
      if (reconcile) {
        const parsed = reconcileSchema.safeParse(parsedJson);
        if (!parsed.success) return error(400, "invalid_request");
        const responseBody = canonicalBase64url(parsed.data.outcome.responseBodyBase64url);
        if (responseBody.byteLength < 1 || responseBody.byteLength > 8 * 1024 * 1024 ||
            createHash("sha256").update(responseBody).digest("hex") !== parsed.data.outcome.sourceDigest ||
            !certifiedProviderResponse(responseBody, parsed.data.outcome.kind)) {
          return error(400, "invalid_provider_evidence");
        }
        result = await input.service.reconcileOutcome({
          modelAuthorizationHandle: parsed.data.modelAuthorizationHandle,
          logicalCallRef: parsed.data.logicalCallRef,
          requestDigest: parsed.data.requestDigest,
          outcome: Object.freeze({
            kind: parsed.data.outcome.kind,
            responseBody,
            usage: parsed.data.outcome.usage === null
              ? null
              : Object.freeze(parsed.data.outcome.usage.map((dimension) => Object.freeze(dimension))),
            sourceDigest: parsed.data.outcome.sourceDigest,
            occurredAt: parsed.data.outcome.occurredAt,
          }),
        });
      } else {
        const parsed = requestSchema.safeParse(parsedJson);
        if (!parsed.success) return error(400, "invalid_request");
        result = await input.service.invoke({ ...parsed.data, signal: request.signal });
      }
    } catch (cause) {
      return mapError(cause);
    }
    const headers = Object.freeze({
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-kokoro-model-invocation-ref": result.invocationRef,
      "x-kokoro-model-attempt-ref": result.attemptRef,
      "x-kokoro-model-outcome": result.kind,
      "x-kokoro-model-replayed": result.replayed ? "true" : "false",
    });
    if (result.kind === "outcome_unknown") {
      return Object.freeze({
        status: 202,
        contentType: "application/json",
        headers,
        body: new TextEncoder().encode('{"kind":"outcome_unknown"}'),
      });
    }
    return Object.freeze({
      status: 200,
      contentType: "application/json",
      headers,
      body: new Uint8Array(result.responseBody),
    });
  };
}

function canonicalBase64url(value: string): Uint8Array {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error("MODEL_GATEWAY_RECONCILIATION_BODY_INVALID");
  return Uint8Array.from(decoded);
}

function certifiedProviderResponse(
  body: Uint8Array,
  outcome: "succeeded" | "failed",
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return false;
  }
  if (!record(parsed)) return false;
  if (outcome === "succeeded") {
    return typeof parsed.id === "string" && parsed.id.length > 0 && parsed.id.length <= 256 &&
      Array.isArray(parsed.choices) && parsed.choices.length > 0;
  }
  if (Object.keys(parsed).join(",") !== "error" || !record(parsed.error) ||
      Object.keys(parsed.error).sort().join(",") !== "code,retryable") return false;
  return parsed.error.code === "MODEL_PROVIDER_REJECTED" &&
    typeof parsed.error.retryable === "boolean";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapError(cause: unknown): ModelGatewayHttpResponse {
  const code = cause instanceof Error ? cause.message : "";
  if (code.includes("CONFLICT")) return error(409, "request_conflict");
  if (code.includes("AUTHORIZATION") || code.includes("ROUTE_NOT_AUTHORIZED")) {
    return error(403, "not_authorized");
  }
  if (code.includes("INVALID") || code.includes("TOO_LARGE")) return error(400, "invalid_request");
  if (code.includes("CAPACITY") || code.includes("FENCE") || code.includes("NOT_OPEN")) {
    return error(409, "not_executable");
  }
  return error(503, "unavailable");
}

function error(status: number, code: string): ModelGatewayHttpResponse {
  return Object.freeze({
    status,
    contentType: "application/json",
    headers: Object.freeze({ "cache-control": "no-store", "x-content-type-options": "nosniff" }),
    body: new TextEncoder().encode(JSON.stringify({ error: { code } })),
  });
}
