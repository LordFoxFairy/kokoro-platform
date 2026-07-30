import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, open } from "node:fs/promises";
import type { SecureServerOptions } from "node:http2";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CapabilityCatalogPublicationService } from
  "../../application/capability-catalog-publication-service.js";
import { CapabilityProjectionWorker } from "../../application/capability-projection-worker.js";
import { McpSecretService } from "../../application/mcp-secret-service.js";
import { createEd25519CapabilityCatalogSigner } from "../../domain/capability-catalog.js";
import { loadSecretKeyring } from "../../config/secret-keyring.js";
import { loadHubEnv } from "../../config/env.js";
import { AesGcmSecretCipher } from "../../infrastructure/crypto/aes-gcm-secret-cipher.js";
import { createPlatformCapabilityProjectionClient } from
  "../../infrastructure/connect/platform-capability-projection-client.js";
import { MongoCapabilityCatalogAuthority } from
  "../../infrastructure/mongo/mongo-capability-catalog-authority.js";
import { MongoCapabilityPublicationRepository } from
  "../../infrastructure/mongo/mongo-capability-publication-repository.js";
import { createMongoClient, hubCollections } from "../../infrastructure/mongo/mongo-client.js";
import { MongoMcpSecretRepository } from "../../infrastructure/mongo/mongo-mcp-secret-repository.js";
import {
  createHubCatalogConnectService,
  createHubRuntimeConnectService,
} from "./capability-catalog-services.js";
import { createHubConnectRuntime, type HubConnectCaller } from "./hub-connect-runtime.js";

export async function runHubConnectMain(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const port = boundedPort(environment.KOKORO_HUB_CONNECT_PORT ?? "4252");
  const mongoUrl = required(environment, "KOKORO_HUB_MONGO_URL");
  const mongoDatabase = required(environment, "KOKORO_HUB_MONGO_DB");
  const platformIdentity = required(environment, "KOKORO_HUB_CATALOG_PLATFORM_CALLER_SAN_URI");
  const agentIdentity = required(environment, "KOKORO_HUB_RUNTIME_AGENT_CALLER_SAN_URI");
  if (platformIdentity === agentIdentity) throw new Error("HUB_CONNECT_CALLER_IDENTITIES_NOT_DISTINCT");
  const [tls, peers, signingKey, projectionTls] = await Promise.all([
    loadTls(environment),
    loadPeers(required(environment, "KOKORO_HUB_CONNECT_MTLS_PEERS_FILE")),
    readBounded(required(environment, "KOKORO_HUB_CAPABILITY_SIGNING_KEY_FILE"), 64 * 1024, true),
    loadProjectionTls(environment),
  ]);
  if (!peers.some(({ identity }) => identity === platformIdentity) ||
      !peers.some(({ identity }) => identity === agentIdentity)) {
    throw new Error("HUB_CONNECT_REQUIRED_CALLER_NOT_REGISTERED");
  }
  const secretKeyring = loadSecretKeyring(loadHubEnv({ ...environment }));
  if (secretKeyring === null) throw new Error("HUB_CONNECT_SECRET_KEYRING_REQUIRED");

  const mongo = createMongoClient(mongoUrl);
  await mongo.connect();
  const collections = hubCollections(mongo.db(mongoDatabase));
  const repository = new MongoCapabilityPublicationRepository(collections);
  const publication = new CapabilityCatalogPublicationService({
    repository,
    authority: new MongoCapabilityCatalogAuthority(collections),
    signer: createEd25519CapabilityCatalogSigner({
      signingKeyRef: required(environment, "KOKORO_HUB_CAPABILITY_SIGNING_KEY_REF"),
      privateKeyPem: signingKey,
    }),
  });
  const secrets = new McpSecretService(
    new MongoMcpSecretRepository(collections),
    new AesGcmSecretCipher(secretKeyring),
  );
  const callers = new AsyncLocalStorage<HubConnectCaller>();
  let draining = false;
  const caller = { resolve: () => {
    const current = callers.getStore();
    if (current === undefined) throw new Error("HUB_CONNECT_CALLER_CONTEXT_REQUIRED");
    return current;
  } };
  const runtime = createHubConnectRuntime({
    tls,
    peers,
    callers,
    catalog: createHubCatalogConnectService({ publication, caller, platformCallerIdentity: platformIdentity }),
    runtime: createHubRuntimeConnectService({ secrets, caller, agentCallerIdentity: agentIdentity }),
    ready: async () => {
      await mongo.db(mongoDatabase).command({ ping: 1 });
      return true;
    },
    isDraining: () => draining,
  });
  const worker = new CapabilityProjectionWorker({
    repository,
    client: createPlatformCapabilityProjectionClient({
      baseUrl: required(environment, "KOKORO_HUB_PLATFORM_PROJECTION_BASE_URL"),
      serverName: required(environment, "KOKORO_HUB_PLATFORM_PROJECTION_SERVER_NAME"),
      ...projectionTls,
    }),
  });
  const workerController = new AbortController();
  let workerTimer: ReturnType<typeof setTimeout> | undefined;
  let activeTick: Promise<unknown> | undefined;
  const schedule = () => {
    if (workerController.signal.aborted) return;
    workerTimer = setTimeout(() => {
      activeTick = worker.tick(workerController.signal).catch(() => undefined).finally(() => {
        activeTick = undefined;
        schedule();
      });
    }, 250);
    workerTimer.unref();
  };
  schedule();

  const server = runtime.createServer();
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    draining = true;
    workerController.abort(new Error("HUB_SHUTDOWN"));
    if (workerTimer !== undefined) clearTimeout(workerTimer);
    await new Promise<void>((finish) => server.close(() => finish())).catch(() => undefined);
    await activeTick?.catch(() => undefined);
    await mongo.close();
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
  await new Promise<void>((ready, failed) => {
    server.once("error", failed);
    server.listen(port, "0.0.0.0", () => { server.off("error", failed); ready(); });
  });
  console.log(`kokoro-hub Connect listening on ${port}`);
}

