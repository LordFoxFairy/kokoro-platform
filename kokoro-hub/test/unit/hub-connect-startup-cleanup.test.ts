import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runHubConnectMain } from "../../../src/process/hub-connect.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Hub Connect startup cleanup", () => {
  it.each([
    { name: "invalid Ed25519 signing material", signingKey: invalidPrivateKey(), peers: 2,
      projectionBaseUrl: "https://platform-admission.internal:4244" },
    { name: "an oversized peer registry", signingKey: validPrivateKey(), peers: 17,
      projectionBaseUrl: "https://platform-admission.internal:4244" },
    { name: "an invalid projection URL", signingKey: validPrivateKey(), peers: 2,
      projectionBaseUrl: "http://platform-admission.internal:4244" },
  ])("closes Mongo when assembly rejects $name", async ({ signingKey, peers, projectionBaseUrl }) => {
    const environment = await startupEnvironment({ signingKey, peers, projectionBaseUrl });
    const close = vi.fn().mockResolvedValue(undefined);
    const mongo = {
      connect: vi.fn().mockResolvedValue(undefined),
      close,
      db: vi.fn().mockReturnValue({
        collection: vi.fn().mockReturnValue({}),
        command: vi.fn().mockResolvedValue({ ok: 1 }),
      }),
    };
    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");

    await expect(
      runHubConnectMain(environment, { createMongoClient: () => mongo }),
    ).rejects.toBeDefined();

    expect(mongo.connect).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
  });
});

async function startupEnvironment(input: Readonly<{
  signingKey: string;
  peers: number;
  projectionBaseUrl: string;
}>): Promise<Record<string, string>> {
  const directory = await mkdtemp(resolve(tmpdir(), "hub-connect-startup-"));
  temporaryDirectories.push(directory);
  const trustRoot = resolve(directory, "secrets");
  const signingTrustRoot = resolve(directory, "capability-signing");
  const projectionTrustRoot = resolve(directory, "platform-projection");
  const packages = resolve(directory, "packages");
  await Promise.all([
    mkdir(trustRoot),
    mkdir(signingTrustRoot),
    mkdir(projectionTrustRoot),
    mkdir(packages),
  ]);
  const storage = resolve(directory, "storage.yaml");
  await writeFile(
    storage,
    `workspace:\n  type: local\n  root: ${packages}\nhub:\n  type: local\n  root: ${packages}\n`,
  );
  const privateKey = "-----BEGIN PRIVATE KEY-----\nTLS\n-----END PRIVATE KEY-----\n";
  const certificate = "-----BEGIN CERTIFICATE-----\nTLS\n-----END CERTIFICATE-----\n";
  const paths = {
    serverKey: resolve(trustRoot, "server.key"),
    serverCertificate: resolve(trustRoot, "server.crt"),
    clientCa: resolve(trustRoot, "client-ca.crt"),
    peers: resolve(trustRoot, "peers.json"),
    signingKey: resolve(signingTrustRoot, "signing.key"),
    projectionKey: resolve(projectionTrustRoot, "projection.key"),
    projectionCertificate: resolve(projectionTrustRoot, "projection.crt"),
    projectionCa: resolve(projectionTrustRoot, "projection-ca.crt"),
  };
  await Promise.all([
    writeFile(paths.serverKey, privateKey, { mode: 0o400 }),
    writeFile(paths.serverCertificate, certificate, { mode: 0o400 }),
    writeFile(paths.clientCa, certificate, { mode: 0o400 }),
    writeFile(paths.peers, JSON.stringify(peerRegistry(input.peers)), { mode: 0o400 }),
    writeFile(paths.signingKey, input.signingKey, { mode: 0o400 }),
    writeFile(paths.projectionKey, privateKey, { mode: 0o400 }),
    writeFile(paths.projectionCertificate, certificate, { mode: 0o400 }),
    writeFile(paths.projectionCa, certificate, { mode: 0o400 }),
  ]);
  return {
    NODE_ENV: "production",
    KOKORO_HUB_CONNECT_PORT: "4252",
    KOKORO_HUB_CONNECT_HEALTH_PORT: "4253",
    KOKORO_HUB_MONGO_URL: "invalid://dependency-injection-must-win",
    KOKORO_HUB_MONGO_DB: "kokoro_hub",
    KOKORO_WORKSPACE_CONFIG: storage,
    KOKORO_WORKSPACE_S3_ACCESS_KEY: "unused-access-key",
    KOKORO_WORKSPACE_S3_SECRET_KEY: "unused-secret-key",
    KOKORO_HUB_SECRET_MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
    KOKORO_HUB_CONNECT_TRUST_ROOT: trustRoot,
    KOKORO_HUB_CONNECT_TLS_KEY_FILE: paths.serverKey,
    KOKORO_HUB_CONNECT_TLS_CERT_FILE: paths.serverCertificate,
    KOKORO_HUB_CONNECT_TLS_CLIENT_CA_FILE: paths.clientCa,
    KOKORO_HUB_CONNECT_MTLS_PEERS_FILE: paths.peers,
    KOKORO_HUB_CATALOG_PLATFORM_CALLER_SAN_URI: "spiffe://kokoro.internal/platform",
    KOKORO_HUB_RUNTIME_AGENT_CALLER_SAN_URI: "spiffe://kokoro.internal/agent",
    KOKORO_HUB_CAPABILITY_SIGNING_KEY_REF: "hub-signing:revision:1",
    KOKORO_HUB_CAPABILITY_SIGNING_TRUST_ROOT: signingTrustRoot,
    KOKORO_HUB_CAPABILITY_SIGNING_KEY_FILE: paths.signingKey,
    KOKORO_HUB_PLATFORM_PROJECTION_BASE_URL: input.projectionBaseUrl,
    KOKORO_HUB_PLATFORM_PROJECTION_SERVER_NAME: "platform-admission.internal",
    KOKORO_HUB_PLATFORM_PROJECTION_TRUST_ROOT: projectionTrustRoot,
    KOKORO_HUB_PLATFORM_PROJECTION_CLIENT_KEY_FILE: paths.projectionKey,
    KOKORO_HUB_PLATFORM_PROJECTION_CLIENT_CERT_FILE: paths.projectionCertificate,
    KOKORO_HUB_PLATFORM_PROJECTION_SERVER_CA_FILE: paths.projectionCa,
  };
}

function peerRegistry(count: number): Readonly<{ version: 1; peers: readonly object[] }> {
  const identities = [
    "spiffe://kokoro.internal/platform",
    "spiffe://kokoro.internal/agent",
    ...Array.from({ length: Math.max(0, count - 2) }, (_, index) =>
      `spiffe://kokoro.internal/peer-${index}`),
  ];
  return {
    version: 1,
    peers: identities.map((sanUri) => ({
      sanUri,
      fingerprint256: Array.from({ length: 32 }, () => "AA").join(":"),
    })),
  };
}

function validPrivateKey(): string {
  return generateKeyPairSync("ed25519").privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
}

function invalidPrivateKey(): string {
  return "-----BEGIN PRIVATE KEY-----\nnot-valid-key-material\n-----END PRIVATE KEY-----\n";
}
