import type { ServerHttp2Session } from "node:http2";
import { Code, ConnectError } from "@connectrpc/connect";

interface EventServer {
  once(event: "error", listener: (error: Error) => void): unknown;
  on(event: string, listener: (...arguments_: unknown[]) => void): unknown;
  off(event: string, listener: (...arguments_: unknown[]) => void): unknown;
  listen(port: number, host: string, listener: () => void): unknown;
  close(listener: (error?: Error) => void): unknown;
}

interface ConnectSession {
  once(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
  close(): unknown;
  destroy(error?: Error): unknown;
}

export interface HubConnectProcess {
  start(): Promise<void>;
  shutdown(): Promise<void>;
  isDraining(): boolean;
}

export function createHubConnectProcess(input: Readonly<{
  server: EventServer;
  healthServer: EventServer;
  worker: Readonly<{ tick(signal: AbortSignal): Promise<unknown> }>;
  closeMongo: () => Promise<unknown>;
  port: number;
  healthPort: number;
  host?: string;
  pollIntervalMs?: number;
  shutdownDeadlineMs?: number;
  shutdownController?: AbortController;
  onFatal?: (error: unknown) => void;
}>): HubConnectProcess {
  const pollIntervalMs = boundedMilliseconds(input.pollIntervalMs ?? 250, 1, 60_000);
  const shutdownDeadlineMs = boundedMilliseconds(input.shutdownDeadlineMs ?? 10_000, 10, 60_000);
  const controller = input.shutdownController ?? new AbortController();
  const sessions = new Set<ConnectSession>();
  const sessionDrainWaiters = new Set<() => void>();
  const sessionCloseListeners = new Map<ConnectSession, () => void>();
  let draining = false;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeTick: Promise<unknown> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let forceDestroying = false;
  let sessionActionUnconfirmed = false;

  const trackSession = (raw: ServerHttp2Session) => {
    const session = raw as ConnectSession;
    if (!sessions.has(session)) {
      sessions.add(session);
      const closed = () => {
        sessions.delete(session);
        sessionCloseListeners.delete(session);
        try { session.off("close", closed); } catch { sessionActionUnconfirmed = true; }
        if (sessions.size === 0) {
          for (const resolveDrained of [...sessionDrainWaiters]) resolveDrained();
          sessionDrainWaiters.clear();
        }
      };
      sessionCloseListeners.set(session, closed);
      try {
        session.once("close", closed);
      } catch {
        sessionActionUnconfirmed = true;
      }
    }
    if (!draining) return;
    const outcome = closeSession(session);
    if (forceDestroying && outcome === "close_requested" && sessions.has(session)) {
      destroySession(session);
    }
  };
  input.server.on("session", trackSession as (...arguments_: unknown[]) => void);

  const fatal = (error: unknown) => {
    if (draining) return;
    const stopping = shutdown();
    try { input.onFatal?.(error); } catch { /* fatal hooks cannot own cleanup */ }
    void stopping.catch(() => undefined);
  };

  const schedule = () => {
    if (controller.signal.aborted || draining) return;
    timer = setTimeout(() => {
      activeTick = input.worker.tick(controller.signal)
        .catch((error: unknown) => {
          if (!controller.signal.aborted) fatal(error);
        })
        .finally(() => {
          activeTick = undefined;
          schedule();
        });
    }, pollIntervalMs);
    timer.unref();
  };

  const start = async () => {
    if (started || draining) throw new Error("HUB_CONNECT_PROCESS_STATE_INVALID");
    try {
      await listen(input.server, input.port, input.host ?? "0.0.0.0");
      await listen(input.healthServer, input.healthPort, input.host ?? "0.0.0.0");
      started = true;
      input.server.on("error", fatal as (...arguments_: unknown[]) => void);
      input.healthServer.on("error", fatal as (...arguments_: unknown[]) => void);
      schedule();
    } catch (error) {
      await shutdown().catch(() => undefined);
      throw error;
    }
  };

  const shutdown = (): Promise<void> => {
    shutdownPromise ??= performShutdown();
    return shutdownPromise;
  };

  const performShutdown = async (): Promise<void> => {
    const shutdownStartedAt = Date.now();
    let sessionDrainWaiter: ReturnType<typeof waitForSessionsToDrain> | undefined;
    let shutdownUnconfirmed = true;
    try {
      draining = true;
      controller.abort(new ConnectError("hub runtime draining", Code.Unavailable));
      if (timer !== undefined) clearTimeout(timer);
      for (const session of sessions) {
        closeSession(session);
      }

      const services = Promise.allSettled([
        closeServer(input.server),
        closeServer(input.healthServer),
        activeTick ?? Promise.resolve(),
      ]);
      const gracefulMs = Math.max(1, Math.floor(shutdownDeadlineMs * 0.6));
      const gracefulOutcomes = await beforeDeadline(services, gracefulMs);
      if (gracefulOutcomes === null || sessions.size > 0) {
        forceDestroying = true;
        for (const session of sessions) {
          destroySession(session, new Error("HUB_CONNECT_SHUTDOWN_DEADLINE"));
        }
      }
      const mongo = settle(Promise.resolve().then(input.closeMongo));
      sessionDrainWaiter = waitForSessionsToDrain();
      const completion = Promise.all([services, mongo, sessionDrainWaiter.promise])
        .then(([serviceOutcomes, mongoOutcome]) =>
        [...serviceOutcomes, mongoOutcome]);
      const remainingMs = Math.max(1, shutdownDeadlineMs - (Date.now() - shutdownStartedAt));
      const outcomes = await beforeDeadline(completion, remainingMs);

      shutdownUnconfirmed = sessionActionUnconfirmed || sessions.size > 0 || outcomes === null ||
        outcomes.some((outcome) => outcome.status === "rejected");
    } finally {
      const sessionStateUnconfirmedBeforeCleanup = sessionActionUnconfirmed || sessions.size > 0;
      sessionDrainWaiter?.cancel();
      removeListener(input.server, "session", trackSession as (...arguments_: unknown[]) => void);
      removeListener(input.server, "error", fatal as (...arguments_: unknown[]) => void);
      removeListener(input.healthServer, "error", fatal as (...arguments_: unknown[]) => void);
      for (const [session, closed] of sessionCloseListeners) {
        try { session.off("close", closed); } catch { sessionActionUnconfirmed = true; }
      }
      sessionCloseListeners.clear();
      sessionDrainWaiters.clear();
      sessions.clear();
      shutdownUnconfirmed ||= sessionStateUnconfirmedBeforeCleanup || sessionActionUnconfirmed;
    }
    if (shutdownUnconfirmed) throw new Error("HUB_CONNECT_SHUTDOWN_UNCONFIRMED");
  };

  function closeSession(session: ConnectSession): "close_requested" | "destroyed" | "failed" {
    try {
      session.close();
      return "close_requested";
    } catch {
      return destroySession(session) ? "destroyed" : "failed";
    }
  }

  function destroySession(session: ConnectSession, error?: Error): boolean {
    try {
      session.destroy(error);
      return true;
    } catch {
      sessionActionUnconfirmed = true;
      return false;
    }
  }

  function waitForSessionsToDrain(): Readonly<{ promise: Promise<void>; cancel: () => void }> {
    if (sessions.size === 0) return { promise: Promise.resolve(), cancel: () => undefined };
    let finish = () => undefined;
    const promise = new Promise<void>((resolveDrained) => {
      finish = () => {
        if (sessionDrainWaiters.delete(finish)) resolveDrained();
      };
      sessionDrainWaiters.add(finish);
    });
    return { promise, cancel: finish };
  }

  function removeListener(server: EventServer, event: string,
    listener: (...arguments_: unknown[]) => void): void {
    try { server.off(event, listener); } catch { sessionActionUnconfirmed = true; }
  }

  return Object.freeze({ start, shutdown, isDraining: () => draining });
}

function listen(server: EventServer, port: number, host: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const failed = (error: Error) => {
      server.off("error", failed as (...arguments_: unknown[]) => void);
      reject(error);
    };
    server.once("error", failed);
    try {
      server.listen(port, host, () => {
        server.off("error", failed as (...arguments_: unknown[]) => void);
        resolveListen();
      });
    } catch (error) {
      server.off("error", failed as (...arguments_: unknown[]) => void);
      reject(error);
    }
  });
}

function closeServer(server: EventServer): Promise<void> {
  return new Promise((resolveClose, reject) => {
    try {
      server.close((error?: Error) => {
        if (error === undefined || errorCode(error) === "ERR_SERVER_NOT_RUNNING") resolveClose();
        else reject(error);
      });
    } catch (error) {
      if (errorCode(error) === "ERR_SERVER_NOT_RUNNING") resolveClose();
      else reject(error);
    }
  });
}

function beforeDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T | null> {
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => resolveWait(null), Math.max(1, milliseconds));
    void promise.then((value) => {
      clearTimeout(timer);
      resolveWait(value);
    });
  });
}

function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );
}

function boundedMilliseconds(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error("HUB_CONNECT_PROCESS_CONFIG_INVALID");
  }
  return value;
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error &&
    typeof error.code === "string" ? error.code : undefined;
}
