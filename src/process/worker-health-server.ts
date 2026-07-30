import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PlatformWorkerProcessStatus } from "./worker.js";

export interface PlatformWorkerHealthServer {
  start(): Promise<string>;
  close(): Promise<void>;
}

export function createPlatformWorkerHealthServer(input: Readonly<{
  status: () => PlatformWorkerProcessStatus;
  host?: string;
  port: number;
}>): PlatformWorkerHealthServer {
  const host = input.host ?? "0.0.0.0";
  let server: Server | undefined;

  return Object.freeze({
    async start() {
      if (server !== undefined) throw new Error("PLATFORM_WORKER_HEALTH_ALREADY_STARTED");
      const next = createServer((request, response) => {
        response.setHeader("cache-control", "no-store");
        response.setHeader("content-type", "application/json; charset=utf-8");
        if (request.method !== "GET") {
          response.writeHead(405, { allow: "GET" });
          response.end(JSON.stringify({ status: "method_not_allowed" }));
          return;
        }
        const status = input.status();
        const available = request.url === "/health/live"
          ? status.live
          : request.url === "/health/ready"
            ? status.ready
            : undefined;
        if (available === undefined) {
          response.writeHead(404);
          response.end(JSON.stringify({ status: "not_found" }));
          return;
        }
        response.writeHead(available ? 200 : 503);
        response.end(JSON.stringify({
          status: available ? "ok" : "unavailable",
          state: status.state,
          draining: status.draining,
        }));
      });
      next.headersTimeout = 5_000;
      next.requestTimeout = 5_000;
      next.keepAliveTimeout = 1_000;
      next.maxHeadersCount = 32;
      server = next;
      await new Promise<void>((resolveStart, rejectStart) => {
        next.once("error", rejectStart);
        next.listen(input.port, host, () => {
          next.off("error", rejectStart);
          resolveStart();
        });
      });
      const address = next.address() as AddressInfo;
      return `http://${address.address}:${address.port}`;
    },

    async close() {
      const current = server;
      server = undefined;
      if (current === undefined || !current.listening) return;
      current.closeIdleConnections();
      await new Promise<void>((resolveClose, rejectClose) => {
        current.close((error) => error ? rejectClose(error) : resolveClose());
      });
    },
  });
}

export function loadPlatformWorkerHealthPort(
  environment: Readonly<Record<string, string | undefined>>,
): number {
  const raw = environment.PLATFORM_WORKER_HEALTH_PORT ?? "4190";
  if (!/^[0-9]{1,5}$/u.test(raw)) throw new Error("PLATFORM_WORKER_HEALTH_PORT_INVALID");
  const port = Number.parseInt(raw, 10);
  if (port < 1 || port > 65_535) throw new Error("PLATFORM_WORKER_HEALTH_PORT_INVALID");
  return port;
}
