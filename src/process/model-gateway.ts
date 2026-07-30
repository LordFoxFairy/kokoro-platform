import type { Http2SecureServer } from "node:http2";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createPostgresModelGatewayDatabase,
  loadModelGatewayDatabaseConfig,
  type PostgresModelGatewayDatabase,
} from "../modules/model-gateway/infrastructure/postgres/model-gateway-database.js";
import {
  createModelGatewayProductionComposition,
  type ModelGatewayProductionComposition,
  type ModelGatewayRequestListener,
} from "./model-gateway-composition.js";

export type PlatformModelGatewayProcessState =
  "stopped" | "starting" | "running" | "draining" | "failed";

export interface PlatformModelGatewayProcess {
  start(address?: Readonly<{ host: string; port: number }>): Promise<string>;
  shutdown(options?: Readonly<{ deadlineMs?: number }>): Promise<void>;
  status(): Readonly<{
    state: PlatformModelGatewayProcessState;
    live: boolean;
    ready: boolean;
    draining: boolean;
    inFlight: number;
  }>;
}

export function createPlatformModelGatewayProcess(options: Readonly<{
  database: Pick<PostgresModelGatewayDatabase, "connect" | "disconnect" | "checkHealth">;
  composition: ModelGatewayProductionComposition;
  onFatalError?: (error: Error) => void;
}>): PlatformModelGatewayProcess {
  let state: PlatformModelGatewayProcessState = "stopped";
  let ready = false;
  let connected = false;
  let server: Http2SecureServer | undefined;
  let startPromise: Promise<string> | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const runtime: PlatformModelGatewayProcess = {
    start(address = { host: "0.0.0.0", port: 4247 }) {
      validateAddress(address);
      if (state !== "stopped" || startPromise !== undefined) {
        return Promise.reject(new Error("PLATFORM_MODEL_GATEWAY_NOT_STOPPED"));
      }
      state = "starting";
      startPromise = start(address).finally(() => { startPromise = undefined; });
      return startPromise;
    },
    shutdown({ deadlineMs = 10_000 } = {}) {
      if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000) {
        return Promise.reject(new Error("PLATFORM_MODEL_GATEWAY_SHUTDOWN_DEADLINE_INVALID"));
      }
      if (state === "stopped" && startPromise === undefined) return Promise.resolve();
      if (shutdownPromise !== undefined) return shutdownPromise;
      state = "draining";
      ready = false;
      shutdownPromise = (async () => {
        const deadlineAt = Date.now() + deadlineMs;
        await settlesWithin(startPromise, remaining(deadlineAt));
        const active = server;
        let stopped = active === undefined
          ? true
          : await close(active, Math.min(remaining(deadlineAt), Math.max(1, Math.floor(deadlineMs * 0.8))));
        if (!stopped) {
          options.composition.abortInFlight("MODEL_GATEWAY_SHUTDOWN_DEADLINE");
          stopped = active === undefined ? true : await close(active, remaining(deadlineAt));
        }
        const effectsStopped = await settlesWithin(
          options.composition.shutdownProviderEffects(Math.max(1, remaining(deadlineAt))),
          remaining(deadlineAt),
        );
        server = undefined;
        const disconnected = connected
          ? await settlesWithin(options.database.disconnect(), remaining(deadlineAt))
          : true;
        connected = false;
        if (!stopped || !effectsStopped || !disconnected) {
          state = "failed";
          throw new Error("PLATFORM_MODEL_GATEWAY_SHUTDOWN_UNCONFIRMED");
        }
        state = "stopped";
      })();
      return shutdownPromise;
    },
    status: () => Object.freeze({
      state,
      live: state === "running" || state === "draining",
      ready: state === "running" && ready,
      draining: state === "draining",
      inFlight: options.composition.inFlightCount() + options.composition.activeProviderEffectCount(),
    }),
  };

  async function start(address: Readonly<{ host: string; port: number }>): Promise<string> {
    try {
      await options.database.connect();
      connected = true;
      await options.database.checkHealth();
      if (state !== "starting") throw new Error("PLATFORM_MODEL_GATEWAY_START_ABORTED");
      options.composition.startBackground();
      server = options.composition.createServer(listener(options.database, options.composition, () => state));
      server.on("error", (cause) => {
        if (state !== "running") return;
        ready = false;
        state = "failed";
        options.onFatalError?.(cause);
        void runtime.shutdown().catch(() => undefined);
      });
      await listen(server, address);
      if (state !== "starting") throw new Error("PLATFORM_MODEL_GATEWAY_START_ABORTED");
      state = "running";
      ready = true;
      const bound = server.address();
      if (bound === null || typeof bound === "string") throw new Error("PLATFORM_MODEL_GATEWAY_ADDRESS_UNAVAILABLE");
      return `https://${address.host}:${bound.port}`;
    } catch (error) {
      ready = false;
      server = undefined;
      await options.composition.shutdownProviderEffects(5_000).catch(() => undefined);
      if (connected) await options.database.disconnect().catch(() => undefined);
      connected = false;
      if (state === "starting") state = "stopped";
      throw error;
    }
  }
  return runtime;
}

