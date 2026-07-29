import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import type {
  AuthorizedAssetMultipartSnapshot,
  StoredAssetMultipartPart,
  StoredAssetMultipartUpload,
} from "../../modules/asset/application/contracts/asset-multipart-ports.js";
import type { AssetUploadCapabilityClaims } from
  "../../modules/asset/application/contracts/asset-upload-ports.js";
import type {
  ErrorCode,
  ErrorResponse,
  MultipartCommandReceipt,
  MultipartPart,
  MultipartPartResponse,
  MultipartUploadState,
  MultipartUploadStateResponse,
} from "./generated/asset-data-plane/types.gen.js";
import {
  zAbortAssetMultipartUploadBody,
  zAbortAssetMultipartUploadHeaders,
  zCompleteAssetMultipartUploadBody,
  zCompleteAssetMultipartUploadHeaders,
  zErrorResponse,
  zGetAssetMultipartUploadStatusHeaders,
  zInitiateAssetMultipartUploadBody,
  zInitiateAssetMultipartUploadHeaders,
  zMultipartPartResponse,
  zMultipartUploadStateResponse,
  zPutAssetMultipartPartHeaders,
} from "./generated/asset-data-plane/zod.gen.js";
import { exactHttpsOrigin } from
  "../../modules/asset/infrastructure/config/asset-upload-policy-registry.js";

export interface AssetDataPlaneHttpHandler {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}

export interface AssetDataPlaneMultipartOperations {
  initiate(input: Readonly<{
    claims: AssetUploadCapabilityClaims;
    clientUploadId: string;
    idempotencyKey: string;
  }>): Promise<AuthorizedAssetMultipartSnapshot>;
  putPart(input: Readonly<{
    claims: AssetUploadCapabilityClaims;
    uploadRef: string;
    partNumber: number;
    declaredSize: bigint;
    checksumSha256: string;
    idempotencyKey: string;
    body: Readable;
  }>): Promise<AuthorizedAssetMultipartSnapshot>;
  complete(input: Readonly<{
    claims: AssetUploadCapabilityClaims;
    uploadRef: string;
    expectedVersion: bigint;
    expectedSize: bigint;
    expectedChecksumSha256: string;
    parts: readonly Readonly<{ partNumber: number; partReceipt: string }>[];
    idempotencyKey: string;
  }>): Promise<AuthorizedAssetMultipartSnapshot>;
  abort(input: Readonly<{
    claims: AssetUploadCapabilityClaims;
    uploadRef: string;
    expectedVersion: bigint;
    idempotencyKey: string;
  }>): Promise<AuthorizedAssetMultipartSnapshot>;
  status(
    claims: AssetUploadCapabilityClaims,
    uploadRef: string,
  ): Promise<AuthorizedAssetMultipartSnapshot>;
}

type AssetDataPlaneRoute =
  | Readonly<{ kind: "initiate"; expectedMethod: "POST" }>
  | Readonly<{ kind: "status"; expectedMethod: "GET"; uploadRef: string }>
  | Readonly<{ kind: "part"; expectedMethod: "PUT"; uploadRef: string; partNumber: number }>
  | Readonly<{ kind: "complete"; expectedMethod: "POST"; uploadRef: string }>
  | Readonly<{ kind: "abort"; expectedMethod: "POST"; uploadRef: string }>;

type RetryClass = ErrorResponse["retryClass"];

export function createAssetDataPlaneHttpHandler(input: Readonly<{
  expectedAudience: string;
  capabilities: Readonly<{ verify(credential: string): AssetUploadCapabilityClaims | null }>;
  policies: Readonly<{ allowsOrigin(audience: string, origin: string): boolean }>;
  multipart: AssetDataPlaneMultipartOperations;
  clock?: () => Date;
  requestId?: () => string;
}>): AssetDataPlaneHttpHandler {
  if (input.expectedAudience.length < 1 || input.expectedAudience.length > 256) {
    throw new Error("ASSET_DATA_PLANE_AUDIENCE_INVALID");
  }
  const clock = input.clock ?? (() => new Date());
  const requestId = input.requestId ?? randomUUID;

  return Object.freeze({
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const id = requestId();
      applyBaseHeaders(response, id);
      let admittedOrigin: string | null = null;
      try {
        const route = parseRoute(request.url);
        if (route === null) return false;
        if (request.method === "OPTIONS") {
          admittedOrigin = handlePreflight(input, route, request, response);
          return true;
        }
        if (request.method !== route.expectedMethod) return false;
        const origin = requiredOrigin(request);
        const claims = authenticate(input, request, origin, clock());
        admittedOrigin = origin;
        response.setHeader("access-control-allow-origin", origin);
        await executeAuthenticated(input.multipart, route, request, response, claims, clock());
        return true;
      } catch (error) {
        sendProblem(response, safeProblem(error, id, clock()), admittedOrigin);
        return true;
      }
    },
  });
}

