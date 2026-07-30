import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createHubConnectHealthServer } from "../../src/interfaces/connect/hub-connect-health.js";
import {
  HUB_CONNECT_PRODUCTION_REQUIRED_ENVIRONMENT,
  loadHubConnectStartupConfig,
  readBoundedHubConnectFile,
} from "../../src/interfaces/connect/main.js";

const productionEnvironment = Object.freeze({
  NODE_ENV: "production",
  KOKORO_HUB_CONNECT_PORT: "4252",
  KOKORO_HUB_CONNECT_HEALTH_PORT: "4253",
  KOKORO_HUB_MONGO_URL: "mongodb://mongo.internal:27017",
  KOKORO_HUB_MONGO_DB: "kokoro_hub",
  KOKORO_WORKSPACE_CONFIG: "/run/config/storage.yaml",
  KOKORO_WORKSPACE_S3_ACCESS_KEY: "example-access-key",
  KOKORO_WORKSPACE_S3_SECRET_KEY: "example-secret-key",
  KOKORO_HUB_SECRET_MASTER_KEY: "example-key",
  KOKORO_HUB_CONNECT_TRUST_ROOT: "/run/secrets",
  KOKORO_HUB_CONNECT_TLS_KEY_FILE: "/run/secrets/server.key",
  KOKORO_HUB_CONNECT_TLS_CERT_FILE: "/run/secrets/server.crt",
  KOKORO_HUB_CONNECT_TLS_CLIENT_CA_FILE: "/run/secrets/client-ca.crt",
  KOKORO_HUB_CONNECT_MTLS_PEERS_FILE: "/run/secrets/peers.json",
  KOKORO_HUB_CATALOG_PLATFORM_CALLER_SAN_URI: "spiffe://kokoro.internal/platform",
  KOKORO_HUB_RUNTIME_AGENT_CALLER_SAN_URI: "spiffe://kokoro.internal/agent",
  KOKORO_HUB_CAPABILITY_SIGNING_KEY_REF: "hub-signing:revision:1",
  KOKORO_HUB_CAPABILITY_SIGNING_KEY_FILE: "/run/secrets/signing.key",
  KOKORO_HUB_PLATFORM_PROJECTION_BASE_URL: "https://platform-admission.internal:4244",
  KOKORO_HUB_PLATFORM_PROJECTION_SERVER_NAME: "platform-admission.internal",
  KOKORO_HUB_PLATFORM_PROJECTION_CLIENT_KEY_FILE: "/run/secrets/projection.key",
  KOKORO_HUB_PLATFORM_PROJECTION_CLIENT_CERT_FILE: "/run/secrets/projection.crt",
  KOKORO_HUB_PLATFORM_PROJECTION_SERVER_CA_FILE: "/run/secrets/projection-ca.crt",
});

describe("Hub Connect deployment preflight", () => {
  it.each(HUB_CONNECT_PRODUCTION_REQUIRED_ENVIRONMENT)(
    "fails before I/O when production is missing %s",
    (name) => {
      const environment = { ...productionEnvironment, [name]: undefined };
      expect(() => loadHubConnectStartupConfig(environment)).toThrowError(`${name}_REQUIRED`);
    },
  );

  it("requires dedicated Connect and health ports", () => {
    expect(() =>
      loadHubConnectStartupConfig({
        ...productionEnvironment,
        KOKORO_HUB_CONNECT_HEALTH_PORT: productionEnvironment.KOKORO_HUB_CONNECT_PORT,
      }),
    ).toThrowError("HUB_CONNECT_PORTS_NOT_DISTINCT");
    expect(loadHubConnectStartupConfig(productionEnvironment)).toMatchObject({
      port: 4252,
      healthPort: 4253,
      mongoDatabase: "kokoro_hub",
    });
  });
});

describe("Hub Connect mounted secret files", () => {
  it("follows the bounded Kubernetes AtomicWriter chain inside the trust root", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "hub-connect-secret-"));
    const revision = resolve(directory, "..2026_07_30_00_00_00.000000000");
    try {
      await mkdir(revision);
      await writeFile(resolve(revision, "server.key"), "atomic-private-material", { mode: 0o400 });
      await symlink("..2026_07_30_00_00_00.000000000", resolve(directory, "..data"));
      await symlink("..data/server.key", resolve(directory, "server.key"));

      await expect(
        readBoundedHubConnectFile(resolve(directory, "server.key"), directory, 1024, true),
      ).resolves.toBe("atomic-private-material");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an AtomicWriter-compatible chain that escapes the trust root", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "hub-connect-secret-"));
    const outside = await mkdtemp(resolve(tmpdir(), "hub-connect-outside-"));
    try {
      await writeFile(resolve(outside, "server.key"), "escaped-private-material", { mode: 0o400 });
      await symlink(outside, resolve(directory, "..data"));
      await symlink("..data/server.key", resolve(directory, "server.key"));

      await expect(
        readBoundedHubConnectFile(resolve(directory, "server.key"), directory, 1024, true),
      ).rejects.toThrowError("HUB_CONNECT_TRUST_FILE_INVALID");
    } finally {
      await Promise.all([
        rm(directory, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  it("accepts dedicated workload-group read-only mounts", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "hub-connect-secret-"));
    const path = resolve(directory, "server.key");
    try {
      await writeFile(path, "example-private-material", { mode: 0o440 });
      await expect(readBoundedHubConnectFile(path, directory, 1024, true)).resolves.toBe(
        "example-private-material",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([0o460, 0o404])("rejects writable-group or world-readable mode %s", async (mode) => {
    const directory = await mkdtemp(resolve(tmpdir(), "hub-connect-secret-"));
    const path = resolve(directory, "server.key");
    try {
      await writeFile(path, "example-private-material", { mode: 0o600 });
      await chmod(path, mode);
      await expect(readBoundedHubConnectFile(path, directory, 1024, true)).rejects.toThrowError(
        "HUB_CONNECT_TRUST_FILE_INVALID",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Hub Connect health listener", () => {
  it("reports live independently and gates readiness on Mongo and drain state", async () => {
    let dependencyReady = true;
    let draining = false;
    const server = createHubConnectHealthServer({
      ready: async () => dependencyReady,
      isDraining: () => draining,
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("TEST_ADDRESS_UNAVAILABLE");
    try {
      await expect(get(address.port, "/health/live")).resolves.toEqual({
        status: 200,
        body: '{"status":"live"}',
      });
      await expect(get(address.port, "/health/ready")).resolves.toEqual({
        status: 200,
        body: '{"status":"ready"}',
      });
      dependencyReady = false;
      await expect(get(address.port, "/health/ready")).resolves.toEqual({
        status: 503,
        body: '{"status":"not_ready"}',
      });
      dependencyReady = true;
      draining = true;
      await expect(get(address.port, "/health/ready")).resolves.toEqual({
        status: 503,
        body: '{"status":"not_ready"}',
      });
      await expect(get(address.port, "/unknown")).resolves.toEqual({
        status: 404,
        body: '{"status":"not_found"}',
      });
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("fails readiness closed when the dependency probe rejects", async () => {
    const server = createHubConnectHealthServer({
      ready: async () => {
        throw new Error("mongo unavailable");
      },
      isDraining: () => false,
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("TEST_ADDRESS_UNAVAILABLE");
    try {
      await expect(get(address.port, "/health/ready")).resolves.toEqual({
        status: 503,
        body: '{"status":"dependency_unavailable"}',
      });
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});

function get(port: number, path: string): Promise<Readonly<{ status: number; body: string }>> {
  return new Promise((resolveResponse, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, path, method: "GET" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () =>
        resolveResponse({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}
