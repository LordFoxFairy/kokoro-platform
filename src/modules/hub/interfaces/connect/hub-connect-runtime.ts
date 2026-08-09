import { AsyncLocalStorage } from "node:async_hooks";
import {
  constants as http2Constants,
  createSecureServer,
  type Http2SecureServer,
  type SecureServerOptions,
} from "node:http2";
import type { Http2ServerRequest, Http2ServerResponse } from "node:http2";
import { TLSSocket } from "node:tls";
import { Code, ConnectError, type Interceptor } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { HubCatalogService, HubRuntimeService } from
  "../../../../generated/proto/kokoro/platform/capability/v1/capability_catalog_pb.js";
import type { HubCatalogConnectService, HubRuntimeConnectService } from
  "./capability-catalog-services.js";

export interface HubConnectCaller { readonly identity: string }

const admissionState = Symbol("hub-connect-admission-state");
type AdmittedHubConnectCaller = HubConnectCaller & Readonly<{
  [admissionState]: RawAdmission;
}>;
type RawAdmission = Readonly<{ signal: AbortSignal; assertDispatchable(): void }>;

const HUB_CONNECT_MAX_TIMEOUT_MS = 30_000;
const HUB_CONNECT_MAX_IN_FLIGHT = 12;
const HUB_CONNECT_MAX_IN_FLIGHT_PER_PEER = 8;

export interface HubConnectRuntime {
  readonly handler: (request: Http2ServerRequest, response: Http2ServerResponse) => void;
  createServer(): Http2SecureServer;
}

export function createHubConnectRuntime(input: Readonly<{
  tls: SecureServerOptions;
  peers: readonly Readonly<{ identity: string; fingerprint256: string; sanUri: string }>[];
  callers: AsyncLocalStorage<HubConnectCaller>;
  catalog: HubCatalogConnectService;
  runtime: HubRuntimeConnectService;
  ready?: () => Promise<boolean>;
  isDraining?: () => boolean;
  shutdownSignal: AbortSignal;
}>): HubConnectRuntime {
  if (input.peers.length < 2 || input.peers.length > 16) throw new Error("HUB_CONNECT_PEERS_INVALID");
  const capacity = requestCapacity();
  const shutdown = shutdownFanout(input.shutdownSignal);
  const connect = connectNodeAdapter({
    routes: (router) => {
      router.service(HubCatalogService, input.catalog);
      router.service(HubRuntimeService, input.runtime);
    },
    connect: true,
    grpc: false,
    grpcWeb: false,
    acceptCompression: [],
    readMaxBytes: 2 * 1024 * 1024,
    writeMaxBytes: 2 * 1024 * 1024,
    maxTimeoutMs: HUB_CONNECT_MAX_TIMEOUT_MS,
    shutdownSignal: input.shutdownSignal,
    interceptors: [dispatchFenceInterceptor(input.callers)],
  });
  const handler = (request: Http2ServerRequest, response: Http2ServerResponse): void => {
    response.setHeader("cache-control", "no-store");
    if (request.method === "GET" && request.url === "/health/live") {
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end('{"status":"live"}');
      return;
    }
    if (request.method === "GET" && request.url === "/health/ready") {
      response.setHeader("content-type", "application/json");
      void (input.isDraining?.() === true
        ? Promise.resolve(false)
        : (input.ready?.() ?? Promise.resolve(true))).then(
        (ready) => {
          if (!response.destroyed) {
            response.statusCode = ready ? 200 : 503;
            response.end(ready ? '{"status":"ready"}' : '{"status":"not_ready"}');
          }
        },
        () => {
          if (!response.destroyed) {
            response.statusCode = 503;
            response.end('{"status":"database_unavailable"}');
          }
        },
      );
      return;
    }
    if (input.isDraining?.() === true) {
      response.statusCode = 503;
      response.end("draining");
      return;
    }
    const caller = authenticate(request, input.peers);
    if (caller === null) {
      response.statusCode = 401;
      response.end("unauthorized");
      return;
    }
    const deadline = requestDeadline(request);
    if (deadline === null) {
      rawConnectError(request, response, 400, "invalid_argument", "request deadline required");
      return;
    }
    if (deadline > HUB_CONNECT_MAX_TIMEOUT_MS) {
      rawConnectError(request, response, 400, "invalid_argument",
        `timeout ${deadline}ms must be <= ${HUB_CONNECT_MAX_TIMEOUT_MS}`);
      return;
    }
    const releaseCapacity = capacity.acquire(caller.identity);
    if (releaseCapacity === null) {
      rawConnectError(request, response, 429, "resource_exhausted", "hub runtime at capacity");
      return;
    }
    const admission = bindRawAdmission({
      request,
      response,
      deadline,
      shutdown,
      releaseCapacity,
    });
    const admittedCaller: AdmittedHubConnectCaller = Object.freeze({
      ...caller,
      [admissionState]: admission,
    });
    input.callers.run(admittedCaller, () => {
      Promise.resolve(connect(request, response)).catch(() => {
        if (!response.headersSent) {
          response.statusCode = 503;
          response.end("unavailable");
        } else {
          response.destroy();
        }
      });
    });
  };
  return Object.freeze({
    handler,
    createServer: () => createSecureServer(input.tls, handler),
  });
}