function handlePreflight(
  input: Readonly<{
    expectedAudience: string;
    policies: Readonly<{ allowsOrigin(audience: string, origin: string): boolean }>;
  }>,
  route: AssetDataPlaneRoute,
  request: IncomingMessage,
  response: ServerResponse,
): string {
  const origin = requiredOrigin(request);
  if (!input.policies.allowsOrigin(input.expectedAudience, origin)) {
    throw rejectedCapability(403);
  }
  response.setHeader("access-control-allow-origin", origin);
  const requestedMethod = singleHeader(request, "access-control-request-method");
  const requestedHeaders = parseRequestedHeaderSet(
    singleHeader(request, "access-control-request-headers"),
  );
  const allowedHeaders = allowedHeadersFor(route);
  if (requestedMethod !== route.expectedMethod || !sameSet(requestedHeaders, allowedHeaders)) {
    throw new AssetDataPlaneHttpError("UPLOAD_NOT_ACCEPTED", 400, "never");
  }
  response.statusCode = 204;
  response.setHeader("access-control-allow-methods", `${route.expectedMethod}, OPTIONS`);
  response.setHeader("access-control-allow-headers", [...allowedHeaders].join(", "));
  response.setHeader("access-control-max-age", "300");
  response.end();
  return origin;
}

async function executeAuthenticated(
  multipart: AssetDataPlaneMultipartOperations,
  route: AssetDataPlaneRoute,
  request: IncomingMessage,
  response: ServerResponse,
  claims: AssetUploadCapabilityClaims,
  now: Date,
): Promise<void> {
  if (route.kind === "initiate") {
    const headers = parseBoundary(zInitiateAssetMultipartUploadHeaders, commandHeaders(request));
    const body = parseBoundary(zInitiateAssetMultipartUploadBody, await readJsonBody(request));
    const snapshot = await multipart.initiate({
      claims,
      clientUploadId: body.clientUploadId,
      idempotencyKey: headers["Idempotency-Key"],
    });
    sendUpload(response, 200, snapshot, now, "initiate");
    return;
  }
  if (route.kind === "status") {
    parseBoundary(zGetAssetMultipartUploadStatusHeaders, contractHeaders(request));
    sendUpload(response, 200, await multipart.status(claims, route.uploadRef), now, null);
    return;
  }
  if (route.kind === "part") {
    const headers = parseBoundary(zPutAssetMultipartPartHeaders, partHeaders(request));
    const declaredSize = BigInt(headers["X-Kokoro-Content-Length"]);
    if (declaredSize > BigInt(claims.maximumPartBytes)) {
      request.resume();
      throw new AssetDataPlaneHttpError("UPLOAD_SIZE_EXCEEDED", 413, "after_user_action");
    }
    const transportLength = optionalCanonicalLength(request.headers["content-length"]);
    if (transportLength !== null && transportLength !== declaredSize) {
      throw new AssetDataPlaneHttpError("UPLOAD_PART_INVALID", 422, "never");
    }
    const snapshot = await multipart.putPart({
      claims,
      uploadRef: route.uploadRef,
      partNumber: route.partNumber,
      declaredSize,
      checksumSha256: headers["X-Kokoro-Content-Sha256"],
      idempotencyKey: headers["Idempotency-Key"],
      body: request,
    });
    sendPart(response, snapshot, route.partNumber, now);
    return;
  }
  if (route.kind === "complete") {
    const headers = parseBoundary(zCompleteAssetMultipartUploadHeaders, commandHeaders(request));
    const body = parseBoundary(zCompleteAssetMultipartUploadBody, await readJsonBody(request));
    const snapshot = await multipart.complete({
      claims,
      uploadRef: route.uploadRef,
      expectedVersion: BigInt(body.expectedVersion),
      expectedSize: BigInt(body.expectedSize),
      expectedChecksumSha256: body.expectedChecksumSha256,
      parts: Object.freeze(body.parts.map((part) => Object.freeze({ ...part }))),
      idempotencyKey: headers["Idempotency-Key"],
    });
    sendUpload(response, transient(snapshot) ? 202 : 200, snapshot, now, "complete");
    return;
  }
  const headers = parseBoundary(zAbortAssetMultipartUploadHeaders, commandHeaders(request));
  const body = parseBoundary(zAbortAssetMultipartUploadBody, await readJsonBody(request));
  const snapshot = await multipart.abort({
    claims,
    uploadRef: route.uploadRef,
    expectedVersion: BigInt(body.expectedVersion),
    idempotencyKey: headers["Idempotency-Key"],
  });
  sendUpload(response, transient(snapshot) ? 202 : 200, snapshot, now, "abort");
}

