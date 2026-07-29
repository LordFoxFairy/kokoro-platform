import type {
  Http2SecureServer,
  ServerHttp2Session,
} from "node:http2";
import type { PlatformDatabaseClient } from "../infrastructure/postgres/client.js";
import type {
  AdmissionProductionComposition,
  AdmissionRequestListener,
} from "./admission-composition.js";

export type PlatformAdmissionProcessState =
  | "stopped"
  | "starting"
  | "running"
  | "draining"
  | "failed";

export interface PlatformAdmissionProcessStatus {
  readonly state: PlatformAdmissionProcessState;
  readonly live: boolean;
  readonly ready: boolean;
  readonly draining: boolean;
}

export interface PlatformAdmissionProcess {
  start(address?: Readonly<{ host: string; port: number }>): Promise<string>;
  shutdown(options?: Readonly<{ deadlineMs?: number }>): Promise<void>;
  status(): PlatformAdmissionProcessStatus;
}

/**
 * Lifecycle host for the private Admission HTTP/2+mTLS listener. Production
 * wiring supplies the already fail-closed composition; this host owns database
 * readiness, health responses, stream drain and bounded shutdown.
 */
export function createPlatformAdmissionProcess(options: Readonly<{
  database: PlatformDatabaseClient;
  composition: AdmissionProductionComposition;
}>): PlatformAdmissionProcess {
  let state: PlatformAdmissionProcessState = "stopped";
  let ready = false;
  let databaseConnected = false;
  let server: Http2SecureServer | undefined;
  let startPromise: Promise<string> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const sessions = new Set<ServerHttp2Session>();

  const process: PlatformAdmissionProcess = {
    start(address = { host: "0.0.0.0", port: 4244 }) {
      validateAddress(address);
      if (state !== "stopped" || startPromise !== undefined) {
        return Promise.reject(new Error("PLATFORM_ADMISSION_NOT_STOPPED"));
      }
      state = "starting";
      ready = false;
      shutdownPromise = undefined;
      startPromise = start(address).finally(() => { startPromise = undefined; });
      return startPromise;
    },

    shutdown({ deadlineMs = 10_000 } = {}) {
      if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000) {
        return Promise.reject(new Error("PLATFORM_ADMISSION_SHUTDOWN_DEADLINE_INVALID"));
      }
      if (state === "stopped" && startPromise === undefined) return Promise.resolve();
      if (shutdownPromise !== undefined) return shutdownPromise;
      state = "draining";
      ready = false;
      const deadlineAt = Date.now() + deadlineMs;
      shutdownPromise = (async () => {
        const observedStart = startPromise?.then(() => undefined, () => undefined);
        const startStopped = await settlesWithin(observedStart, remaining(deadlineAt));
        for (const session of sessions) session.close();
        const activeServer = server;
        const serverStopped = activeServer === undefined
          ? true
          : await closeServer(activeServer, remaining(deadlineAt));
        if (!serverStopped) for (const session of sessions) session.destroy();
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
        throw new Error("PLATFORM_ADMISSION_SHUTDOWN_UNCONFIRMED");
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
      if (state !== "starting") throw new Error("PLATFORM_ADMISSION_START_ABORTED");
      await options.database.checkHealth();
      if (state !== "starting") throw new Error("PLATFORM_ADMISSION_START_ABORTED");
      const listener = admissionListener(options.database, options.composition, () => state);
      server = options.composition.createServer(listener);
      server.on("session", (session) => {
        sessions.add(session);
        session.once("close", () => sessions.delete(session));
      });
      await listen(server, address);
      if (state !== "starting") throw new Error("PLATFORM_ADMISSION_START_ABORTED");
      state = "running";
      ready = true;
      const bound = server.address();
      if (bound === null || typeof bound === "string") {
        throw new Error("PLATFORM_ADMISSION_ADDRESS_UNAVAILABLE");
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

  return process;
}

function admissionListener(
  database: PlatformDatabaseClient,
  composition: AdmissionProductionComposition,
  state: () => PlatformAdmissionProcessState,
): AdmissionRequestListener {
  return (request, response) => {
    response.setHeader("cache-control", "no-store");
    if (request.method === "GET" && request.url === "/health/live") {
      const live = state() === "running" || state() === "draining";
      response.statusCode = live ? 200 : 503;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ status: live ? "live" : "not_live" }));
      return;
    }
    if (request.method === "GET" && request.url === "/health/ready") {
      response.setHeader("content-type", "application/json; charset=utf-8");
      if (state() !== "running") {
        response.statusCode = 503;
        response.end(JSON.stringify({ status: "not_ready" }));
        return;
      }
      void database.checkHealth().then(
        () => {
          if (response.destroyed) return;
          response.statusCode = 200;
          response.end(JSON.stringify({ status: "ready" }));
        },
        () => {
          if (response.destroyed) return;
          response.statusCode = 503;
          response.end(JSON.stringify({ status: "database_unavailable" }));
        },
      );
      return;
    }
    if (state() !== "running") {
      response.statusCode = 503;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end("draining");
      return;
    }
    composition.handler(request, response);
  };
}

function listen(
  server: Http2SecureServer,
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

function closeServer(server: Http2SecureServer, deadlineMs: number): Promise<boolean> {
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
      const code = (error as NodeJS.ErrnoException).code;
      resolveClose(code === "ERR_SERVER_NOT_RUNNING");
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
  ) throw new Error("PLATFORM_ADMISSION_ADDRESS_INVALID");
}
