import type { RequestListener, ServerResponse } from "node:http";
import type { Server } from "node:https";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createPlatformDatabaseClient,
  loadPlatformDatabaseConfig,
  type PlatformDatabaseClient,
} from "../infrastructure/postgres/client.js";
import {
  createAssetDataPlaneProductionComposition,
  type AssetDataPlaneProductionComposition,
} from "./asset-data-plane-composition.js";

export type AssetDataPlaneProcessState =
  | "stopped"
  | "starting"
  | "running"
  | "draining"
  | "failed";

export interface AssetDataPlaneProcessStatus {
  readonly state: AssetDataPlaneProcessState;
  readonly live: boolean;
  readonly ready: boolean;
  readonly draining: boolean;
}

export interface AssetDataPlaneProcess {
  start(address?: Readonly<{ host: string; port: number }>): Promise<string>;
  shutdown(options?: Readonly<{ deadlineMs?: number }>): Promise<void>;
  status(): AssetDataPlaneProcessStatus;
}

export function createAssetDataPlaneProcess(options: Readonly<{
  database: PlatformDatabaseClient;
  composition: AssetDataPlaneProductionComposition;
}>): AssetDataPlaneProcess {
  let state: AssetDataPlaneProcessState = "stopped";
  let ready = false;
  let databaseConnected = false;
  let server: Server | undefined;
  let startPromise: Promise<string> | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const processHost: AssetDataPlaneProcess = {
    start(address = { host: "0.0.0.0", port: 4246 }) {
      validateAddress(address);
      if (state !== "stopped" || startPromise !== undefined) {
        return Promise.reject(new Error("ASSET_DATA_PLANE_NOT_STOPPED"));
      }
      state = "starting";
      ready = false;
      shutdownPromise = undefined;
      startPromise = start(address).finally(() => { startPromise = undefined; });
      return startPromise;
    },

    shutdown({ deadlineMs = 10_000 } = {}) {
      if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000) {
        return Promise.reject(new Error("ASSET_DATA_PLANE_SHUTDOWN_DEADLINE_INVALID"));
      }
      if (state === "stopped" && startPromise === undefined) return Promise.resolve();
      if (shutdownPromise !== undefined) return shutdownPromise;
      state = "draining";
      ready = false;
      const deadlineAt = Date.now() + deadlineMs;
      shutdownPromise = (async () => {
        const observedStart = startPromise?.then(() => undefined, () => undefined);
        const startStopped = await settlesWithin(observedStart, remaining(deadlineAt));
        const activeServer = server;
        activeServer?.closeIdleConnections();
        const serverStopped = activeServer === undefined
          ? true
          : await closeServer(activeServer, remaining(deadlineAt));
        if (!serverStopped) activeServer?.closeAllConnections();
        server = undefined;
        const databaseStopped = databaseConnected
          ? await settlesWithin(options.database.disconnect(), remaining(deadlineAt))
          : true;
        databaseConnected = false;
        if (startStopped && serverStopped && databaseStopped) {
          state = "stopped";
          return;
        }
        state = "failed";
        throw new Error("ASSET_DATA_PLANE_SHUTDOWN_UNCONFIRMED");
      })();
      return shutdownPromise;
    },

    status: () => Object.freeze({
      state,
      live: state === "running" || state === "draining",
      ready: state === "running" && ready,
      draining: state === "draining",
    }),
  };

  async function start(address: Readonly<{ host: string; port: number }>): Promise<string> {
    try {
      await options.database.connect();
      databaseConnected = true;
      if (state !== "starting") throw new Error("ASSET_DATA_PLANE_START_ABORTED");
      await options.database.checkHealth();
      if (state !== "starting") throw new Error("ASSET_DATA_PLANE_START_ABORTED");
      server = options.composition.createServer(
        createListener(options.database, options.composition, () => state),
      );
      await listen(server, address);
      if (state !== "starting") throw new Error("ASSET_DATA_PLANE_START_ABORTED");
      state = "running";
      ready = true;
      const bound = server.address();
      if (bound === null || typeof bound === "string") {
        throw new Error("ASSET_DATA_PLANE_ADDRESS_UNAVAILABLE");
      }
      return `https://${address.host}:${bound.port}`;
    } catch (error) {
      ready = false;
      const failedServer = server;
      server = undefined;
      if (failedServer !== undefined) await closeServer(failedServer, 1_000).catch(() => false);
      if (databaseConnected) {
        await options.database.disconnect();
        databaseConnected = false;
      }
      if (state === "starting") state = "stopped";
      throw error;
    }
  }

  return processHost;
}