async function loadTls(environment: Readonly<Record<string, string | undefined>>): Promise<SecureServerOptions> {
  const [key, cert, ca] = await Promise.all([
    readBounded(required(environment, "KOKORO_HUB_CONNECT_TLS_KEY_FILE"), 64 * 1024, true),
    readBounded(required(environment, "KOKORO_HUB_CONNECT_TLS_CERT_FILE"), 64 * 1024, false),
    readBounded(required(environment, "KOKORO_HUB_CONNECT_TLS_CLIENT_CA_FILE"), 256 * 1024, false),
  ]);
  if (!key.includes("PRIVATE KEY") || !cert.includes("BEGIN CERTIFICATE") || !ca.includes("BEGIN CERTIFICATE")) {
    throw new Error("HUB_CONNECT_TLS_MATERIAL_INVALID");
  }
  return Object.freeze({ key, cert, ca, requestCert: true, rejectUnauthorized: true,
    allowHTTP1: false, minVersion: "TLSv1.3" });
}

async function loadProjectionTls(environment: Readonly<Record<string, string | undefined>>) {
  const [privateKeyPem, certificatePem, certificateAuthorityPem] = await Promise.all([
    readBounded(required(environment, "KOKORO_HUB_PLATFORM_PROJECTION_CLIENT_KEY_FILE"), 64 * 1024, true),
    readBounded(required(environment, "KOKORO_HUB_PLATFORM_PROJECTION_CLIENT_CERT_FILE"), 64 * 1024, false),
    readBounded(required(environment, "KOKORO_HUB_PLATFORM_PROJECTION_SERVER_CA_FILE"), 256 * 1024, false),
  ]);
  return { privateKeyPem, certificatePem, certificateAuthorityPem };
}

async function loadPeers(path: string) {
  let value: unknown;
  try { value = JSON.parse(await readBounded(path, 256 * 1024, false)); } catch {
    throw new Error("HUB_CONNECT_PEERS_INVALID");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("HUB_CONNECT_PEERS_INVALID");
  }
  const root = value as Record<string, unknown>;
  if (root.version !== 1 || !Array.isArray(root.peers) ||
      Object.keys(root).sort().join(",") !== "peers,version") throw new Error("HUB_CONNECT_PEERS_INVALID");
  const identities = new Set<string>();
  return Object.freeze(root.peers.map((raw) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("HUB_CONNECT_PEERS_INVALID");
    }
    const peer = raw as Record<string, unknown>;
    if (Object.keys(peer).sort().join(",") !== "fingerprint256,sanUri" ||
        typeof peer.fingerprint256 !== "string" ||
        !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u.test(peer.fingerprint256) ||
        typeof peer.sanUri !== "string" || !peer.sanUri.startsWith("spiffe://") ||
        identities.has(peer.sanUri)) throw new Error("HUB_CONNECT_PEERS_INVALID");
    identities.add(peer.sanUri);
    return Object.freeze({ identity: peer.sanUri, sanUri: peer.sanUri, fingerprint256: peer.fingerprint256 });
  }));
}

async function readBounded(path: string, maximumBytes: number, privateFile: boolean): Promise<string> {
  const before = await lstat(path);
  if (before.isSymbolicLink()) throw new Error("HUB_CONNECT_TRUST_FILE_INVALID");
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.dev !== before.dev || metadata.ino !== before.ino ||
        metadata.size < 1 || metadata.size > maximumBytes ||
        (privateFile && (metadata.mode & 0o077) !== 0)) throw new Error("HUB_CONNECT_TRUST_FILE_INVALID");
    const value = await handle.readFile();
    if (value.byteLength !== metadata.size || value.byteLength > maximumBytes) {
      throw new Error("HUB_CONNECT_TRUST_FILE_INVALID");
    }
    return value.toString("utf8");
  } finally {
    await handle.close();
  }
}

function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
function boundedPort(value: string): number {
  if (!/^[1-9][0-9]{0,4}$/u.test(value)) throw new Error("KOKORO_HUB_CONNECT_PORT_INVALID");
  const parsed = Number(value);
  if (parsed > 65_535) throw new Error("KOKORO_HUB_CONNECT_PORT_INVALID");
  return parsed;
}
function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}
if (isMain()) {
  await runHubConnectMain().catch((error: unknown) => {
    process.exitCode = 1;
    console.error("kokoro-hub Connect failed", error);
  });
}
