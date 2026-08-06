import { AsyncLocalStorage } from "node:async_hooks";
import type { SecureServerOptions } from "node:http2";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AesGcmSecretCipher,
  CapabilityCatalogPublicationService,
  CapabilityProjectionWorker,
  createEd25519CapabilityCatalogSigner,
  createHubConnectHealthServer,
  createHubConnectProcess,
  createMongoClient,
  ExecutionAssemblyService,
  hubCollections,
  loadHubEnv,
  loadHubStoreLocation,
  loadSecretKeyring,
  makePackageStore,
  McpHubService,
  McpSecretService,
  MongoCapabilityCatalogAuthority,
  MongoCapabilityPublicationRepository,
  MongoMcpSecretRepository,
  MongoMcpServerRepository,
  MongoSkillRepository,
  readBoundedHubConnectFile,
  type HubConnectProcess,
} from "@kokoro/hub";
import { createPlatformCapabilityProjectionClient } from
  "../modules/hub/infrastructure/connect/platform-capability-projection-client.js";
import {
  createHubCatalogConnectService,
  createHubRuntimeConnectService,
} from "../modules/hub/interfaces/connect/capability-catalog-services.js";
import { createHubConnectRuntime, type HubConnectCaller } from
  "../modules/hub/interfaces/connect/hub-connect-runtime.js";

export { readBoundedHubConnectFile } from "@kokoro/hub";

export const HUB_CONNECT_PRODUCTION_REQUIRED_ENVIRONMENT = Object.freeze([
  "KOKORO_HUB_CONNECT_PORT",
  "KOKORO_HUB_CONNECT_HEALTH_PORT",
  "KOKORO_HUB_MONGO_URL",
  "KOKORO_HUB_MONGO_DB",
  "KOKORO_WORKSPACE_CONFIG",
  "KOKORO_WORKSPACE_S3_ACCESS_KEY",
  "KOKORO_WORKSPACE_S3_SECRET_KEY",
  "KOKORO_HUB_SECRET_MASTER_KEY",
  "KOKORO_HUB_CONNECT_TRUST_ROOT",
  "KOKORO_HUB_CONNECT_TLS_KEY_FILE",
  "KOKORO_HUB_CONNECT_TLS_CERT_FILE",
  "KOKORO_HUB_CONNECT_TLS_CLIENT_CA_FILE",
  "KOKORO_HUB_CONNECT_MTLS_PEERS_FILE",
  "KOKORO_HUB_CATALOG_PLATFORM_CALLER_SAN_URI",
  "KOKORO_HUB_RUNTIME_AGENT_CALLER_SAN_URI",
  "KOKORO_HUB_CAPABILITY_SIGNING_KEY_REF",
  "KOKORO_HUB_CAPABILITY_SIGNING_TRUST_ROOT",
  "KOKORO_HUB_CAPABILITY_SIGNING_KEY_FILE",
  "KOKORO_HUB_PLATFORM_PROJECTION_BASE_URL",
  "KOKORO_HUB_PLATFORM_PROJECTION_SERVER_NAME",
  "KOKORO_HUB_PLATFORM_PROJECTION_TRUST_ROOT",
  "KOKORO_HUB_PLATFORM_PROJECTION_CLIENT_KEY_FILE",
  "KOKORO_HUB_PLATFORM_PROJECTION_CLIENT_CERT_FILE",
  "KOKORO_HUB_PLATFORM_PROJECTION_SERVER_CA_FILE",
] as const);

export interface HubConnectStartupConfig {
  readonly port: number;
  readonly healthPort: number;
  readonly mongoUrl: string;
  readonly mongoDatabase: string;
  readonly platformIdentity: string;
  readonly agentIdentity: string;
  readonly trustRoot: string;
  readonly signingTrustRoot: string;
  readonly projectionTrustRoot: string;
  readonly peersFile: string;
  readonly signingKeyFile: string;
}

interface HubConnectMongoClient {
  connect(): Promise<unknown>;
  close(): Promise<unknown>;
  db(name: string): unknown;
}

export function loadHubConnectStartupConfig(
  environment: Readonly<Record<string, string | undefined>>,
): HubConnectStartupConfig {
  if (environment.NODE_ENV === "production") {
    for (const name of HUB_CONNECT_PRODUCTION_REQUIRED_ENVIRONMENT) required(environment, name);
  }
  const port = boundedPort(
    environment.KOKORO_HUB_CONNECT_PORT ?? "4252",
    "KOKORO_HUB_CONNECT_PORT",
  );
  const healthPort = boundedPort(
    environment.KOKORO_HUB_CONNECT_HEALTH_PORT ?? "4253",
    "KOKORO_HUB_CONNECT_HEALTH_PORT",
  );
  if (port === healthPort) throw new Error("HUB_CONNECT_PORTS_NOT_DISTINCT");
  const platformIdentity = required(environment, "KOKORO_HUB_CATALOG_PLATFORM_CALLER_SAN_URI");
  const agentIdentity = required(environment, "KOKORO_HUB_RUNTIME_AGENT_CALLER_SAN_URI");
  if (platformIdentity === agentIdentity)
    throw new Error("HUB_CONNECT_CALLER_IDENTITIES_NOT_DISTINCT");
  return Object.freeze({
    port,
    healthPort,
    mongoUrl: required(environment, "KOKORO_HUB_MONGO_URL"),
    mongoDatabase: required(environment, "KOKORO_HUB_MONGO_DB"),
    platformIdentity,
    agentIdentity,
    trustRoot: required(environment, "KOKORO_HUB_CONNECT_TRUST_ROOT"),
    signingTrustRoot: required(environment, "KOKORO_HUB_CAPABILITY_SIGNING_TRUST_ROOT"),
    projectionTrustRoot: required(environment, "KOKORO_HUB_PLATFORM_PROJECTION_TRUST_ROOT"),
    peersFile: required(environment, "KOKORO_HUB_CONNECT_MTLS_PEERS_FILE"),
    signingKeyFile: required(environment, "KOKORO_HUB_CAPABILITY_SIGNING_KEY_FILE"),
  });
}

