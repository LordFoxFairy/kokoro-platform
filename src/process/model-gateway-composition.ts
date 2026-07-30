import { createServer, type Server as HttpsServer, type ServerOptions } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { TLSSocket } from "node:tls";
import type { PostgresModelGatewayDatabase } from
  "../modules/model-gateway/infrastructure/postgres/model-gateway-database.js";
import { PostgresModelGatewayRepository } from
  "../modules/model-gateway/infrastructure/postgres/model-gateway-repository.js";
import { createModelGatewayResponseProtector } from
  "../modules/model-gateway/infrastructure/crypto/response-protector.js";
import { LiteLlmChatAdapter } from
  "../modules/model-gateway/infrastructure/http/litellm-chat-adapter.js";
import { ModelGatewayService } from
  "../modules/model-gateway/application/model-gateway-service.js";
import { createModelGatewayHttpBoundary } from
  "../modules/model-gateway/interfaces/http/model-gateway-http-boundary.js";
import { createUsageSettlementProductionComposition } from "./usage-settlement-composition.js";
import { readBoundedPrivateFile, readBoundedRegularFile } from "./secret-files.js";

export type ModelGatewayRequestListener = (request: IncomingMessage, response: ServerResponse) => void;

export interface ModelGatewayProductionComposition {
  readonly handler: ModelGatewayRequestListener;
  createServer(listener: ModelGatewayRequestListener): HttpsServer;
  abortInFlight(reason: string): void;
  inFlightCount(): number;
}

export async function createModelGatewayProductionComposition(input: Readonly<{
  database: PostgresModelGatewayDatabase;
  environment?: Readonly<Record<string, string | undefined>>;
}>): Promise<ModelGatewayProductionComposition> {
  const environment = input.environment ?? process.env;
  const [tls, peers, responseKeyRingText, apiKeyText] = await Promise.all([
    loadTls(environment),
    loadPeers(required(environment, "PLATFORM_MODEL_GATEWAY_MTLS_PEERS_FILE")),
    readBoundedPrivateFile(
      required(environment, "PLATFORM_MODEL_GATEWAY_RESPONSE_KEY_RING_FILE"),
      256 * 1024,
      "PLATFORM_MODEL_GATEWAY_RESPONSE_KEY_RING_FILE_INVALID",
    ),
    readBoundedPrivateFile(
      required(environment, "PLATFORM_MODEL_GATEWAY_LITELLM_API_KEY_FILE"),
      8 * 1024,
      "PLATFORM_MODEL_GATEWAY_LITELLM_API_KEY_FILE_INVALID",
    ),
  ]);
  const responseProtector = createModelGatewayResponseProtector(parseResponseKeyRing(responseKeyRingText));
  const repository = new PostgresModelGatewayRepository({ responseProtector });
  const usageOwner = createUsageSettlementProductionComposition().owner;
  const providerTimeoutMs = boundedInteger(
    environment.PLATFORM_MODEL_GATEWAY_PROVIDER_TIMEOUT_MS ?? "30000",
    100,
    120_000,
    "PLATFORM_MODEL_GATEWAY_PROVIDER_TIMEOUT_MS_INVALID",
  );
  const provider = new LiteLlmChatAdapter({
    endpoint: required(environment, "PLATFORM_MODEL_GATEWAY_LITELLM_ENDPOINT"),
    apiKey: secretLine(apiKeyText, "PLATFORM_MODEL_GATEWAY_LITELLM_API_KEY_FILE_INVALID"),
    timeoutMs: providerTimeoutMs,
  });
  const service = new ModelGatewayService({
    unitOfWork: input.database,
    repository,
    provider,
    usageOwner,
    dispatchRecoveryAfterMs: Math.max(60_000, providerTimeoutMs * 2),
  });
  const boundary = createModelGatewayHttpBoundary({ service });
  const inFlight = new Set<AbortController>();
  const handler: ModelGatewayRequestListener = (request, response) => {
    const peer = authenticate(request, peers);
    if (peer === null) {
      respond(response, 401, "application/json", new TextEncoder().encode(
        '{"error":{"code":"unauthorized"}}',
      ), { "cache-control": "no-store" });
      return;
    }
    const controller = new AbortController();
    inFlight.add(controller);
    const abort = () => controller.abort(new Error("MODEL_GATEWAY_CLIENT_DISCONNECTED"));
    request.once("aborted", abort);
    const maximumBytes = request.url === "/internal/v1/model-invocations/reconcile"
      ? 12 * 1024 * 1024
      : 2 * 1024 * 1024;
    void readBoundedRequest(request, maximumBytes).then(
      (body) => boundary({
        method: request.method ?? "",
        path: request.url ?? "",
        contentType: firstHeader(request.headers["content-type"]),
        body,
        callerScopes: peer.scopes,
        signal: controller.signal,
      }),
    ).then(
      (result) => respond(response, result.status, result.contentType, result.body, result.headers),
      () => respond(response, 400, "application/json", new TextEncoder().encode(
        '{"error":{"code":"invalid_request"}}',
      ), { "cache-control": "no-store" }),
    ).finally(() => {
      request.off("aborted", abort);
      inFlight.delete(controller);
    });
  };
  return Object.freeze({
    handler,
    createServer: (listener: ModelGatewayRequestListener) => createServer(tls, listener),
    abortInFlight: (reason: string) => {
      for (const controller of inFlight) controller.abort(new Error(reason));
    },
    inFlightCount: () => inFlight.size,
  });
}