function createListener(
  database: PlatformDatabaseClient,
  composition: AssetDataPlaneProductionComposition,
  state: () => AssetDataPlaneProcessState,
): RequestListener {
  return (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    if (request.method === "GET" && request.url === "/health/live") {
      const live = state() === "running" || state() === "draining";
      sendJson(response, live ? 200 : 503, { status: live ? "live" : "not_live" });
      return;
    }
    if (request.method === "GET" && request.url === "/health/ready") {
      if (state() !== "running") {
        sendJson(response, 503, { status: "not_ready" });
        return;
      }
      void database.checkHealth().then(
        () => {
          if (response.destroyed) return;
          if (state() !== "running") sendJson(response, 503, { status: "not_ready" });
          else sendJson(response, 200, { status: "ready" });
        },
        () => {
          if (response.destroyed) return;
          if (state() !== "running") sendJson(response, 503, { status: "not_ready" });
          else sendJson(response, 503, { status: "database_unavailable" });
        },
      );
      return;
    }
    if (state() !== "running") {
      sendJson(response, 503, { status: "draining" });
      return;
    }
    void composition.handler.handle(request, response).then(
      (handled) => {
        if (!handled && !response.headersSent) sendJson(response, 404, { error: "not_found" });
      },
      () => {
        if (!response.headersSent) sendJson(response, 503, { error: "unavailable" });
        else response.destroy();
      },
    );
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function listen(
  server: Server,
  address: Readonly<{ host: string; port: number }>,
): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(address.port, address.host, () => {
      server.off("error", failed);
      resolveListen();
    });
  });
}

function closeServer(server: Server, deadlineMs: number): Promise<boolean> {
  if (deadlineMs <= 0) return Promise.resolve(false);
  return new Promise((resolveClose) => {
    const deadline = setTimeout(() => resolveClose(false), deadlineMs);
    deadline.unref();
    try {
      server.close(() => {
        clearTimeout(deadline);
        resolveClose(true);
      });
    } catch (error) {
      clearTimeout(deadline);
      resolveClose((error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING");
    }
  });
}

async function settlesWithin(
  promise: Promise<unknown> | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (promise === undefined) return true;
  if (timeoutMs <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => false),
      new Promise<false>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function remaining(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now());
}

function validateAddress(address: Readonly<{ host: string; port: number }>): void {
  if (
    address.host.length < 1 || address.host.length > 253 || address.host.trim() !== address.host ||
    !Number.isInteger(address.port) || address.port < 1 || address.port > 65_535
  ) throw new Error("ASSET_DATA_PLANE_ADDRESS_INVALID");
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}

export async function runAssetDataPlaneMain(): Promise<void> {
  const database = createPlatformDatabaseClient(loadPlatformDatabaseConfig("api"));
  const composition = await createAssetDataPlaneProductionComposition({ database });
  const processHost = createAssetDataPlaneProcess({ database, composition });
  const port = Number.parseInt(process.env.PLATFORM_ASSET_DATA_PLANE_PORT ?? "4246", 10);
  const shutdown = () => {
    void processHost.shutdown().catch((error: unknown) => {
      process.exitCode = 1;
      console.error("Asset data plane failed to drain", error);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  const address = await processHost.start({ host: "0.0.0.0", port });
  console.log(`Asset data plane listening at ${address}`);
}

if (isMainModule()) {
  await runAssetDataPlaneMain().catch((error: unknown) => {
    process.exitCode = 1;
    console.error("Asset data plane failed to start", error);
  });
}
