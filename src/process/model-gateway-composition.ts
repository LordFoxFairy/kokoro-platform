import { AsyncLocalStorage } from "node:async_hooks";
import { createSecureServer, type Http2SecureServer, type SecureServerOptions } from "node:http2";
import type { Http2ServerRequest, Http2ServerResponse } from "node:http2";
import { TLSSocket } from "node:tls";
import { compressionGzip, connectNodeAdapter } from "@connectrpc/connect-node";
import { ModelGatewayService as ModelGatewayConnectDefinition } from
  "../generated/proto/kokoro/platform/model/v1/model_gateway_pb.js";
import type { PostgresModelGatewayDatabase } from
  "../modules/model-gateway/infrastructure/postgres/model-gateway-database.js";
import { PostgresModelGatewayRepository } from
  "../modules/model-gateway/infrastructure/postgres/model-gateway-repository.js";
import { createModelGatewayResponseProtector } from
  "../modules/model-gateway/infrastructure/crypto/response-protector.js";
import { DirectOpenAiChatAdapter, LiteLlmChatAdapter } from
  "../modules/model-gateway/infrastructure/http/openai-compatible-chat-adapter.js";
import { ModelGatewayProviderRouter, ModelGatewayService } from
  "../modules/model-gateway/application/model-gateway-service.js";
import { createModelGatewayConnectService } from
  "../modules/model-gateway/interfaces/connect/model-gateway-connect-service.js";
import { createUsageSettlementProductionComposition } from "./usage-settlement-composition.js";
import { readBoundedPrivateFile, readBoundedRegularFile } from "./secret-files.js";

export type ModelGatewayRequestListener = (
  request: Http2ServerRequest,
  response: Http2ServerResponse,
) => void;

export interface ModelGatewayProductionComposition {
  readonly handler: ModelGatewayRequestListener;
  createServer(listener: ModelGatewayRequestListener): Http2SecureServer;
  startBackground(): void;
  abortInFlight(reason: string): void;
  shutdownProviderEffects(deadlineMs: number): Promise<void>;
  activeProviderEffectCount(): number;
  inFlightCount(): number;
}

interface Peer {
  readonly fingerprint256: string;
  readonly sanUri: string;
  readonly identity: string;
}

export async function createModelGatewayProductionComposition(input: Readonly<{
  database: PostgresModelGatewayDatabase;
  environment?: Readonly<Record<string, string | undefined>>;
}>): Promise<ModelGatewayProductionComposition> {
  const environment = input.environment ?? process.env;
  assertImageEffectProductionReadiness(environment);
  const [tls, peers, responseKeyRingText] = await Promise.all([
    loadTls(environment),
    loadPeers(required(environment, "PLATFORM_MODEL_GATEWAY_MTLS_PEERS_FILE")),
    readBoundedPrivateFile(
      required(environment, "PLATFORM_MODEL_GATEWAY_RESPONSE_KEY_RING_FILE"),
      256 * 1024,
      "PLATFORM_MODEL_GATEWAY_RESPONSE_KEY_RING_FILE_INVALID",
    ),
  ]);
  const agentCallerIdentity = required(environment, "PLATFORM_MODEL_GATEWAY_AGENT_CALLER_SAN_URI");
  if (!peers.some((peer) => peer.identity === agentCallerIdentity)) {
    throw new Error("PLATFORM_MODEL_GATEWAY_AGENT_CALLER_NOT_REGISTERED");
  }
  const responseProtector = createModelGatewayResponseProtector(parseResponseKeyRing(responseKeyRingText));
  const repository = new PostgresModelGatewayRepository({ responseProtector });
  const usageOwner = createUsageSettlementProductionComposition().owner;
  const providerTimeoutMs = boundedInteger(
    environment.PLATFORM_MODEL_GATEWAY_PROVIDER_TIMEOUT_MS ?? "30000",
    100,
    120_000,
    "PLATFORM_MODEL_GATEWAY_PROVIDER_TIMEOUT_MS_INVALID",
  );
  const provider = await loadModelGatewayProviderRouter(environment, providerTimeoutMs);
  const application = new ModelGatewayService({
    unitOfWork: input.database,
    repository,
    streamingRepository: repository,
    provider,
    usageOwner,
    dispatchRecoveryAfterMs: Math.max(60_000, providerTimeoutMs * 2),
    providerHardTimeoutMs: Math.max(60_000, providerTimeoutMs),
    maximumActive: boundedInteger(
      environment.PLATFORM_MODEL_GATEWAY_MAXIMUM_ACTIVE ?? "64", 1, 10_000,
      "PLATFORM_MODEL_GATEWAY_MAXIMUM_ACTIVE_INVALID",
    ),
    maximumQueued: boundedInteger(
      environment.PLATFORM_MODEL_GATEWAY_MAXIMUM_QUEUED ?? "256", 1, 100_000,
      "PLATFORM_MODEL_GATEWAY_MAXIMUM_QUEUED_INVALID",
    ),
    frameWaiter: input.database,
  });
  const callers = new AsyncLocalStorage<Peer>();
  const service = createModelGatewayConnectService({
    application,
    agentCallerIdentity,
    ...(environment.KOKORO_COMPAT_DEBUG === "1"
      ? { onError: (error: unknown) => {
          console.error(`Model Gateway application error:${stableErrorCode(error)}`);
        } }
      : {}),
    caller: {
      resolve: () => {
        const caller = callers.getStore();
        if (caller === undefined) throw new Error("MODEL_GATEWAY_VERIFIED_CALLER_REQUIRED");
        return caller;
      },
    },
  });
  const connect = connectNodeAdapter({
    routes: (router) => router.service(ModelGatewayConnectDefinition, service),
    connect: true,
    grpc: false,
    grpcWeb: false,
    acceptCompression: [compressionGzip],
    readMaxBytes: 3 * 1024 * 1024,
    writeMaxBytes: 9 * 1024 * 1024,
    maxTimeoutMs: 120_000,
  });
  const inFlight = new Set<Http2ServerResponse>();
  const handler: ModelGatewayRequestListener = (request, response) => {
    const peer = authenticate(request, peers);
    if (peer === null) {
      response.statusCode = 401;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end("unauthorized");
      return;
    }
    inFlight.add(response);
    callers.run(peer, () => {
      Promise.resolve(connect(request, response)).catch(() => {
        if (!response.headersSent) {
          response.statusCode = 503;
          response.setHeader("content-type", "text/plain; charset=utf-8");
          response.end("unavailable");
        } else {
          response.destroy();
        }
      }).finally(() => inFlight.delete(response));
    });
  };
  return Object.freeze({
    handler,
    createServer: (listener: ModelGatewayRequestListener) => createSecureServer(tls, listener),
    startBackground: () => application.start(),
    abortInFlight: (reason: string) => {
      for (const response of inFlight) response.destroy(new Error(reason));
    },
    shutdownProviderEffects: (deadlineMs: number) => application.shutdown(deadlineMs),
    activeProviderEffectCount: () => application.activeDispatchCount(),
    inFlightCount: () => inFlight.size,
  });
}