function dispatchFenceInterceptor(callers: AsyncLocalStorage<HubConnectCaller>): Interceptor {
  return (next) => async (request) => {
    const caller = callers.getStore();
    if (caller === undefined) throw new ConnectError("caller unavailable", Code.Unauthenticated);
    await new Promise<void>((resolveDispatch) => setImmediate(resolveDispatch));
    const admission = (caller as Partial<AdmittedHubConnectCaller>)[admissionState];
    admission?.assertDispatchable();
    throwIfAborted(admission?.signal);
    throwIfAborted(request.signal);
    return next(request);
  };
}

function requestDeadline(request: Http2ServerRequest): number | null {
  const value = request.headers["connect-timeout-ms"];
  if (typeof value !== "string" || !/^[1-9][0-9]{0,4}$/u.test(value)) return null;
  return Number(value);
}

function bindRawAdmission(input: Readonly<{
  request: Http2ServerRequest;
  response: Http2ServerResponse;
  deadline: number;
  shutdown: ReturnType<typeof shutdownFanout>;
  releaseCapacity: () => void;
}>): RawAdmission {
  const controller = new AbortController();
  let active = true;
  let terminating = false;
  let dispatched = false;
  let unregisterShutdown: () => void = () => undefined;
  const release = () => {
    if (!active) return;
    active = false;
    clearTimeout(timer);
    input.response.off("finish", responseFinished);
    input.response.off("close", responseClosed);
    input.response.off("error", canceled);
    input.request.off("aborted", canceled);
    input.request.off("error", canceled);
    input.request.off("close", requestClosed);
    unregisterShutdown();
    input.releaseCapacity();
  };
  const reject = (error: ConnectError, status: number, code: string) => {
    if (!controller.signal.aborted) controller.abort(error);
    if (dispatched) {
      if (input.response.destroyed || input.response.writableEnded) release();
      return;
    }
    if (!input.response.destroyed && !input.response.writableEnded && !input.response.headersSent) {
      terminating = true;
      rawConnectError(input.request, input.response, status, code, error.rawMessage, release);
      return;
    }
    if (input.response.destroyed || input.response.writableEnded) release();
  };
  const canceled = () => {
    if (!controller.signal.aborted) {
      controller.abort(new ConnectError("request canceled", Code.Canceled));
    }
    release();
  };
  const requestClosed = () => {
    if (terminating || input.request.stream.rstCode !== 0) canceled();
  };
  const responseFinished = () => {
    if (!terminating) release();
  };
  const responseClosed = () => {
    if (terminating && !input.request.stream.closed && !input.request.stream.destroyed) return;
    if (input.response.writableFinished) release();
    else canceled();
  };
  const shutdown = () => reject(
    new ConnectError("hub runtime draining", Code.Unavailable),
    503,
    "unavailable",
  );
  const timer = setTimeout(() => reject(
    new ConnectError("request deadline exceeded", Code.DeadlineExceeded),
    504,
    "deadline_exceeded",
  ), input.deadline);
  timer.unref();
  input.response.once("finish", responseFinished);
  input.response.once("close", responseClosed);
  input.response.once("error", canceled);
  input.request.once("aborted", canceled);
  input.request.once("error", canceled);
  input.request.once("close", requestClosed);
  unregisterShutdown = input.shutdown.register(shutdown);
  return Object.freeze({
    signal: controller.signal,
    assertDispatchable: () => {
      if (input.request.stream.rstCode !== 0 || input.response.destroyed ||
          input.response.writableEnded) {
        throw new ConnectError("request canceled", Code.Canceled);
      }
      dispatched = true;
    },
  });
}