function authenticate(
  input: Readonly<{
    expectedAudience: string;
    capabilities: Readonly<{ verify(credential: string): AssetUploadCapabilityClaims | null }>;
    policies: Readonly<{ allowsOrigin(audience: string, origin: string): boolean }>;
  }>,
  request: IncomingMessage,
  origin: string,
  now: Date,
): AssetUploadCapabilityClaims {
  const authorization = singleHeader(request, "authorization");
  if (!authorization.startsWith("Bearer ")) throw rejectedCapability(401);
  const credential = authorization.slice(7);
  if (
    credential.length < 32 || credential.length > 4_096 || credential.trim() !== credential ||
    [...credential].some((character) => (character.codePointAt(0) ?? 0) <= 32)
  ) throw rejectedCapability(401);
  const claims = input.capabilities.verify(credential);
  if (
    claims === null || claims.audience !== input.expectedAudience ||
    !Number.isFinite(now.getTime()) || Date.parse(claims.expiresAt) <= now.getTime()
  ) throw rejectedCapability(401);
  if (!claims.allowedOrigins.includes(origin) || !input.policies.allowsOrigin(claims.audience, origin)) {
    throw rejectedCapability(403);
  }
  return claims;
}

function sendUpload(
  response: ServerResponse,
  status: number,
  snapshot: AuthorizedAssetMultipartSnapshot,
  now: Date,
  operation: "initiate" | "complete" | "abort" | null,
): void {
  const body: MultipartUploadStateResponse = Object.freeze({
    receipt: selectReceipt(snapshot, operation),
    upload: publicUpload(snapshot, now),
  });
  sendJson(response, status, parseBoundary(zMultipartUploadStateResponse, body));
}

function sendPart(
  response: ServerResponse,
  snapshot: AuthorizedAssetMultipartSnapshot,
  partNumber: number,
  now: Date,
): void {
  const upload = requiredUpload(snapshot);
  const storedPart = snapshot.parts.find((part) => part.partNumber === partNumber);
  if (storedPart?.state !== "committed") {
    throw new AssetDataPlaneHttpError("UPLOAD_TEMPORARILY_UNAVAILABLE", 503, "after_delay");
  }
  const body: MultipartPartResponse = Object.freeze({
    part: publicPart(storedPart),
    receipt: Object.freeze({
      operation: "put_part",
      receiptRef: storedPart.partReceipt,
      receivedAt: upload.createdAt,
      state: "succeeded",
      updatedAt: upload.updatedAt,
    }),
    upload: publicUpload(snapshot, now),
  });
  sendJson(response, 200, parseBoundary(zMultipartPartResponse, body));
}

function publicUpload(
  snapshot: AuthorizedAssetMultipartSnapshot,
  now: Date,
): MultipartUploadState {
  const upload = requiredUpload(snapshot);
  const retry = retryState(upload.state, now);
  return Object.freeze({
    expectedSize: snapshot.claims.expectedSize,
    expectedVersion: upload.expectedVersion.toString(),
    expiresAt: snapshot.claims.expiresAt,
    partSize: snapshot.claims.maximumPartBytes,
    parts: snapshot.parts.filter((part) => part.state === "committed")
      .sort((left, right) => left.partNumber - right.partNumber)
      .map(publicPart),
    protocolRevision: "s3-multipart-v1",
    retryAfter: retry.retryAfter,
    retryClass: retry.retryClass,
    safeReasonCode: upload.state === "integrity_rejected" ? "UPLOAD_PART_INVALID" : null,
    state: upload.state,
    uploadRef: upload.uploadRef,
  });
}

