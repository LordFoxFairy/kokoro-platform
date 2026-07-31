import { createServer as createHttpServer, type RequestListener, type Server as HttpServer,
  type ServerResponse } from "node:http";
import type { Server as HttpsServer } from "node:https";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createArtifactDataPlaneProductionComposition,
  type ArtifactDataPlaneProductionComposition,
} from "./artifact-data-plane-composition.js";
import {
  createArtifactDataPlaneDatabase,
  loadArtifactDataPlaneDatabaseConfig,
  type ArtifactDataPlaneDatabase,
} from "./artifact-data-plane-database.js";

export type ArtifactDataPlaneProcessState = "stopped" | "starting" | "running" | "draining" | "failed";

export interface ArtifactDataPlaneProcess {
  start(address?: Readonly<{ host: string; port: number }>,
    healthAddress?: Readonly<{ host: string; port: number }>): Promise<string>;
  shutdown(options?: Readonly<{ deadlineMs?: number }>): Promise<void>;
  status(): Readonly<{
    state: ArtifactDataPlaneProcessState;
    live: boolean;
    ready: boolean;
    draining: boolean;
  }>;
}

export function createArtifactDataPlaneProcess(input: Readonly<{
  database: Pick<ArtifactDataPlaneDatabase, "connect" | "checkHealth" | "disconnect">;
  composition: ArtifactDataPlaneProductionComposition;
  healthServerFactory?: (listener: RequestListener) => HttpServer;
}>): ArtifactDataPlaneProcess {
  let state: ArtifactDataPlaneProcessState = "stopped";
  let ready = false;
  let databaseConnected = false;
  let server: HttpsServer | undefined;
  let healthServer: HttpServer | undefined;
  let startPromise: Promise<string> | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const host: ArtifactDataPlaneProcess = {
    start(address = { host: "0.0.0.0", port: 4248 },
      healthAddress = { host: address.host, port: address.port === 0 ? 0 : 4249 }) {
      validateAddress(address);
      validateAddress(healthAddress);
      if (state !== "stopped" || startPromise !== undefined) {
        return Promise.reject(new Error("ARTIFACT_DATA_PLANE_NOT_STOPPED"));
      }
      state = "starting";
      ready = false;
      shutdownPromise = undefined;
      startPromise = start(address, healthAddress).finally(() => { startPromise = undefined; });
      return startPromise;
    },
    shutdown({ deadlineMs = 10_000 } = {}) {
      if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000) {
        return Promise.reject(new Error("ARTIFACT_DATA_PLANE_SHUTDOWN_DEADLINE_INVALID"));
      }
      if (state === "stopped" && startPromise === undefined) return Promise.resolve();
      if (shutdownPromise !== undefined) return shutdownPromise;
      state = "draining";
      ready = false;
      const deadlineAt = Date.now() + deadlineMs;
      shutdownPromise = (async () => {
        const startStopped = await settlesWithin(startPromise, remaining(deadlineAt));
        const active = server;
        const activeHealth = healthServer;
        active?.closeIdleConnections();
        activeHealth?.closeIdleConnections();
        const stopped = await Promise.all([
          active === undefined ? Promise.resolve(true) : closeServer(active, remaining(deadlineAt)),
          activeHealth === undefined ? Promise.resolve(true) : closeServer(activeHealth, remaining(deadlineAt)),
        ]);
        const listenerStopped = stopped.every(Boolean);
        if (!listenerStopped) { active?.closeAllConnections(); activeHealth?.closeAllConnections(); }
        server = undefined;
        healthServer = undefined;
        const runtimeStopped = await settlesWithin(input.composition.close(), remaining(deadlineAt));
        const databaseStopped = databaseConnected
          ? await settlesWithin(input.database.disconnect(), remaining(deadlineAt)) : true;
        databaseConnected = false;
        if (startStopped && listenerStopped && runtimeStopped && databaseStopped) {
          state = "stopped";
          return;
        }
        state = "failed";
        throw new Error("ARTIFACT_DATA_PLANE_SHUTDOWN_UNCONFIRMED");
      })();
      return shutdownPromise;
    },
    status: () => Object.freeze({ state,
      live: state === "running" || state === "draining",
      ready: state === "running" && ready,
      draining: state === "draining" }),
  };

  async function start(address: Readonly<{ host: string; port: number }>,
    healthAddress: Readonly<{ host: string; port: number }>): Promise<string> {
    try {
      await input.database.connect();
      databaseConnected = true;
      await input.database.checkHealth();
      await input.composition.checkHealth();
      if (state !== "starting") throw new Error("ARTIFACT_DATA_PLANE_START_ABORTED");
      const health = (input.healthServerFactory ?? createHttpServer)(
        createHealthListener(input.composition, () => state),
      );
      healthServer = health;
      await listen(health, healthAddress);
      const created = input.composition.createServer(createSecureListener(input.composition, () => state));
      server = created;
      await listen(created, address);
      if (state !== "starting") throw new Error("ARTIFACT_DATA_PLANE_START_ABORTED");
      state = "running";
      ready = true;
      const bound = created.address();
      if (bound === null || typeof bound === "string") throw new Error("ARTIFACT_DATA_PLANE_ADDRESS_UNAVAILABLE");
      return `https://${address.host}:${bound.port}`;
    } catch (error) {
      ready = false;
      const failed = server;
      const failedHealth = healthServer;
      server = undefined;
      healthServer = undefined;
      if (failed !== undefined) await closeServer(failed, 1_000).catch(() => false);
      if (failedHealth !== undefined) await closeServer(failedHealth, 1_000).catch(() => false);
      if (databaseConnected) {
        await input.database.disconnect().catch(() => undefined);
        databaseConnected = false;
      }
      if (state === "starting") state = "stopped";
      throw error;
    }
  }
  return host;
}