export async function runHubConnectMain(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: Readonly<{
    createMongoClient?: (url: string) => HubConnectMongoClient;
  }> = {},
): Promise<void> {
  const config = loadHubConnectStartupConfig(environment);
  const hubEnv = loadHubEnv({ ...environment });
  const secretKeyring = loadSecretKeyring(hubEnv);
  if (secretKeyring === null) throw new Error("HUB_CONNECT_SECRET_KEYRING_REQUIRED");
  const hubStoreLocation = loadHubStoreLocation(hubEnv.KOKORO_WORKSPACE_CONFIG);
  if (hubStoreLocation === null) throw new Error("HUB_CONNECT_PACKAGE_STORE_REQUIRED");
  const packages = makePackageStore(
    hubStoreLocation,
    hubEnv.KOKORO_WORKSPACE_S3_ACCESS_KEY !== undefined &&
      hubEnv.KOKORO_WORKSPACE_S3_SECRET_KEY !== undefined
      ? {
          accessKeyId: hubEnv.KOKORO_WORKSPACE_S3_ACCESS_KEY,
          secretAccessKey: hubEnv.KOKORO_WORKSPACE_S3_SECRET_KEY,
        }
      : null,
  );
  const [tls, peers, signingKey, projectionTls] = await Promise.all([
    loadTls(environment, config.trustRoot),
    loadPeers(config.peersFile, config.trustRoot),
    readBoundedHubConnectFile(config.signingKeyFile, config.signingTrustRoot, 64 * 1024, true),
    loadProjectionTls(environment, config.projectionTrustRoot),
  ]);
  if (
    !peers.some(({ identity }) => identity === config.platformIdentity) ||
    !peers.some(({ identity }) => identity === config.agentIdentity)
  ) {
    throw new Error("HUB_CONNECT_REQUIRED_CALLER_NOT_REGISTERED");
  }

  const mongo = (dependencies.createMongoClient ?? createMongoClient)(config.mongoUrl);
  let mongoClose: Promise<void> | undefined;
  const closeMongo = () => {
    mongoClose ??= mongo.close().then(() => undefined);
    return mongoClose;
  };
  let lifecycle: HubConnectProcess | undefined;
  let signalShutdown: (() => void) | undefined;
  try {
    await mongo.connect();
    const collections = hubCollections(
      mongo.db(config.mongoDatabase) as Parameters<typeof hubCollections>[0],
    );
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
    const assembly = new ExecutionAssemblyService({
      publications: repository,
      skills: new MongoSkillRepository(collections),
      mcp: new McpHubService(new MongoMcpServerRepository(collections)),
      secrets,
      packages,
    });
    const callers = new AsyncLocalStorage<HubConnectCaller>();
    const caller = {
      resolve: () => {
        const current = callers.getStore();
        if (current === undefined) throw new Error("HUB_CONNECT_CALLER_CONTEXT_REQUIRED");
        return current;
      },
    };
    const runtime = createHubConnectRuntime({
      tls,
      peers,
      callers,
      catalog: createHubCatalogConnectService({
        publication,
        caller,
        platformCallerIdentity: config.platformIdentity,
      }),
      runtime: createHubRuntimeConnectService({
        assembly,
        caller,
        agentCallerIdentity: config.agentIdentity,
      }),
      ready,
      isDraining: () => lifecycle?.isDraining() ?? false,
    });
    const worker = new CapabilityProjectionWorker({
      repository,
      client: createPlatformCapabilityProjectionClient({
        baseUrl: required(environment, "KOKORO_HUB_PLATFORM_PROJECTION_BASE_URL"),
        serverName: required(environment, "KOKORO_HUB_PLATFORM_PROJECTION_SERVER_NAME"),
        ...projectionTls,
      }),
    });
    const server = runtime.createServer();
    const healthServer = createHubConnectHealthServer({
      ready,
      isDraining: () => lifecycle?.isDraining() ?? false,
    });
    lifecycle = createHubConnectProcess({
      server,
      healthServer,
      worker,
      closeMongo,
      port: config.port,
      healthPort: config.healthPort,
      onFatal: (error) => {
        process.exitCode = 1;
        console.error("kokoro-hub Connect runtime failure", error);
      },
    });
    signalShutdown = () => {
      if (signalShutdown !== undefined) {
        process.off("SIGINT", signalShutdown);
        process.off("SIGTERM", signalShutdown);
      }
      void lifecycle?.shutdown().catch((error: unknown) => {
        process.exitCode = 1;
        console.error("kokoro-hub Connect failed to drain", error);
      });
    };
    process.once("SIGINT", signalShutdown);
    process.once("SIGTERM", signalShutdown);
    await lifecycle.start();
  } catch (error) {
    if (signalShutdown !== undefined) {
      process.off("SIGINT", signalShutdown);
      process.off("SIGTERM", signalShutdown);
    }
    if (lifecycle === undefined) await closeMongo().catch(() => undefined);
    else await lifecycle.shutdown().catch(() => undefined);
    throw error;
  }
  console.log(`kokoro-hub Connect listening on ${config.port}; health on ${config.healthPort}`);

  async function ready(): Promise<boolean> {
    await (mongo.db(config.mongoDatabase) as Parameters<typeof hubCollections>[0])
      .command({ ping: 1 });
    return true;
  }
}

