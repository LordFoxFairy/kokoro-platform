import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createPlatformDatabaseClient,
  loadPlatformDatabaseConfig,
  type PlatformDatabaseClient,
} from "../infrastructure/postgres/client.js";
import type { PlatformProcessState } from "./api.js";
import { createAuthorizationRetentionCycle } from "../modules/authorization/infrastructure/postgres/authorization-retention.js";
import { createCommerceOutboxReconciliationCycle, HmacHttpOutboxDeliveryTransport } from
  "../modules/commerce/infrastructure/postgres/commerce-outbox-reconciler.js";

export interface PlatformWorkerProcessStatus {
  readonly state: PlatformProcessState;
  readonly live: boolean;
  readonly ready: boolean;
  readonly draining: boolean;
}

export interface PlatformWorkerProcess {
  start(): Promise<void>;
  shutdown(options?: { deadlineMs?: number }): Promise<void>;
  status(): PlatformWorkerProcessStatus;
}

export interface PlatformWorkerCycleContext {
  readonly signal: AbortSignal;
}

export function createPlatformWorkerProcess(options: {
  database: PlatformDatabaseClient;
  runOneCycle?: (context: PlatformWorkerCycleContext) => Promise<void>;
  stopClaiming?: () => Promise<void>;
  returnLease?: (reason: "shutdown" | "shutdown-deadline" | "stop-claim-failed") => Promise<void>;
  pollIntervalMs?: number;
  onCycleError?: (error: unknown) => void;
}): PlatformWorkerProcess {
  const { database } = options;
  const runOneCycle =
    options.runOneCycle ??
    (async ({ signal }) => {
      signal.throwIfAborted();
      await database.checkHealth();
    });
  const stopClaiming = options.stopClaiming ?? (() => Promise.resolve());
  const returnLease = options.returnLease ?? (() => Promise.resolve());
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const onCycleError = options.onCycleError ?? (() => undefined);
  let state: PlatformProcessState = "stopped";
  let ready = false;
  let databaseConnected = false;
  let startPromise: Promise<void> | undefined;
  let loopPromise: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let wake: (() => void) | undefined;
  let cycleAbort = new AbortController();
  let startAbort = new AbortController();
  let restartBlocked = false;
  const currentState = (): PlatformProcessState => state;

  const worker: PlatformWorkerProcess = {
    start() {
      if (restartBlocked) {
        return Promise.reject(new Error("PLATFORM_WORKER_RESTART_REQUIRES_PROCESS_REPLACEMENT"));
      }
      if (state !== "stopped" || startPromise) {
        return Promise.reject(new Error("PLATFORM_WORKER_NOT_STOPPED"));
      }
      state = "starting";
      ready = false;
      shutdownPromise = undefined;
      cycleAbort = new AbortController();
      startAbort = new AbortController();
      const startSignal = startAbort.signal;
      const cycleSignal = cycleAbort.signal;
      startPromise = startWorker(startSignal, cycleSignal).finally(() => {
        startPromise = undefined;
      });
      return startPromise;
    },

    shutdown({ deadlineMs = 10_000 } = {}) {
      if (state === "stopped" && !startPromise) return Promise.resolve();
      if (shutdownPromise) return shutdownPromise;
      state = "draining";
      ready = false;
      startAbort.abort(new Error("PLATFORM_WORKER_DRAINING"));
      const deadlineAt = Date.now() + deadlineMs;
      shutdownPromise = (async () => {
        const claimsStopped = await settlesWithin(
          Promise.resolve().then(stopClaiming),
          remaining(deadlineAt),
        );
        cycleAbort.abort(new Error("PLATFORM_WORKER_DRAINING"));
        wake?.();
        const startStopped = await settlesWithin(startPromise, remaining(deadlineAt));
        const loopStopped = await settlesWithin(loopPromise, remaining(deadlineAt));
        const leaseReturned = await settlesWithin(
          Promise.resolve().then(() =>
            returnLease(
              !claimsStopped
                ? "stop-claim-failed"
                : !startStopped || !loopStopped
                  ? "shutdown-deadline"
                  : "shutdown",
            ),
          ),
          remaining(deadlineAt),
        );
        let disconnected = true;
        if (databaseConnected) {
          disconnected = await settlesWithin(database.disconnect(), remaining(deadlineAt));
          databaseConnected = false;
        }
        if (claimsStopped && startStopped && loopStopped && leaseReturned && disconnected) {
          state = "stopped";
          return;
        }
        restartBlocked = true;
        state = "failed";
        throw new Error("PLATFORM_WORKER_SHUTDOWN_UNCONFIRMED");
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

  async function startWorker(startSignal: AbortSignal, cycleSignal: AbortSignal): Promise<void> {
    try {
      await database.connect();
      databaseConnected = true;
      if (startSignal.aborted || currentState() === "draining") {
        throw new Error("PLATFORM_WORKER_START_ABORTED");
      }
      await database.checkHealth();
      if (startSignal.aborted || currentState() === "draining") {
        throw new Error("PLATFORM_WORKER_START_ABORTED");
      }
      state = "running";
      ready = true;
      loopPromise = runLoop(cycleSignal);
    } catch (error) {
      ready = false;
      if (databaseConnected) {
        await database.disconnect();
        databaseConnected = false;
      }
      if (currentState() === "starting") state = "stopped";
      throw error;
    }
  }

  async function runLoop(signal: AbortSignal): Promise<void> {
    while (state === "running") {
      try {
        await runOneCycle({ signal });
        ready = currentState() === "running";
      } catch (error) {
        ready = false;
        if (!signal.aborted) onCycleError(error);
      }
      if (state === "running") {
        await new Promise<void>((resolveWait) => {
          const timer = setTimeout(resolveWait, pollIntervalMs);
          wake = () => {
            clearTimeout(timer);
            resolveWait();
          };
        });
        wake = undefined;
      }
    }
  }

  return worker;
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

export async function runPlatformWorkerMain(): Promise<void> {
  const database = createPlatformDatabaseClient(loadPlatformDatabaseConfig("worker"));
  const retentionDays = Number.parseInt(process.env.PLATFORM_AUTHORIZATION_EVENT_RETENTION_DAYS ?? "7", 10);
  const authorizationRetention = createAuthorizationRetentionCycle({
    database,
    retentionMs: retentionDays * 24 * 60 * 60_000,
  });
  const commerceOutbox = createCommerceOutboxReconciliationCycle({
    database,
    transport: new HmacHttpOutboxDeliveryTransport({
      endpoint: requireEnvironment("PLATFORM_OUTBOX_DELIVERY_ENDPOINT"),
      keyId: requireEnvironment("PLATFORM_OUTBOX_DELIVERY_KEY_ID"),
      secretBase64: requireEnvironment("PLATFORM_OUTBOX_DELIVERY_SECRET_BASE64"),
      timeoutMs: Number.parseInt(process.env.PLATFORM_OUTBOX_DELIVERY_TIMEOUT_MS ?? "10000", 10),
    }),
    workerId: process.env.PLATFORM_WORKER_ID ?? `platform-worker-${process.pid}`,
  });
  const worker = createPlatformWorkerProcess({
    database,
    runOneCycle: async (context) => {
      await commerceOutbox(context);
      await authorizationRetention(context);
    },
    onCycleError: (error) => console.error("Platform Worker cycle failed", error),
  });
  const shutdown = () => {
    void worker.shutdown().catch((error: unknown) => {
      process.exitCode = 1;
      console.error("Platform Worker failed to drain", error);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await worker.start();
  console.log("Platform Worker ready");
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name}_REQUIRED`);
  return value;
}

if (isMainModule()) {
  runPlatformWorkerMain().catch((error: unknown) => {
    process.exitCode = 1;
    console.error("Platform Worker failed to start", error);
  });
}