type PrivateFileReader = (path: string, maximumBytes: number, code: string) => Promise<string>;

export async function loadModelGatewayProviderRouter(
  environment: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
  readPrivate: PrivateFileReader = readBoundedPrivateFile,
): Promise<ModelGatewayProviderRouter> {
  const directEndpoint = environment.PLATFORM_MODEL_GATEWAY_DIRECT_ENDPOINT;
  const directKeyFile = environment.PLATFORM_MODEL_GATEWAY_DIRECT_API_KEY_FILE;
  const directConfigured = completeAdapterConfiguration(
    [directEndpoint, directKeyFile],
    "PLATFORM_MODEL_GATEWAY_DIRECT_CONFIG_INVALID",
  );
  if (!directConfigured || directEndpoint === undefined || directKeyFile === undefined) {
    throw new Error("PLATFORM_MODEL_GATEWAY_DIRECT_CONFIG_REQUIRED");
  }
  const litellmEndpoint = environment.PLATFORM_MODEL_GATEWAY_LITELLM_ENDPOINT;
  const litellmKeyFile = environment.PLATFORM_MODEL_GATEWAY_LITELLM_API_KEY_FILE;
  const litellmConfigured = completeAdapterConfiguration(
    [litellmEndpoint, litellmKeyFile],
    "PLATFORM_MODEL_GATEWAY_LITELLM_CONFIG_INVALID",
  );

  const adapters: {
    litellm?: LiteLlmChatAdapter;
    direct: DirectOpenAiChatAdapter;
  } = {
    direct: new DirectOpenAiChatAdapter({
      endpoint: directEndpoint,
      apiKey: secretLine(
        await readPrivate(directKeyFile, 8 * 1024,
          "PLATFORM_MODEL_GATEWAY_DIRECT_API_KEY_FILE_INVALID"),
        "PLATFORM_MODEL_GATEWAY_DIRECT_API_KEY_FILE_INVALID",
      ),
      timeoutMs,
    }),
  };
  if (litellmConfigured) {
    if (litellmEndpoint === undefined || litellmKeyFile === undefined) {
      throw new Error("PLATFORM_MODEL_GATEWAY_LITELLM_CONFIG_INVALID");
    }
    const key = await readPrivate(litellmKeyFile, 8 * 1024,
      "PLATFORM_MODEL_GATEWAY_LITELLM_API_KEY_FILE_INVALID");
    adapters.litellm = new LiteLlmChatAdapter({
      endpoint: litellmEndpoint,
      apiKey: secretLine(key, "PLATFORM_MODEL_GATEWAY_LITELLM_API_KEY_FILE_INVALID"),
      timeoutMs,
    });
  }
  return new ModelGatewayProviderRouter(adapters);
}