function publicPart(part: StoredAssetMultipartPart): MultipartPart {
  return Object.freeze({
    checksumSha256: part.checksumSha256,
    partNumber: part.partNumber,
    partReceipt: part.partReceipt,
    size: part.size.toString(),
  });
}

function selectReceipt(
  snapshot: AuthorizedAssetMultipartSnapshot,
  requested: "initiate" | "complete" | "abort" | null,
): MultipartCommandReceipt | null {
  const upload = requiredUpload(snapshot);
  const operation = requested ?? latestReceiptOperation(upload);
  if (operation === "complete" && upload.completionReceiptRef !== null) {
    return receipt(upload, "complete", upload.completionReceiptRef);
  }
  if (operation === "abort" && upload.abortReceiptRef !== null) {
    return receipt(upload, "abort", upload.abortReceiptRef);
  }
  if (operation === "initiate") {
    return receipt(upload, "initiate", upload.initiationReceiptRef);
  }
  return null;
}

function latestReceiptOperation(
  upload: StoredAssetMultipartUpload,
): "initiate" | "complete" | "abort" {
  if (
    upload.abortReceiptRef !== null &&
    (upload.state === "aborting" || upload.state === "aborted" ||
      (upload.state === "outcome_unknown" && upload.outcomeOperation === "abort"))
  ) return "abort";
  if (
    upload.completionReceiptRef !== null &&
    (upload.state === "completing" || upload.state === "uploaded" ||
      upload.state === "integrity_rejected" ||
      (upload.state === "outcome_unknown" && upload.outcomeOperation === "complete"))
  ) return "complete";
  return "initiate";
}

function receipt(
  upload: StoredAssetMultipartUpload,
  operation: "initiate" | "complete" | "abort",
  receiptRef: string,
): MultipartCommandReceipt {
  const unresolved =
    (operation === "initiate" && (upload.state === "initiating" ||
      (upload.state === "outcome_unknown" && upload.outcomeOperation === "initiate"))) ||
    (operation === "complete" && (upload.state === "completing" ||
      (upload.state === "outcome_unknown" && upload.outcomeOperation === "complete"))) ||
    (operation === "abort" && (upload.state === "aborting" ||
      (upload.state === "outcome_unknown" && upload.outcomeOperation === "abort")));
  return Object.freeze({
    operation,
    receiptRef,
    receivedAt: upload.createdAt,
    state: operation === "complete" && upload.state === "integrity_rejected"
      ? "integrity_rejected"
      : unresolved ? "outcome_unknown" : "succeeded",
    updatedAt: upload.updatedAt,
  });
}

function retryState(
  state: StoredAssetMultipartUpload["state"],
  now: Date,
): Readonly<{ retryClass: RetryClass; retryAfter: string | null }> {
  if (["uploaded", "aborted", "integrity_rejected"].includes(state)) {
    return Object.freeze({ retryClass: "never", retryAfter: null });
  }
  if (state === "uploading") {
    return Object.freeze({ retryClass: "after_user_action", retryAfter: null });
  }
  return Object.freeze({
    retryClass: "after_delay",
    retryAfter: new Date(now.getTime() + 1_000).toISOString(),
  });
}

function transient(snapshot: AuthorizedAssetMultipartSnapshot): boolean {
  const state = requiredUpload(snapshot).state;
  return ["initiating", "completing", "aborting", "outcome_unknown"].includes(state);
}

function requiredUpload(snapshot: AuthorizedAssetMultipartSnapshot): StoredAssetMultipartUpload {
  if (snapshot.upload === null) throw new Error("UPLOAD_NOT_ACCEPTED");
  return snapshot.upload;
}