function listener(
  database: Pick<PostgresModelGatewayDatabase, "checkHealth">,
  composition: ModelGatewayProductionComposition,
  state: () => PlatformModelGatewayProcessState,
): ModelGatewayRequestListener {
  return (request, response) => {
    response.setHeader("cache-control", "no-store");
    if (request.method === "GET" && request.url === "/health/live") {
      const live = state() === "running" || state() === "draining";
      response.statusCode = live ? 200 : 503;
      response.end(JSON.stringify({ status: live ? "live" : "not_live" }));
      return;
    }
    if (request.method === "GET" && request.url === "/health/ready") {
      response.setHeader("content-type", "application/json");
      if (state() !== "running") {
        response.statusCode = 503;
        response.end('{"status":"not_ready"}');
        return;
      }
      void database.checkHealth().then(
        () => { if (!response.destroyed) { response.statusCode = 200; response.end('{"status":"ready"}'); } },
        () => { if (!response.destroyed) { response.statusCode = 503; response.end('{"status":"database_unavailable"}'); } },
      );
      return;
    }
    if (state() !== "running") {
      response.statusCode = 503;
      response.end('{"error":{"code":"draining"}}');
      return;
    }
    composition.handler(request, response);
  };
}

export async function runPlatformModelGatewayMain(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const database = createPostgresModelGatewayDatabase(loadModelGatewayDatabaseConfig(environment));
  const composition = await createModelGatewayProductionComposition({ database, environment });
  const runtime = createPlatformModelGatewayProcess({
    database,
    composition,
    onFatalError: (error) => { process.exitCode = 1; console.error("Platform Model Gateway failed", error); },
  });
  const shutdown = () => void runtime.shutdown().catch((error: unknown) => {
    process.exitCode = 1;
    console.error("Platform Model Gateway failed to drain", error);
  });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    const address = await runtime.start({
      host: "0.0.0.0",
      port: boundedPort(environment.PLATFORM_MODEL_GATEWAY_PORT ?? "4247"),
    });
    console.log(`Platform Model Gateway listening at ${address}`);
  } catch (error) {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await runtime.shutdown().catch(() => undefined);
    throw error;
  }
}

function listen(server: Http2SecureServer, address: Readonly<{ host: string; port: number }>): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(address.port, address.host, () => { server.off("error", failed); resolveListen(); });
  });
}
function close(server: Http2SecureServer, deadlineMs: number): Promise<boolean> {
  if (deadlineMs <= 0) return Promise.resolve(false);
  return new Promise((resolveClose) => {
    const timer = setTimeout(() => resolveClose(false), deadlineMs);
    timer.unref();
    try {
      server.close(() => { clearTimeout(timer); resolveClose(true); });
    } catch (error) {
      clearTimeout(timer);
      resolveClose((error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING");
    }
  });
}
async function settlesWithin(promise: Promise<unknown> | undefined, timeoutMs: number): Promise<boolean> {
  if (promise === undefined) return true;
  if (timeoutMs <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => false),
      new Promise<false>((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(false), timeoutMs); timer.unref(); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
function remaining(deadlineAt: number): number { return Math.max(0, deadlineAt - Date.now()); }
function validateAddress(address: Readonly<{ host: string; port: number }>): void {
  if (address.host.length < 1 || address.host.length > 253 || address.host.trim() !== address.host ||
      !Number.isInteger(address.port) || address.port < 1 || address.port > 65_535) {
    throw new Error("PLATFORM_MODEL_GATEWAY_ADDRESS_INVALID");
  }
}
function boundedPort(value: string): number {
  if (!/^[1-9][0-9]{0,4}$/u.test(value)) throw new Error("PLATFORM_MODEL_GATEWAY_PORT_INVALID");
  const parsed = Number(value);
  if (parsed > 65_535) throw new Error("PLATFORM_MODEL_GATEWAY_PORT_INVALID");
  return parsed;
}
function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}
if (isMainModule()) {
  await runPlatformModelGatewayMain().catch((error: unknown) => {
    process.exitCode = 1;
    console.error("Platform Model Gateway failed to start", error);
  });
}
