import type { ServerHttp2Session } from "node:http2";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createPlatformDatabaseClient,
  loadPlatformDatabaseConfig,
} from "../infrastructure/postgres/client.js";
import { createSessionAuthorizationProductionComposition } from "./session-authorization-composition.js";

export async function runPlatformAuthorizationMain(): Promise<void> {
  const database = createPlatformDatabaseClient(loadPlatformDatabaseConfig("authorization"));
  let databaseConnected = false;
  try {
    await database.connect();
    databaseConnected = true;
    await database.checkHealth();
    const composition = await createSessionAuthorizationProductionComposition({ database });
    let draining = false;
    let shutdownPromise: Promise<void> | undefined;
    const sessions = new Set<ServerHttp2Session>();
    const server = composition.createServer((request, response) => {
      response.setHeader("cache-control", "no-store");
      if (request.method === "GET" && request.url === "/health/live") {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(JSON.stringify({ status: draining ? "draining" : "live" }));
        return;
      }
      if (request.method === "GET" && request.url === "/health/ready") {
        response.setHeader("content-type", "application/json; charset=utf-8");
        if (draining) {
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
      if (draining) {
        response.statusCode = 503;
        response.setHeader("content-type", "text/plain; charset=utf-8");
        response.end("draining");
        return;
      }
      composition.handler(request, response);
    });
    server.on("session", (session) => {
      sessions.add(session);
      session.once("close", () => sessions.delete(session));
    });
    const shutdown = (): Promise<void> => {
      if (shutdownPromise) return shutdownPromise;
      draining = true;
      shutdownPromise = (async () => {
        const deadlineAt = Date.now() + 10_000;
        for (const session of sessions) session.close();
        const serverStopped = await closeServer(server, remaining(deadlineAt));
        if (!serverStopped) for (const session of sessions) session.destroy();
        const databaseStopped = await settlesWithin(database.disconnect(), remaining(deadlineAt));
        databaseConnected = false;
        if (!serverStopped || !databaseStopped) {
          throw new Error("PLATFORM_AUTHORIZATION_SHUTDOWN_UNCONFIRMED");
        }
      })();
      return shutdownPromise;
    };
    const onSignal = () => {
      void shutdown().catch((error: unknown) => {
        process.exitCode = 1;
        console.error("Platform Authorization failed to drain", error);
      });
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    const port = boundedPort(process.env.PLATFORM_AUTHORIZATION_PORT ?? "4143");
    try {
      await listen(server, port);
    } catch (error) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      await shutdown().catch(() => undefined);
      throw error;
    }
    server.on("error", (error) => {
      process.exitCode = 1;
      console.error("Platform Authorization server failed", error);
      onSignal();
    });
    console.log(`Platform Authorization listening on 0.0.0.0:${port}`);
  } catch (error) {
    if (databaseConnected) await database.disconnect();
    throw error;
  }
}

function listen(
  server: ReturnType<Awaited<ReturnType<typeof createSessionAuthorizationProductionComposition>>["createServer"]>,
  port: number,
): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}

function closeServer(
  server: ReturnType<Awaited<ReturnType<typeof createSessionAuthorizationProductionComposition>>["createServer"]>,
  deadlineMs: number,
): Promise<boolean> {
  if (deadlineMs <= 0) return Promise.resolve(false);
  return new Promise((resolveClose) => {
    const deadline = setTimeout(() => resolveClose(false), deadlineMs);
    deadline.unref();
    server.close((error) => {
      clearTimeout(deadline);
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ERR_SERVER_NOT_RUNNING") {
        resolveClose(true);
        return;
      }
      resolveClose(error === undefined);
    });
  });
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
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
    if (timer) clearTimeout(timer);
  }
}

function remaining(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now());
}

function boundedPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PLATFORM_AUTHORIZATION_PORT_INVALID");
  return port;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  await runPlatformAuthorizationMain().catch((error: unknown) => {
    process.exitCode = 1;
    console.error("Platform Authorization failed to start", error);
  });
}