async function loadTls(
  environment: Readonly<Record<string, string | undefined>>,
  trustRoot: string,
): Promise<SecureServerOptions> {
  const [key, cert, ca] = await Promise.all([
    readBoundedHubConnectFile(
      required(environment, "KOKORO_HUB_CONNECT_TLS_KEY_FILE"),
      trustRoot,
      64 * 1024,
      true,
    ),
    readBoundedHubConnectFile(
      required(environment, "KOKORO_HUB_CONNECT_TLS_CERT_FILE"),
      trustRoot,
      64 * 1024,
      false,
    ),
    readBoundedHubConnectFile(
      required(environment, "KOKORO_HUB_CONNECT_TLS_CLIENT_CA_FILE"),
      trustRoot,
      256 * 1024,
      false,
    ),
  ]);
  if (
    !key.includes("PRIVATE KEY") ||
    !cert.includes("BEGIN CERTIFICATE") ||
    !ca.includes("BEGIN CERTIFICATE")
  ) {
    throw new Error("HUB_CONNECT_TLS_MATERIAL_INVALID");
  }
  return Object.freeze({
    key,
    cert,
    ca,
    requestCert: true,
    rejectUnauthorized: true,
    allowHTTP1: false,
    minVersion: "TLSv1.3",
  });
}

async function loadProjectionTls(
  environment: Readonly<Record<string, string | undefined>>,
  trustRoot: string,
) {
  const [privateKeyPem, certificatePem, certificateAuthorityPem] = await Promise.all([
    readBoundedHubConnectFile(
      required(environment, "KOKORO_HUB_PLATFORM_PROJECTION_CLIENT_KEY_FILE"),
      trustRoot,
      64 * 1024,
      true,
    ),
    readBoundedHubConnectFile(
      required(environment, "KOKORO_HUB_PLATFORM_PROJECTION_CLIENT_CERT_FILE"),
      trustRoot,
      64 * 1024,
      false,
    ),
    readBoundedHubConnectFile(
      required(environment, "KOKORO_HUB_PLATFORM_PROJECTION_SERVER_CA_FILE"),
      trustRoot,
      256 * 1024,
      false,
    ),
  ]);
  return { privateKeyPem, certificatePem, certificateAuthorityPem };
}

async function loadPeers(path: string, trustRoot: string) {
  let value: unknown;
  try {
    value = JSON.parse(await readBoundedHubConnectFile(path, trustRoot, 256 * 1024, false));
  } catch {
    throw new Error("HUB_CONNECT_PEERS_INVALID");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("HUB_CONNECT_PEERS_INVALID");
  }
  const root = value as Record<string, unknown>;
  if (
    root.version !== 1 ||
    !Array.isArray(root.peers) ||
    Object.keys(root).sort().join(",") !== "peers,version"
  )
    throw new Error("HUB_CONNECT_PEERS_INVALID");
  const identities = new Set<string>();
  return Object.freeze(
    root.peers.map((raw) => {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("HUB_CONNECT_PEERS_INVALID");
      }
      const peer = raw as Record<string, unknown>;
      if (
        Object.keys(peer).sort().join(",") !== "fingerprint256,sanUri" ||
        typeof peer.fingerprint256 !== "string" ||
        !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u.test(peer.fingerprint256) ||
        typeof peer.sanUri !== "string" ||
        !peer.sanUri.startsWith("spiffe://") ||
        identities.has(peer.sanUri)
      )
        throw new Error("HUB_CONNECT_PEERS_INVALID");
      identities.add(peer.sanUri);
      return Object.freeze({
        identity: peer.sanUri,
        sanUri: peer.sanUri,
        fingerprint256: peer.fingerprint256,
      });
    }),
  );
}

function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
function boundedPort(value: string, name: string): number {
  if (!/^[1-9][0-9]{0,4}$/u.test(value)) throw new Error(`${name}_INVALID`);
  const parsed = Number(value);
  if (parsed > 65_535) throw new Error(`${name}_INVALID`);
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
