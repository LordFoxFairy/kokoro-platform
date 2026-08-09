import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport, Http2SessionManager } from "@connectrpc/connect-node";
import { describe, expect, it } from "vitest";
import {
  HubRuntimeService,
  ResolveExecutionAssemblyResponseSchema,
} from "../../src/generated/proto/kokoro/platform/capability/v1/capability_catalog_pb.js";
import type {
  HubCatalogConnectService,
  HubRuntimeConnectService,
} from "../../src/modules/hub/interfaces/connect/capability-catalog-services.js";
import {
  createHubConnectRuntime,
  type HubConnectCaller,
} from "../../src/modules/hub/interfaces/connect/hub-connect-runtime.js";
import { setupHubFixture } from "../../kokoro-hub/test/fixtures/web-chat-credit-runtime.js";

const CATALOG_REF = `agent-catalog:sha256:${"a".repeat(64)}`;

describe("Hub Connect request deadline", () => {
  it("accepts the Agent 30-second contract and rejects a 30,001ms request", async () => {
    const trustRoot = await mkdtemp(resolve(tmpdir(), "hub-connect-timeout-"));
    const fixture = await setupHubFixture({
      KOKORO_HUB_FIXTURE_PRIVATE_DIR: trustRoot,
      KOKORO_HUB_FIXTURE_CONNECT_PORT: "4252",
      KOKORO_HUB_FIXTURE_HEALTH_PORT: "4253",
    });
    const [key, cert, ca, agentKey, agentCert, registrySource] = await Promise.all([
      readFile(fixture.serverPrivateKeyFile),
      readFile(fixture.serverCertificateFile),
      readFile(fixture.certificateAuthorityFile),
      readFile(fixture.agentPrivateKeyFile),
      readFile(fixture.agentCertificateFile),
      readFile(fixture.peerRegistryFile, "utf8"),
    ]);
    const registry = JSON.parse(registrySource) as Readonly<{
      peers: readonly Readonly<{ sanUri: string; fingerprint256: string }>[];
    }>;
    let resolveCalls = 0;
    const callers = new AsyncLocalStorage<HubConnectCaller>();
    const runtime = createHubConnectRuntime({
      tls: {
        key,
        cert,
        ca,
        requestCert: true,
        rejectUnauthorized: true,
        allowHTTP1: false,
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
      },
      peers: registry.peers.map((peer) => ({ ...peer, identity: peer.sanUri })),
      callers,
      catalog: unavailableCatalog(),
      runtime: successfulRuntime(() => { resolveCalls += 1; }),
    });
    const server = runtime.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `https://127.0.0.1:${port}`;
    const sessions = new Http2SessionManager(baseUrl, {}, {
      ca,
      cert: agentCert,
      key: agentKey,
      servername: "hub-runtime.fixture.local",
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
    });
    const client = createClient(HubRuntimeService, createConnectTransport({
      baseUrl,
      httpVersion: "2",
      sessionManager: sessions,
      useBinaryFormat: true,
      defaultTimeoutMs: 30_000,
      readMaxBytes: 2 * 1024 * 1024,
      writeMaxBytes: 2 * 1024 * 1024,
      acceptCompression: [],
    }));

    try {
      await expect(client.resolveExecutionAssembly({
        namespace: "opaque-namespace",
        agentCatalogRef: CATALOG_REF,
        skillGrants: [],
        mcpGrants: [],
      })).resolves.toMatchObject({
        agentCatalogRef: CATALOG_REF,
        assemblyDigest: "b".repeat(64),
      });
      await expect(client.resolveExecutionAssembly({
        namespace: "opaque-namespace",
        agentCatalogRef: CATALOG_REF,
        skillGrants: [],
        mcpGrants: [],
      }, { timeoutMs: 30_001 })).rejects.toSatisfy((error: unknown) => {
        const connectError = ConnectError.from(error);
        return connectError.code === Code.InvalidArgument &&
          connectError.rawMessage === "timeout 30001ms must be <= 30000";
      });
      expect(resolveCalls).toBe(1);
    } finally {
      sessions.abort(new Error("HUB_CONNECT_TIMEOUT_TEST_COMPLETE"));
      server.close();
      await once(server, "close");
      await rm(trustRoot, { recursive: true, force: true });
    }
  }, 15_000);
});

function unavailableCatalog(): HubCatalogConnectService {
  const unavailable = (): never => {
    throw new ConnectError("catalog unavailable in runtime timeout test", Code.Unavailable);
  };
  return { freezeCatalog: unavailable, getCatalogPublication: unavailable };
}

function successfulRuntime(onResolve: () => void): HubRuntimeConnectService {
  return {
    resolveExecutionAssembly: (request) => {
      onResolve();
      return create(ResolveExecutionAssemblyResponseSchema, {
        agentCatalogRef: request.agentCatalogRef,
        assemblyDigest: "b".repeat(64),
        skills: [],
        mcpServers: [],
      });
    },
    fetchSkillArtifact: async function* () {
      const responses: readonly never[] = [];
      yield* responses;
    },
  };
}