function parseRoute(raw: string | undefined): AssetDataPlaneRoute | null {
  if (
    raw === undefined || raw.length < 1 || raw.length > 2_048 || !raw.startsWith("/") ||
    raw.startsWith("//") || raw.includes("?") || raw.includes("#") || raw.includes("%")
  ) throw new AssetDataPlaneHttpError("UPLOAD_NOT_ACCEPTED", 400, "never");
  if (raw === "/v1/multipart-uploads") return Object.freeze({ kind: "initiate", expectedMethod: "POST" });
  const identifier = "([A-Za-z0-9][A-Za-z0-9._:-]{15,127})";
  const part = raw.match(new RegExp(`^/v1/multipart-uploads/${identifier}/parts/([1-9][0-9]{0,4})$`, "u"));
  if (part !== null) {
    const partNumber = Number(part[2]);
    if (partNumber < 1 || partNumber > 10_000) {
      throw new AssetDataPlaneHttpError("UPLOAD_PART_INVALID", 422, "never");
    }
    return Object.freeze({ kind: "part", expectedMethod: "PUT", uploadRef: part[1]!, partNumber });
  }
  const terminal = raw.match(new RegExp(`^/v1/multipart-uploads/${identifier}:(complete|abort)$`, "u"));
  if (terminal !== null) {
    return terminal[2] === "complete"
      ? Object.freeze({ kind: "complete", expectedMethod: "POST", uploadRef: terminal[1]! })
      : Object.freeze({ kind: "abort", expectedMethod: "POST", uploadRef: terminal[1]! });
  }
  const status = raw.match(new RegExp(`^/v1/multipart-uploads/${identifier}$`, "u"));
  return status === null
    ? null
    : Object.freeze({ kind: "status", expectedMethod: "GET", uploadRef: status[1]! });
}

function requiredOrigin(request: IncomingMessage): string {
  const origin = singleHeader(request, "origin");
  if (exactHttpsOrigin(origin) !== origin) throw rejectedCapability(403);
  return origin;
}

function contractHeaders(request: IncomingMessage): Readonly<Record<string, string>> {
  return Object.freeze({ "Kokoro-Contract-Version": singleHeader(request, "kokoro-contract-version") });
}

function commandHeaders(request: IncomingMessage): Readonly<Record<string, string>> {
  return Object.freeze({
    ...contractHeaders(request),
    "Idempotency-Key": singleHeader(request, "idempotency-key"),
  });
}

function partHeaders(request: IncomingMessage): Readonly<Record<string, string>> {
  return Object.freeze({
    ...commandHeaders(request),
    "X-Kokoro-Content-Length": singleHeader(request, "x-kokoro-content-length"),
    "X-Kokoro-Content-Sha256": singleHeader(request, "x-kokoro-content-sha256"),
  });
}

function singleHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string") {
    throw new AssetDataPlaneHttpError("UPLOAD_NOT_ACCEPTED", 400, "never");
  }
  return value;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new AssetDataPlaneHttpError("UPLOAD_NOT_ACCEPTED", 400, "never");
  }
  const declared = optionalCanonicalLength(request.headers["content-length"]);
  if (declared !== null && declared > 65_536n) {
    request.resume();
    throw new AssetDataPlaneHttpError("UPLOAD_NOT_ACCEPTED", 400, "never");
  }
  const chunks: Buffer[] = [];
  let observed = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    observed += bytes.byteLength;
    if (observed > 65_536) {
      request.resume();
      throw new AssetDataPlaneHttpError("UPLOAD_NOT_ACCEPTED", 400, "never");
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new AssetDataPlaneHttpError("UPLOAD_NOT_ACCEPTED", 400, "never");
  }
}

function optionalCanonicalLength(value: string | string[] | undefined): bigint | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/u.test(value)) {
    throw new AssetDataPlaneHttpError("UPLOAD_NOT_ACCEPTED", 400, "never");
  }
  const parsed = BigInt(value);
  if (parsed > 18_446_744_073_709_551_615n) {
    throw new AssetDataPlaneHttpError("UPLOAD_NOT_ACCEPTED", 400, "never");
  }
  return parsed;
}

function allowedHeadersFor(route: AssetDataPlaneRoute): ReadonlySet<string> {
  const names = route.kind === "status"
    ? ["authorization", "kokoro-contract-version"]
    : route.kind === "part"
      ? [
          "authorization", "content-type", "idempotency-key", "kokoro-contract-version",
          "x-kokoro-content-length", "x-kokoro-content-sha256",
        ]
      : ["authorization", "content-type", "idempotency-key", "kokoro-contract-version"];
  return new Set(names);
}

