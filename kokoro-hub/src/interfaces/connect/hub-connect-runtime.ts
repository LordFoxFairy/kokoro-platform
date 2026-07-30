import { AsyncLocalStorage } from "node:async_hooks";
import { createSecureServer, type Http2SecureServer, type SecureServerOptions } from "node:http2";
import type { Http2ServerRequest, Http2ServerResponse } from "node:http2";
import { TLSSocket } from "node:tls";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { HubCatalogService, HubRuntimeService } from
  "./generated-capability-catalog/kokoro/platform/capability/v1/capability_catalog_pb.js";
import type { HubCatalogConnectService, HubRuntimeConnectService } from
  "./capability-catalog-services.js";

export interface HubConnectCaller { readonly identity: string }

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
}>): HubConnectRuntime {
  if (input.peers.length < 2 || input.peers.length > 16) throw new Error("HUB_CONNECT_PEERS_INVALID");
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
    maxTimeoutMs: 5_000,
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
    input.callers.run(caller, () => {
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