function rawConnectError(
  request: Http2ServerRequest,
  response: Http2ServerResponse,
  status: number,
  code: string,
  message: string,
  closed: () => void = () => undefined,
): void {
  if (response.destroyed || response.writableEnded) {
    closeInbound(request, closed);
    return;
  }
  let active = true;
  const finish = () => {
    if (!active) return;
    active = false;
    response.off("error", finish);
    closeInbound(request, closed);
  };
  response.once("error", finish);
  try {
    response.statusCode = status;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ code, message }), finish);
  } catch {
    finish();
  }
}

function closeInbound(request: Http2ServerRequest, closed: () => void): void {
  const stream = request.stream;
  if (stream.closed || stream.destroyed) {
    closed();
    return;
  }
  try {
    stream.close(http2Constants.NGHTTP2_NO_ERROR, closed);
  } catch {
    try { stream.destroy(); } catch { /* terminal cleanup is still complete */ }
    closed();
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason instanceof ConnectError) throw signal.reason;
  throw new ConnectError("request canceled", Code.Canceled);
}

function shutdownFanout(signal: AbortSignal): Readonly<{
  register(listener: () => void): () => void;
}> {
  const listeners = new Set<() => void>();
  let aborted = signal.aborted;
  const abort = () => {
    if (aborted) return;
    aborted = true;
    for (const listener of [...listeners]) listener();
    listeners.clear();
  };
  if (!aborted) signal.addEventListener("abort", abort, { once: true });
  return Object.freeze({
    register(listener: () => void): () => void {
      if (aborted) {
        listener();
        return () => undefined;
      }
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  });
}

function requestCapacity(): Readonly<{ acquire(identity: string): (() => void) | null }> {
  let total = 0;
  const byPeer = new Map<string, number>();
  return Object.freeze({
    acquire(identity: string): (() => void) | null {
      const peer = byPeer.get(identity) ?? 0;
      if (total >= HUB_CONNECT_MAX_IN_FLIGHT || peer >= HUB_CONNECT_MAX_IN_FLIGHT_PER_PEER) {
        return null;
      }
      total += 1;
      byPeer.set(identity, peer + 1);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        total -= 1;
        const remaining = (byPeer.get(identity) ?? 1) - 1;
        if (remaining === 0) byPeer.delete(identity);
        else byPeer.set(identity, remaining);
      };
    },
  });
}

function authenticate(
  request: Http2ServerRequest,
  peers: readonly Readonly<{ identity: string; fingerprint256: string; sanUri: string }>[],
): HubConnectCaller | null {
  const socket = request.socket;
  if (!(socket instanceof TLSSocket) || socket.authorized !== true || socket.authorizationError != null) return null;
  const certificate = socket.getPeerCertificate();
  const now = Date.now();
  const validFrom = Date.parse(certificate.valid_from);
  const validTo = Date.parse(certificate.valid_to);
  if (!certificate.fingerprint256 || !certificate.subjectaltname || !Number.isFinite(validFrom) ||
      !Number.isFinite(validTo) || validFrom > now || validTo <= now) return null;
  const sanUris = certificate.subjectaltname.split(/,\s*/u)
    .filter((entry) => entry.startsWith("URI:"))
    .map((entry) => entry.slice(4));
  const peer = peers.find((candidate) => candidate.fingerprint256 === certificate.fingerprint256 &&
    sanUris.includes(candidate.sanUri));
  return peer === undefined ? null : Object.freeze({ identity: peer.identity });
}