function completeAdapterConfiguration(
  values: readonly (string | undefined)[],
  code: string,
): boolean {
  if (values.every((value) => value === undefined)) return false;
  if (values.some((value) => value === undefined || value.length < 1 || value.trim() !== value)) {
    throw new Error(code);
  }
  return true;
}

function stableErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const stableCode = message.match(/\b[A-Z][A-Z0-9_]{2,127}\b/u)?.[0];
  if (stableCode !== undefined) return stableCode;
  const driverCode = typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" && /^[A-Za-z0-9_]{1,32}$/u.test(error.code)
    ? error.code
    : null;
  if (driverCode !== null) return driverCode;
  const bounded = message.replace(/[A-Za-z0-9_-]{24,}/gu, "[redacted]")
    .replace(/[^A-Za-z0-9_ .:'\-[\]]/gu, "?").slice(0, 256);
  return bounded.length > 0 ? bounded : "UNKNOWN_ERROR";
}

export function assertImageEffectProductionReadiness(
  environment: Readonly<Record<string, string | undefined>>,
): void {
  const enabled = environment.PLATFORM_MODEL_IMAGE_EFFECT_ENABLED ?? "false";
  if (enabled !== "true" && enabled !== "false") {
    throw new Error("PLATFORM_MODEL_IMAGE_EFFECT_ENABLED_INVALID");
  }
  if (enabled === "true") {
    // The pinned Root effect helper/evidence surface, signed budget materializer, dedicated
    // output-access owner and certified Provider protocol must all be composed together. Starting a partial surface would
    // turn bearer hashes/DB rows into false authorization, so production remains deliberately closed.
    throw new Error("PLATFORM_MODEL_IMAGE_EFFECT_ACTIVATION_INCOMPLETE");
  }
}

function authenticate(request: Http2ServerRequest, peers: readonly Peer[]): Peer | null {
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
  try {
    value = JSON.parse(await readBoundedRegularFile(
      path,
      256 * 1024,
      "PLATFORM_MODEL_GATEWAY_MTLS_PEERS_FILE_INVALID",
    ));
  } catch {
    throw new Error("PLATFORM_MODEL_GATEWAY_MTLS_PEERS_FILE_INVALID");
  }
  if (!object(value) || value.version !== 1 || !Array.isArray(value.peers) ||
      Object.keys(value).sort().join(",") !== "peers,version") {
    throw new Error("PLATFORM_MODEL_GATEWAY_MTLS_PEERS_FILE_INVALID");
  }
  const seenSans = new Set<string>();
  const seenFingerprints = new Set<string>();
  const peers = value.peers.map((raw): Peer => {
    if (!object(raw) || Object.keys(raw).sort().join(",") !== "fingerprint256,sanUri" ||
        typeof raw.fingerprint256 !== "string" ||
        !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u.test(raw.fingerprint256) ||
        typeof raw.sanUri !== "string" || !raw.sanUri.startsWith("spiffe://") ||
        seenSans.has(raw.sanUri) || seenFingerprints.has(raw.fingerprint256)) {
      throw new Error("PLATFORM_MODEL_GATEWAY_MTLS_PEERS_FILE_INVALID");
    }
    seenSans.add(raw.sanUri);
    seenFingerprints.add(raw.fingerprint256);
    return Object.freeze({
      fingerprint256: raw.fingerprint256,
      sanUri: raw.sanUri,
      identity: raw.sanUri,
    });
  });
  if (peers.length < 1 || peers.length > 32) {
    throw new Error("PLATFORM_MODEL_GATEWAY_MTLS_PEERS_FILE_INVALID");
  }
  return Object.freeze(peers);
}

async function loadTls(environment: Readonly<Record<string, string | undefined>>): Promise<SecureServerOptions> {
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
  return Object.freeze({
    key,
    cert,
    ca,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: "TLSv1.3",
    allowHTTP1: false,
  });
}

function parseResponseKeyRing(value: string): Readonly<{
  currentKeyRevision: string;
  keys: readonly Readonly<{ keyRevision: string; key: Uint8Array }>[];
}> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch {
    throw new Error("PLATFORM_MODEL_GATEWAY_RESPONSE_KEY_RING_FILE_INVALID");
  }
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