function respond(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: Uint8Array,
  headers: Readonly<Record<string, string>>,
): void {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("content-type", contentType);
  response.setHeader("content-length", String(body.byteLength));
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(body);
}

async function readBoundedRequest(request: IncomingMessage, maximumBytes: number): Promise<Uint8Array> {
  const declared = firstHeader(request.headers["content-length"]);
  if (declared !== undefined && (!/^[0-9]+$/u.test(declared) || BigInt(declared) > BigInt(maximumBytes))) {
    request.destroy();
    throw new Error("MODEL_GATEWAY_REQUEST_TOO_LARGE");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk);
    total += bytes.byteLength;
    if (total > maximumBytes) {
      request.destroy();
      throw new Error("MODEL_GATEWAY_REQUEST_TOO_LARGE");
    }
    chunks.push(bytes);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

interface Peer {
  readonly fingerprint256: string;
  readonly sanUri: string;
  readonly scopes: readonly ("invoke" | "reconcile")[];
}
function authenticate(request: IncomingMessage, peers: readonly Peer[]): Peer | null {
  const socket = request.socket;
  if (!(socket instanceof TLSSocket) || !socket.authorized || socket.authorizationError != null) return null;
  const certificate = socket.getPeerCertificate();
  const now = Date.now();
  const validFrom = Date.parse(certificate.valid_from);
  const validTo = Date.parse(certificate.valid_to);
  if (!certificate.fingerprint256 || !certificate.subjectaltname ||
      !Number.isFinite(validFrom) || !Number.isFinite(validTo) || validFrom > now || validTo <= now) return null;
  const uris = certificate.subjectaltname.split(/,\s*/u)
    .filter((item) => item.startsWith("URI:"))
    .map((item) => item.slice(4));
  return peers.find((peer) =>
    peer.fingerprint256 === certificate.fingerprint256 && uris.includes(peer.sanUri)) ?? null;
}

async function loadPeers(path: string): Promise<readonly Peer[]> {
  let value: unknown;
  try { value = JSON.parse(await readBoundedRegularFile(path, 256 * 1024,
    "PLATFORM_MODEL_GATEWAY_MTLS_PEERS_FILE_INVALID")); }
  catch { throw new Error("PLATFORM_MODEL_GATEWAY_MTLS_PEERS_FILE_INVALID"); }
  if (!object(value) || value.version !== 1 || !Array.isArray(value.peers) ||
      Object.keys(value).sort().join(",") !== "peers,version") {
    throw new Error("PLATFORM_MODEL_GATEWAY_MTLS_PEERS_FILE_INVALID");
  }
  const seenSans = new Set<string>();
  const seenFingerprints = new Set<string>();
  const peers = value.peers.map((raw): Peer => {
    if (!object(raw) || Object.keys(raw).sort().join(",") !== "fingerprint256,sanUri,scopes" ||
        typeof raw.fingerprint256 !== "string" ||
        !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u.test(raw.fingerprint256) ||
        typeof raw.sanUri !== "string" || !raw.sanUri.startsWith("spiffe://") || seenSans.has(raw.sanUri) ||
        seenFingerprints.has(raw.fingerprint256) ||
        !Array.isArray(raw.scopes) || raw.scopes.length < 1 || raw.scopes.length > 2 ||
        raw.scopes.some((scope) => scope !== "invoke" && scope !== "reconcile") ||
        new Set(raw.scopes).size !== raw.scopes.length) {
      throw new Error("PLATFORM_MODEL_GATEWAY_MTLS_PEERS_FILE_INVALID");
    }
    seenSans.add(raw.sanUri);
    seenFingerprints.add(raw.fingerprint256);
    return Object.freeze({
      fingerprint256: raw.fingerprint256,
      sanUri: raw.sanUri,
      scopes: Object.freeze([...raw.scopes]) as readonly ("invoke" | "reconcile")[],
    });
  });
  if (peers.length < 1 || peers.length > 32) throw new Error("PLATFORM_MODEL_GATEWAY_MTLS_PEERS_FILE_INVALID");
  return Object.freeze(peers);
}

async function loadTls(environment: Readonly<Record<string, string | undefined>>): Promise<ServerOptions> {
  const [key, cert, ca] = await Promise.all([
    readBoundedPrivateFile(required(environment, "PLATFORM_MODEL_GATEWAY_TLS_KEY_FILE"), 64 * 1024,
      "PLATFORM_MODEL_GATEWAY_TLS_KEY_FILE_INVALID"),
    readBoundedRegularFile(required(environment, "PLATFORM_MODEL_GATEWAY_TLS_CERT_FILE"), 64 * 1024,
      "PLATFORM_MODEL_GATEWAY_TLS_CERT_FILE_INVALID"),
    readBoundedRegularFile(required(environment, "PLATFORM_MODEL_GATEWAY_TLS_CLIENT_CA_FILE"), 256 * 1024,
      "PLATFORM_MODEL_GATEWAY_TLS_CLIENT_CA_FILE_INVALID"),
  ]);
  if (!key.includes("BEGIN PRIVATE KEY") || !cert.includes("BEGIN CERTIFICATE") ||
      !ca.includes("BEGIN CERTIFICATE")) throw new Error("PLATFORM_MODEL_GATEWAY_TLS_MATERIAL_INVALID");
  return Object.freeze({ key, cert, ca, requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3" });
}

function parseResponseKeyRing(value: string): Readonly<{
  currentKeyRevision: string;
  keys: readonly Readonly<{ keyRevision: string; key: Uint8Array }>[];
}> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("PLATFORM_MODEL_GATEWAY_RESPONSE_KEY_RING_FILE_INVALID"); }
  if (!object(parsed) || parsed.version !== 1 || typeof parsed.currentKeyRevision !== "string" ||
      !Array.isArray(parsed.keys) || parsed.keys.length < 1 || parsed.keys.length > 16 ||
      Object.keys(parsed).sort().join(",") !== "currentKeyRevision,keys,version") {
    throw new Error("PLATFORM_MODEL_GATEWAY_RESPONSE_KEY_RING_FILE_INVALID");
  }
  const keys = parsed.keys.map((raw) => {
    if (!object(raw) || Object.keys(raw).sort().join(",") !== "keyBase64url,keyRevision" ||
        typeof raw.keyRevision !== "string" || typeof raw.keyBase64url !== "string" ||
        !/^[A-Za-z0-9_-]+$/u.test(raw.keyBase64url)) {
      throw new Error("PLATFORM_MODEL_GATEWAY_RESPONSE_KEY_RING_FILE_INVALID");
    }
    const key = Buffer.from(raw.keyBase64url, "base64url");
    if (key.byteLength !== 32 || key.toString("base64url") !== raw.keyBase64url) {
      throw new Error("PLATFORM_MODEL_GATEWAY_RESPONSE_KEY_RING_FILE_INVALID");
    }
    return Object.freeze({ keyRevision: raw.keyRevision, key: Uint8Array.from(key) });
  });
  return Object.freeze({ currentKeyRevision: parsed.currentKeyRevision, keys: Object.freeze(keys) });
}

function secretLine(value: string, code: string): string {
  const trimmed = value.endsWith("\n") ? value.slice(0, -1) : value;
  if (trimmed.length < 1 || trimmed.length > 4096 || /[\0\r\n]/u.test(trimmed)) throw new Error(code);
  return trimmed;
}
function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.length === 1 ? value[0] : undefined;
}
function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length < 1 || value.trim() !== value) throw new Error(`${name}_REQUIRED`);
  return value;
}
function boundedInteger(value: string, minimum: number, maximum: number, code: string): number {
  if (!/^[0-9]+$/u.test(value)) throw new Error(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(code);
  return parsed;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
