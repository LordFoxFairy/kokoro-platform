import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  connect as connectHttp2,
  constants as http2Constants,
  type ClientHttp2Session,
  type ClientHttp2Stream,
} from "node:http2";
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
  it("admits authenticated raw requests before their bodies and releases every lease", async () => {
    const trustRoot = await mkdtemp(resolve(tmpdir(), "hub-connect-raw-admission-"));
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
    let catalogCalls = 0;
    const shutdownController = new AbortController();
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
      catalog: successfulCatalog(() => { catalogCalls += 1; }),
      runtime: successfulRuntime(() => undefined),
      shutdownSignal: shutdownController.signal,
    });
    const server = runtime.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const agentSession = connectHttp2(`https://127.0.0.1:${port}`, {
      ca,
      cert: agentCert,
      key: agentKey,
      servername: "hub-runtime.fixture.local",
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
    });
    const platformSession = connectHttp2(`https://127.0.0.1:${port}`, {
      ca,
      cert: platformCert,
      key: platformKey,
      servername: "hub-runtime.fixture.local",
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
    });
    await Promise.all([once(agentSession, "connect"), once(platformSession, "connect")]);
    const held: ClientHttp2Stream[] = [];
    try {
      const expired = rawCatalogRequest(platformSession, "1");
      const expiredClosed = once(expired, "close");
      await expect(within(rawResponse(expired), 500)).resolves.toEqual({
        status: 504,
        body: '{"code":"deadline_exceeded","message":"request deadline exceeded"}',
      });
      await within(expiredClosed, 500);
      expect(catalogCalls).toBe(0);

      const missing = rawCatalogRequest(platformSession);
      const missingClosed = once(missing, "close");
      await expect(within(rawResponse(missing), 500)).resolves.toMatchObject({ status: 400 });
      await within(missingClosed, 500);
      const oversized = rawCatalogRequest(platformSession, "30001");
      await expect(within(rawResponse(oversized), 500)).resolves.toMatchObject({ status: 400 });
      oversized.close(http2Constants.NGHTTP2_CANCEL);

      const firstAgentResponses: Promise<unknown>[] = [];
      for (let index = 0; index < 8; index += 1) {
        const stream = rawCatalogRequest(agentSession, "30000");
        held.push(stream);
        firstAgentResponses.push(rawResponse(stream));
      }
      await expectAllPending(firstAgentResponses, 25);
      const ninthAgent = rawCatalogRequest(agentSession, "30000");
      const ninthClosed = once(ninthAgent, "close");
      await expect(within(rawResponse(ninthAgent), 500)).resolves.toMatchObject({ status: 429 });
      await within(ninthClosed, 500);

      const health = agentSession.request({ ":method": "GET", ":path": "/health/live" });
      const healthResponse = rawResponse(health);
      health.end();
      await expect(within(healthResponse, 500)).resolves.toMatchObject({ status: 200 });

      const firstPlatformResponses: Promise<unknown>[] = [];
      for (let index = 0; index < 4; index += 1) {
        const stream = rawCatalogRequest(platformSession, "30000");
        held.push(stream);
        firstPlatformResponses.push(rawResponse(stream));
      }
      await expectAllPending(firstPlatformResponses, 25);
      const thirteenth = rawCatalogRequest(platformSession, "30000");
      await expect(within(rawResponse(thirteenth), 500)).resolves.toMatchObject({ status: 429 });
      thirteenth.close(http2Constants.NGHTTP2_CANCEL);
      expect(catalogCalls).toBe(0);

      const closed = held.map((stream) => once(stream, "close"));
      for (const stream of held) stream.close(http2Constants.NGHTTP2_CANCEL);
      await Promise.all(closed);
      await delay(25);

      const secondAgent = openHeldRequests(agentSession, 8, held);
      const secondPlatform = openHeldRequests(platformSession, 4, held);
      await expectAllPending([...secondAgent, ...secondPlatform].map(({ response }) => response), 25);
      await expectRawStatus(rawCatalogRequest(agentSession, "30000"), 429);
      await expectRawStatus(rawCatalogRequest(platformSession, "30000"), 429);
      const normal = secondAgent[0];
      if (normal === undefined) throw new Error("HUB_RAW_FIXTURE_INVALID");
      normal.stream.end();
      await expect(within(normal.response, 500)).resolves.toMatchObject({ status: 200 });
      for (const item of [...secondAgent.slice(1), ...secondPlatform]) {
        item.stream.close(http2Constants.NGHTTP2_CANCEL);
      }
      await delay(25);
      expect(catalogCalls).toBe(1);

      const thirdAgent = openHeldRequests(agentSession, 8, held);
      const thirdPlatform = openHeldRequests(platformSession, 4, held);
      await expectAllPending([...thirdAgent, ...thirdPlatform].map(({ response }) => response), 25);
      await expectRawStatus(rawCatalogRequest(agentSession, "30000"), 429);
      await expectRawStatus(rawCatalogRequest(platformSession, "30000"), 429);
      for (const item of [...thirdAgent, ...thirdPlatform]) {
        item.stream.close(http2Constants.NGHTTP2_CANCEL);
      }
      await delay(25);

      const draining = rawCatalogRequest(agentSession, "30000");
      const drainingResponse = rawResponse(draining);
      const drainingClosed = once(draining, "close");
      await delay(10);
      shutdownController.abort(new ConnectError("hub runtime draining", Code.Unavailable));
      await expect(within(drainingResponse, 500)).resolves.toEqual({
        status: 503,
        body: '{"code":"unavailable","message":"hub runtime draining"}',
      });
      await within(drainingClosed, 500);
      expect(catalogCalls).toBe(1);
    } finally {
      for (const stream of held) stream.close(http2Constants.NGHTTP2_CANCEL);
      agentSession.destroy();
      platformSession.destroy();
      server.close();
      await once(server, "close").catch(() => undefined);
      await rm(trustRoot, { recursive: true, force: true });
    }
  }, 15_000);

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