function createSecureListener(
  composition: ArtifactDataPlaneProductionComposition,
  state: () => ArtifactDataPlaneProcessState,
): RequestListener {
  return (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    if (state() !== "running") { sendJson(response, 503, { status: "draining" }); return; }
    void composition.handler.handle(request, response).then(
      (handled) => { if (!handled && !response.headersSent) sendJson(response, 404, { error: "not_found" }); },
      (error: unknown) => {
        if (!response.headersSent) sendJson(response, 503, { error: "unavailable" });
        else response.destroy(error instanceof Error ? error : undefined);
      },
    );
  };
}

function createHealthListener(
  composition: ArtifactDataPlaneProductionComposition,
  state: () => ArtifactDataPlaneProcessState,
): RequestListener {
  return (request, response) => {
    response.setHeader("cache-control", "no-store");
    if (request.method === "GET" && request.url === "/health/live") {
      const live = state() === "running" || state() === "draining";
      sendJson(response, live ? 200 : 503, { status: live ? "live" : "not_live" });
      return;
    }
    if (request.method === "GET" && request.url === "/health/ready") {
      if (state() !== "running") { sendJson(response, 503, { status: "not_ready" }); return; }
      void composition.checkHealth().then(
        () => { if (!response.destroyed) sendJson(response,
          state() === "running" ? 200 : 503, { status: state() === "running" ? "ready" : "not_ready" }); },
        () => { if (!response.destroyed) sendJson(response, 503, { status: "owner_unavailable" }); },
      );
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function listen(server: HttpServer | HttpsServer, address: Readonly<{ host: string; port: number }>): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(address.port, address.host, () => { server.off("error", failed); resolveListen(); });
  });
}

function closeServer(server: HttpServer | HttpsServer, deadlineMs: number): Promise<boolean> {
  if (deadlineMs <= 0) return Promise.resolve(false);
  return new Promise((resolveClose) => {
    const deadline = setTimeout(() => resolveClose(false), deadlineMs);
    deadline.unref();
    try {
      server.close(() => { clearTimeout(deadline); resolveClose(true); });
    } catch (error) {
      clearTimeout(deadline);
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
      new Promise<false>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs); timer.unref();
      }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function remaining(deadlineAt: number): number { return Math.max(0, deadlineAt - Date.now()); }

function validateAddress(address: Readonly<{ host: string; port: number }>): void {
  if (address.host.length < 1 || address.host.length > 253 || address.host.trim() !== address.host ||
      !Number.isInteger(address.port) || address.port < 1 || address.port > 65_535) {
    throw new Error("ARTIFACT_DATA_PLANE_ADDRESS_INVALID");
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}

export async function runArtifactDataPlaneMain(): Promise<void> {
  const database = createArtifactDataPlaneDatabase(loadArtifactDataPlaneDatabaseConfig());
  const composition = await createArtifactDataPlaneProductionComposition({ database });
  const processHost = createArtifactDataPlaneProcess({ database, composition });
  const port = Number.parseInt(process.env.PLATFORM_ARTIFACT_DATA_PLANE_PORT ?? "4248", 10);
  const shutdown = () => { void processHost.shutdown().catch((error: unknown) => {
    process.exitCode = 1; console.error("Artifact data plane failed to drain", error);
  }); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  console.log(`Artifact data plane listening at ${await processHost.start({ host: "0.0.0.0", port })}`);
}

if (isMainModule()) {
  await runArtifactDataPlaneMain().catch((error: unknown) => {
    process.exitCode = 1; console.error("Artifact data plane failed to start", error);
  });
}
