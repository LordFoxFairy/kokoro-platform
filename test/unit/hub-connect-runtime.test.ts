import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport, Http2SessionManager } from "@connectrpc/connect-node";
import { describe, expect, it, vi } from "vitest";
import {
  GetCatalogPublicationResponseSchema,
  HubCatalogService,
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

describe("Hub Connect bounded request admission", () => {
  it("enforces deadlines, peer/global capacity, and drain before dispatch", async () => {
    const trustRoot = await mkdtemp(resolve(tmpdir(), "hub-connect-timeout-"));
    const fixture = await setupHubFixture({
      KOKORO_HUB_FIXTURE_PRIVATE_DIR: trustRoot,
      KOKORO_HUB_FIXTURE_CONNECT_PORT: "4252",
      KOKORO_HUB_FIXTURE_HEALTH_PORT: "4253",
    });
    const [key, cert, ca, agentKey, agentCert, platformKey, platformCert, registrySource] =
      await Promise.all([
      readFile(fixture.serverPrivateKeyFile),
      readFile(fixture.serverCertificateFile),
      readFile(fixture.certificateAuthorityFile),
      readFile(fixture.agentPrivateKeyFile),
      readFile(fixture.agentCertificateFile),
      readFile(fixture.platformPrivateKeyFile),
      readFile(fixture.platformCertificateFile),
      readFile(fixture.peerRegistryFile, "utf8"),
    ]);
    const registry = JSON.parse(registrySource) as Readonly<{
      peers: readonly Readonly<{ sanUri: string; fingerprint256: string }>[];
    }>;
    let resolveCalls = 0;
    let blockRequests = false;
    let runtimeBlock: Promise<void> | undefined;
    let catalogCalls = 0;
    let blockCatalog = false;
    let catalogBlock: Promise<void> | undefined;
    let draining = false;
    const shutdownController = new AbortController();
    const fetchStarted = deferred();
    let fetchSignal: AbortSignal | undefined;
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
      catalog: successfulCatalog(async () => {
        catalogCalls += 1;
        if (blockCatalog) await catalogBlock;
      }),
      runtime: successfulRuntime(
        async () => {
          resolveCalls += 1;
          if (blockRequests) await runtimeBlock;
        },
        async (signal) => {
          fetchSignal = signal;
          fetchStarted.resolve();
          await rejectWhenAborted(signal);
        },
      ),
      isDraining: () => draining,
      shutdownSignal: shutdownController.signal,
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
    const clientWithoutDeadline = createClient(HubRuntimeService, createConnectTransport({
      baseUrl,
      httpVersion: "2",
      sessionManager: sessions,
      useBinaryFormat: true,
      readMaxBytes: 2 * 1024 * 1024,
      writeMaxBytes: 2 * 1024 * 1024,
      acceptCompression: [],
    }));
    const platformSessions = new Http2SessionManager(baseUrl, {}, {
      ca,
      cert: platformCert,
      key: platformKey,
      servername: "hub-runtime.fixture.local",
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
    });
    const platformClient = createClient(HubCatalogService, createConnectTransport({
      baseUrl,
      httpVersion: "2",
      sessionManager: platformSessions,
      useBinaryFormat: true,
      defaultTimeoutMs: 5_000,
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
      await expect(clientWithoutDeadline.resolveExecutionAssembly({
        namespace: "opaque-namespace",
        agentCatalogRef: CATALOG_REF,
        skillGrants: [],
        mcpGrants: [],
      })).rejects.toSatisfy((error: unknown) => {
        const connectError = ConnectError.from(error);
        return connectError.code === Code.InvalidArgument &&
          connectError.rawMessage === "request deadline required";
      });
      expect(resolveCalls).toBe(1);

      blockRequests = true;
      const perPeerGate = deferred();
      runtimeBlock = perPeerGate.promise;
      const inFlight = Array.from({ length: 8 }, () => client.resolveExecutionAssembly({
        namespace: "opaque-namespace",
        agentCatalogRef: CATALOG_REF,
        skillGrants: [],
        mcpGrants: [],
      }, { timeoutMs: 5_000 }));
      try {
        await vi.waitFor(() => expect(resolveCalls).toBe(9));
        await expect(client.resolveExecutionAssembly({
          namespace: "opaque-namespace",
          agentCatalogRef: CATALOG_REF,
          skillGrants: [],
          mcpGrants: [],
        }, { timeoutMs: 500 })).rejects.toSatisfy((error: unknown) =>
          ConnectError.from(error).code === Code.ResourceExhausted);
        expect(resolveCalls).toBe(9);
      } finally {
        perPeerGate.resolve();
        await Promise.allSettled(inFlight);
      }

      const globalGate = deferred();
      runtimeBlock = globalGate.promise;
      catalogBlock = globalGate.promise;
      blockCatalog = true;
      const runtimeBeforeGlobal = resolveCalls;
      const catalogBeforeGlobal = catalogCalls;
      const globalInFlight = [
        ...Array.from({ length: 6 }, () => client.resolveExecutionAssembly({
          namespace: "opaque-namespace",
          agentCatalogRef: CATALOG_REF,
          skillGrants: [],
          mcpGrants: [],
        }, { timeoutMs: 5_000 })),
        ...Array.from({ length: 6 }, () => platformClient.getCatalogPublication({}, {
          timeoutMs: 5_000,
        })),
      ];
      try {
        await vi.waitFor(() => {
          expect(resolveCalls - runtimeBeforeGlobal).toBe(6);
          expect(catalogCalls - catalogBeforeGlobal).toBe(6);
        });
        await expect(client.resolveExecutionAssembly({
          namespace: "opaque-namespace",
          agentCatalogRef: CATALOG_REF,
          skillGrants: [],
          mcpGrants: [],
        }, { timeoutMs: 500 })).rejects.toSatisfy((error: unknown) =>
          ConnectError.from(error).code === Code.ResourceExhausted);
        expect(resolveCalls - runtimeBeforeGlobal).toBe(6);
      } finally {
        globalGate.resolve();
        await Promise.allSettled(globalInFlight);
      }

      const slowArtifact = client.fetchSkillArtifact({
        namespace: "opaque-namespace",
        agentCatalogRef: CATALOG_REF,
        grant: {
          optionRef: "skill:slow",
          scope: "opaque-namespace",
          name: "slow",
          contentHash: "c".repeat(64),
          description: "Slow artifact",
        },
        artifactRef: "skills/opaque-namespace/slow/package.zip",
        expectedSize: 1n,
        expectedSha256: "d".repeat(64),
      }, { timeoutMs: 30_000 });
      const consumeSlowArtifact = (async () => {
        for await (const _chunk of slowArtifact) { /* stream must end through shutdown */ }
      })();
      await fetchStarted.promise;
      const streamStopped = expect(consumeSlowArtifact).rejects.toSatisfy((error: unknown) =>
        ConnectError.from(error).code === Code.Unavailable);
      draining = true;
      shutdownController.abort(new ConnectError("hub runtime draining", Code.Unavailable));
      await streamStopped;
      expect(fetchSignal?.aborted).toBe(true);

      const callsBeforeDrain = resolveCalls;
      await expect(client.resolveExecutionAssembly({
        namespace: "opaque-namespace",
        agentCatalogRef: CATALOG_REF,
        skillGrants: [],
        mcpGrants: [],
      }, { timeoutMs: 500 })).rejects.toBeDefined();
      expect(resolveCalls).toBe(callsBeforeDrain);
    } finally {
      sessions.abort(new Error("HUB_CONNECT_TIMEOUT_TEST_COMPLETE"));
      platformSessions.abort(new Error("HUB_CONNECT_TIMEOUT_TEST_COMPLETE"));
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

function successfulCatalog(onGet: () => void | Promise<void>): HubCatalogConnectService {
  return {
    freezeCatalog: unavailableCatalog().freezeCatalog,
    getCatalogPublication: async () => {
      await onGet();
      return create(GetCatalogPublicationResponseSchema, {});
    },
  };
}

function successfulRuntime(
  onResolve: () => void | Promise<void>,
  onFetch: (signal: AbortSignal) => void | Promise<void> = () => undefined,
): HubRuntimeConnectService {
  return {
    resolveExecutionAssembly: async (request) => {
      await onResolve();
      return create(ResolveExecutionAssemblyResponseSchema, {
        agentCatalogRef: request.agentCatalogRef,
        assemblyDigest: "b".repeat(64),
        skills: [],
        mcpServers: [],
      });
    },
    fetchSkillArtifact: async function* (_request, context) {
      await onFetch(context.signal);
      const responses: readonly never[] = [];
      yield* responses;
    },
  };
}

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolveValue) => { resolvePromise = resolveValue; });
  return Object.freeze({ promise, resolve: resolvePromise });
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
