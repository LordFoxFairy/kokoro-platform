import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadHubConnectStartupConfig,
  runHubConnectMain,
} from "../../src/process/hub-connect.js";
import { setupHubFixture } from "../../kokoro-hub/test/fixtures/web-chat-credit-runtime.js";

describe("Hub Connect startup composition", () => {
  it("accepts a production local-workspace configuration without S3 credentials", () => {
    expect(loadHubConnectStartupConfig(productionEnvironment())).toMatchObject({
      port: 4252,
      healthPort: 4253,
      mongoUrl: "mongodb://mongo.internal:27017",
      mongoDatabase: "kokoro_hub",
    });
  });

  it("composes a production local package store without contacting S3", async () => {
    const trustRoot = await mkdtemp(resolve(tmpdir(), "hub-connect-local-storage-"));
    try {
      const fixture = await setupHubFixture({
        KOKORO_HUB_FIXTURE_PRIVATE_DIR: trustRoot,
        KOKORO_HUB_FIXTURE_CONNECT_PORT: "4252",
        KOKORO_HUB_FIXTURE_HEALTH_PORT: "4253",
      });
      const mongoBoundary = new Error("MONGO_BOUNDARY_REACHED");
      let closeCalls = 0;

      await expect(runHubConnectMain(productionEnvironment({
        KOKORO_WORKSPACE_CONFIG: fixture.workspaceConfigFile,
        KOKORO_HUB_CONNECT_TRUST_ROOT: fixture.trustRoot,
        KOKORO_HUB_CONNECT_TLS_KEY_FILE: fixture.serverPrivateKeyFile,
        KOKORO_HUB_CONNECT_TLS_CERT_FILE: fixture.serverCertificateFile,
        KOKORO_HUB_CONNECT_TLS_CLIENT_CA_FILE: fixture.certificateAuthorityFile,
        KOKORO_HUB_CONNECT_MTLS_PEERS_FILE: fixture.peerRegistryFile,
        KOKORO_HUB_CATALOG_PLATFORM_CALLER_SAN_URI:
          "spiffe://kokoro.test/platform/hub-catalog/web-chat-credit-runtime",
        KOKORO_HUB_RUNTIME_AGENT_CALLER_SAN_URI:
          "spiffe://kokoro.internal/agent/web-chat-credit-runtime",
        KOKORO_HUB_CAPABILITY_SIGNING_TRUST_ROOT: fixture.trustRoot,
        KOKORO_HUB_CAPABILITY_SIGNING_KEY_FILE: fixture.serverPrivateKeyFile,
        KOKORO_HUB_PLATFORM_PROJECTION_TRUST_ROOT: fixture.trustRoot,
        KOKORO_HUB_PLATFORM_PROJECTION_CLIENT_KEY_FILE: fixture.platformPrivateKeyFile,
        KOKORO_HUB_PLATFORM_PROJECTION_CLIENT_CERT_FILE: fixture.platformCertificateFile,
        KOKORO_HUB_PLATFORM_PROJECTION_SERVER_CA_FILE: fixture.certificateAuthorityFile,
      }), {
        createMongoClient: () => ({
          connect: async () => Promise.reject(mongoBoundary),
          close: async () => { closeCalls += 1; },
          db: () => { throw new Error("MONGO_DB_MUST_NOT_BE_READ"); },
        }),
      })).rejects.toBe(mongoBoundary);
      expect(closeCalls).toBe(1);
    } finally {
      await rm(trustRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it.each([
    ["access key", { KOKORO_WORKSPACE_S3_SECRET_KEY: "example-secret" },
      "KOKORO_WORKSPACE_S3_ACCESS_KEY_REQUIRED"],
    ["secret key", { KOKORO_WORKSPACE_S3_ACCESS_KEY: "example-access" },
      "KOKORO_WORKSPACE_S3_SECRET_KEY_REQUIRED"],
  ] as const)("rejects an S3 package store missing its %s", async (_label, credentials, error) => {
    const directory = await mkdtemp(resolve(tmpdir(), "hub-connect-s3-storage-"));
    try {
      const config = resolve(directory, "storage.yaml");
      await writeFile(config, [
        "workspace:",
        "  type: local",
        `  root: ${directory}`,
        "hub:",
        "  type: s3",
        "  endpoint: http://object-storage.internal:9000",
        "  bucket: kokoro-hub",
        "  region: us-east-1",
        "  force_path_style: true",
        "",
      ].join("\n"), { mode: 0o600 });

      await expect(runHubConnectMain(productionEnvironment({
        KOKORO_WORKSPACE_CONFIG: config,
        ...credentials,
      }), {
        createMongoClient: () => { throw new Error("MONGO_CLIENT_MUST_NOT_BE_CREATED"); },
      })).rejects.toThrowError(error);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function productionEnvironment(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Readonly<Record<string, string | undefined>> {
  return {
    NODE_ENV: "production",
    KOKORO_HUB_CONNECT_PORT: "4252",
    KOKORO_HUB_CONNECT_HEALTH_PORT: "4253",
    KOKORO_HUB_MONGO_URL: "mongodb://mongo.internal:27017",
    KOKORO_HUB_MONGO_DB: "kokoro_hub",
    KOKORO_WORKSPACE_CONFIG: "/app/storage.yaml",
    KOKORO_HUB_SECRET_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    KOKORO_HUB_CONNECT_TRUST_ROOT: "/run/secrets/hub-connect-inbound",
    KOKORO_HUB_CONNECT_TLS_KEY_FILE: "/run/secrets/hub-connect-inbound/server.key",
    KOKORO_HUB_CONNECT_TLS_CERT_FILE: "/run/secrets/hub-connect-inbound/server.crt",
    KOKORO_HUB_CONNECT_TLS_CLIENT_CA_FILE: "/run/secrets/hub-connect-inbound/client-ca.crt",
    KOKORO_HUB_CONNECT_MTLS_PEERS_FILE: "/run/secrets/hub-connect-inbound/inbound-peers.json",
    KOKORO_HUB_CATALOG_PLATFORM_CALLER_SAN_URI: "spiffe://kokoro.internal/platform",
    KOKORO_HUB_RUNTIME_AGENT_CALLER_SAN_URI: "spiffe://kokoro.internal/agent",
    KOKORO_HUB_CAPABILITY_SIGNING_KEY_REF: "capability-signing-key-v1",
    KOKORO_HUB_CAPABILITY_SIGNING_TRUST_ROOT: "/run/secrets/hub-capability-signing",
    KOKORO_HUB_CAPABILITY_SIGNING_KEY_FILE:
      "/run/secrets/hub-capability-signing/catalog-signing.key",
    KOKORO_HUB_PLATFORM_PROJECTION_BASE_URL: "https://platform-admission.internal:4244",
    KOKORO_HUB_PLATFORM_PROJECTION_SERVER_NAME: "platform-admission.internal",
    KOKORO_HUB_PLATFORM_PROJECTION_TRUST_ROOT: "/run/secrets/hub-platform-projection",
    KOKORO_HUB_PLATFORM_PROJECTION_CLIENT_KEY_FILE:
      "/run/secrets/hub-platform-projection/platform-client.key",
    KOKORO_HUB_PLATFORM_PROJECTION_CLIENT_CERT_FILE:
      "/run/secrets/hub-platform-projection/platform-client.crt",
    KOKORO_HUB_PLATFORM_PROJECTION_SERVER_CA_FILE:
      "/run/secrets/hub-platform-projection/platform-ca.crt",
    ...overrides,
  };
}