function parseRequestedHeaderSet(value: string): ReadonlySet<string> {
  if (value.length < 1 || value.length > 512) {
    throw new AssetDataPlaneHttpError("UPLOAD_NOT_ACCEPTED", 400, "never");
  }
  const names = value.split(",").map((name) => name.trim().toLowerCase());
  if (
    names.some((name) => !/^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(name)) ||
    new Set(names).size !== names.length
  ) throw new AssetDataPlaneHttpError("UPLOAD_NOT_ACCEPTED", 400, "never");
  return new Set(names);
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function applyBaseHeaders(response: ServerResponse, requestId: string): void {
  response.setHeader("x-request-id", requestId);
  response.setHeader("cache-control", "no-store");
  response.setHeader("vary", "Origin");
  response.setHeader("x-content-type-options", "nosniff");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function sendProblem(
  response: ServerResponse,
  problem: Readonly<{ status: number; body: ErrorResponse }>,
  admittedOrigin: string | null,
): void {
  if (admittedOrigin === null) response.removeHeader?.("access-control-allow-origin");
  response.statusCode = problem.status;
  response.setHeader("content-type", "application/problem+json; charset=utf-8");
  response.end(JSON.stringify(problem.body));
}

function safeProblem(
  error: unknown,
  requestId: string,
  now: Date,
): Readonly<{ status: number; body: ErrorResponse }> {
  const mapped = mapError(error);
  const body: ErrorResponse = Object.freeze({
    code: mapped.code,
    requestId,
    retryAfter: mapped.retryClass === "after_delay"
      ? new Date(now.getTime() + 1_000).toISOString()
      : null,
    retryClass: mapped.retryClass,
    safeMessage: SAFE_MESSAGES[mapped.code],
  });
  return Object.freeze({ status: mapped.status, body: parseBoundary(zErrorResponse, body) });
}

function mapError(error: unknown): AssetDataPlaneHttpError {
  if (error instanceof AssetDataPlaneHttpError) return error;
  const message = error instanceof Error ? error.message : "";
  if (message === "UPLOAD_CAPABILITY_REJECTED") return rejectedCapability(401);
  if (message === "UPLOAD_NOT_ACCEPTED") {
    return new AssetDataPlaneHttpError("UPLOAD_NOT_ACCEPTED", 404, "never");
  }
  if (message === "UPLOAD_STATE_CONFLICT") {
    return new AssetDataPlaneHttpError("UPLOAD_STATE_CONFLICT", 409, "never");
  }
  if (message === "UPLOAD_PART_CONFLICT") {
    return new AssetDataPlaneHttpError("UPLOAD_PART_CONFLICT", 409, "never");
  }
  if (
    message === "UPLOAD_PART_INVALID" ||
    message === "ASSET_MULTIPART_PART_LENGTH_MISMATCH" ||
    message === "ASSET_MULTIPART_PART_CHECKSUM_MISMATCH"
  ) return new AssetDataPlaneHttpError("UPLOAD_PART_INVALID", 422, "never");
  if (message === "UPLOAD_SIZE_EXCEEDED") {
    return new AssetDataPlaneHttpError("UPLOAD_SIZE_EXCEEDED", 413, "after_user_action");
  }
  return new AssetDataPlaneHttpError("UPLOAD_TEMPORARILY_UNAVAILABLE", 503, "after_delay");
}

function rejectedCapability(status: 401 | 403): AssetDataPlaneHttpError {
  return new AssetDataPlaneHttpError("UPLOAD_CAPABILITY_REJECTED", status, "never");
}

class AssetDataPlaneHttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    readonly retryClass: RetryClass,
  ) {
    super(code);
    this.name = "AssetDataPlaneHttpError";
  }
}

const SAFE_MESSAGES: Readonly<Record<ErrorCode, string>> = Object.freeze({
  UPLOAD_CAPABILITY_REJECTED: "Upload authorization was rejected.",
  UPLOAD_NOT_ACCEPTED: "The upload request was not accepted.",
  UPLOAD_STATE_CONFLICT: "The upload state changed. Refresh it before retrying.",
  UPLOAD_PART_CONFLICT: "The upload part conflicts with its durable receipt.",
  UPLOAD_PART_INVALID: "The upload part is invalid.",
  UPLOAD_SIZE_EXCEEDED: "The upload exceeds its allowed size.",
  UPLOAD_TEMPORARILY_UNAVAILABLE: "The upload is temporarily unavailable.",
});

interface RuntimeSchema<Output> {
  parse(value: unknown): Output;
}

function parseBoundary<Output>(schema: RuntimeSchema<Output>, value: unknown): Output {
  try {
    return schema.parse(value);
  } catch {
    throw new AssetDataPlaneHttpError("UPLOAD_NOT_ACCEPTED", 400, "never");
  }
}