const RAW_CATALOG_PATH =
  "/kokoro.platform.capability.v1.HubCatalogService/GetCatalogPublication";

function rawCatalogRequest(session: ClientHttp2Session, timeoutMs?: string): ClientHttp2Stream {
  const stream = session.request({
    ":method": "POST",
    ":path": RAW_CATALOG_PATH,
    "content-type": "application/proto",
    "connect-protocol-version": "1",
    ...(timeoutMs === undefined ? {} : { "connect-timeout-ms": timeoutMs }),
  });
  stream.on("error", () => undefined);
  return stream;
}

function rawResponse(stream: ClientHttp2Stream): Promise<Readonly<{ status: number; body: string }>> {
  return new Promise((resolveResponse, rejectResponse) => {
    let status = 0;
    const body: Buffer[] = [];
    stream.once("response", (headers) => { status = Number(headers[":status"]); });
    stream.on("data", (chunk: Buffer) => body.push(chunk));
    stream.once("end", () => resolveResponse({ status, body: Buffer.concat(body).toString("utf8") }));
    stream.once("error", rejectResponse);
  });
}

function within<Value>(promise: Promise<Value>, milliseconds: number): Promise<Value> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("HUB_RAW_RESPONSE_TIMEOUT")), milliseconds);
      timer.unref();
    }),
  ]);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function openHeldRequests(
  session: ClientHttp2Session,
  count: number,
  tracked: ClientHttp2Stream[],
): ReadonlyArray<Readonly<{
  stream: ClientHttp2Stream;
  response: Promise<Readonly<{ status: number; body: string }>>;
}>> {
  return Array.from({ length: count }, () => {
    const stream = rawCatalogRequest(session, "30000");
    tracked.push(stream);
    return Object.freeze({ stream, response: rawResponse(stream) });
  });
}

async function expectAllPending(promises: readonly Promise<unknown>[], milliseconds: number): Promise<void> {
  const settled = Symbol("settled");
  const pending = Symbol("pending");
  await Promise.all(promises.map(async (promise) => {
    const outcome = await Promise.race([
      promise.then(() => settled, () => settled),
      delay(milliseconds).then(() => pending),
    ]);
    expect(outcome).toBe(pending);
  }));
}

async function expectRawStatus(stream: ClientHttp2Stream, status: number): Promise<void> {
  const closed = once(stream, "close");
  await expect(within(rawResponse(stream), 500)).resolves.toMatchObject({ status });
  await within(closed, 500);
}
