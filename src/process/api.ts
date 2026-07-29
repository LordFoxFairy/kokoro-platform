import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createPlatformDatabaseClient,
  loadPlatformDatabaseConfig,
  type PlatformDatabaseClient,
} from "../infrastructure/postgres/client.js";

export type PlatformProcessState = "stopped" | "starting" | "running" | "draining" | "failed";

export interface PlatformApiProcessStatus {
  readonly state: PlatformProcessState;
  readonly live: boolean;
  readonly ready: boolean;
  readonly draining: boolean;
}

export interface PlatformApiProcess {
  start(address?: { host: string; port: number }): Promise<string>;
  shutdown(options?: { deadlineMs?: number }): Promise<void>;
  status(): PlatformApiProcessStatus;
}

export function createPlatformApiProcess(options: {
  database: PlatformDatabaseClient;
}): PlatformApiProcess {
  const { database } = options;
  let state: PlatformProcessState = "stopped";
  let ready = false;
  let server: Server | undefined;
  let databaseConnected = false;
  let startPromise: Promise<string> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const currentState = (): PlatformProcessState => state;

  const api: PlatformApiProcess = {
    start(address = { host: "0.0.0.0", port: 4100 }) {
      if (state !== "stopped" || startPromise) {
        return Promise.reject(new Error("PLATFORM_API_NOT_STOPPED"));
      }
      state = "starting";
      ready = false;
      shutdownPromise = undefined;
      startPromise = startApi(address).finally(() => {
        startPromise = undefined;
      });
      return startPromise;
    },

    shutdown({ deadlineMs = 10_000 } = {}) {
      if (state === "stopped" && !startPromise) return Promise.resolve();
      if (shutdownPromise) return shutdownPromise;
      state = "draining";
      ready = false;
      const deadlineAt = Date.now() + deadlineMs;
      shutdownPromise = (async () => {
        const observedStart = startPromise?.then(
          () => undefined,
          () => undefined,
        );
        const startStopped = await settlesWithin(observedStart, remaining(deadlineAt));
        const activeServer = server;
        let serverStopped = true;
        if (activeServer) {
          activeServer.closeIdleConnections();
          serverStopped = await closeWithDeadline(activeServer, remaining(deadlineAt));
          if (!serverStopped) activeServer.closeAllConnections();
          server = undefined;
        }
        let databaseStopped = true;
        if (databaseConnected) {
          databaseStopped = await settlesWithin(database.disconnect(), remaining(deadlineAt));
          databaseConnected = false;
        }
        if (startStopped && serverStopped && databaseStopped) {
          state = "stopped";
          return;
        }
        state = "failed";
        throw new Error("PLATFORM_API_SHUTDOWN_UNCONFIRMED");
      })();
      return shutdownPromise;
    },

    status: () => ({
      state,
      live: state === "running" || state === "draining",
      ready: state === "running" && ready,
      draining: state === "draining",
    }),
  };

  async function startApi(address: { host: string; port: number }): Promise<string> {
    try {
      await database.connect();
      databaseConnected = true;
      if (currentState() !== "starting") throw new Error("PLATFORM_API_START_ABORTED");
      await database.checkHealth();
      if (currentState() !== "starting") throw new Error("PLATFORM_API_START_ABORTED");

      server = createServer(async (request, response) => {
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.setHeader("cache-control", "no-store");
        if (request.method === "GET" && request.url === "/health/live") {
          response.statusCode = state === "running" || state === "draining" ? 200 : 503;
          response.end(JSON.stringify({ state }));
          return;
        }
        if (request.method === "GET" && request.url === "/health/ready") {
          if (state !== "running") {
            response.statusCode = 503;
            response.end(JSON.stringify({ status: "not_ready", state }));
            return;
          }
          try {
            await database.checkHealth();
            ready = true;
            response.statusCode = 200;
            response.end(JSON.stringify({ status: "ready" }));
          } catch {
            ready = false;
            response.statusCode = 503;
            response.end(JSON.stringify({ status: "database_unavailable" }));
          }
          return;
        }
        response.statusCode = state === "draining" ? 503 : 404;
        response.end(JSON.stringify({ error: state === "draining" ? "draining" : "not_found" }));
      });

      await listen(server, address);
      if (currentState() !== "starting") throw new Error("PLATFORM_API_START_ABORTED");
      state = "running";
      ready = true;
      const bound = server.address();
      if (!bound || typeof bound === "string") throw new Error("PLATFORM_API_ADDRESS_UNAVAILABLE");
      return `http://${address.host}:${bound.port}`;
    } catch (error) {
      ready = false;
      const failedServer = server;
      server = undefined;
      if (failedServer?.listening)
        await closeWithDeadline(failedServer, 1_000).catch(() => false);
      if (databaseConnected) {
        await database.disconnect();
        databaseConnected = false;
      }
      if (currentState() === "starting") state = "stopped";
      throw error;
    }
  }

  return api;
}

function listen(server: Server, address: { host: string; port: number }): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(address.port, address.host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}

function closeWithDeadline(server: Server, deadlineMs: number): Promise<boolean> {
  if (deadlineMs <= 0) return Promise.resolve(false);
  return new Promise((resolveClose, reject) => {
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      resolveClose(false);
    }, deadlineMs);
    deadline.unref();
    server.close((error) => {
      clearTimeout(deadline);
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ERR_SERVER_NOT_RUNNING") {
        return resolveClose(true);
      }
      return error ? reject(error) : resolveClose(true);
    });
  });
}

async function settlesWithin(
  promise: Promise<unknown> | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (!promise) return true;
  if (timeoutMs <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => false,
      ),
      new Promise<false>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function remaining(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now());
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}

export async function runPlatformApiMain(): Promise<void> {
  const database = createPlatformDatabaseClient(loadPlatformDatabaseConfig("api"));
  const api = createPlatformApiProcess({ database });
  const port = Number.parseInt(process.env.PLATFORM_API_PORT ?? "4100", 10);
  const shutdown = () => {
    void api.shutdown().catch((error: unknown) => {
      process.exitCode = 1;
      console.error("Platform API failed to drain", error);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  const address = await api.start({ host: "0.0.0.0", port });
  console.log(`Platform API listening at ${address}`);
}

if (isMainModule()) {
  runPlatformApiMain().catch((error: unknown) => {
    process.exitCode = 1;
    console.error("Platform API failed to start", error);
  });
}
