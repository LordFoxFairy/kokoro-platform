import type { FastifyInstance } from "fastify";

export interface StartHttpServerOptions {
  moduleName: string;
  port: number;
  createServer: () => FastifyInstance;
}

export async function startHttpServer(options: StartHttpServerOptions): Promise<FastifyInstance> {
  const app = options.createServer();
  let shutdownStarted = false;

  await app.listen({
    host: "0.0.0.0",
    port: options.port,
  });

  console.log(`${options.moduleName} listening on ${options.port}`);

  async function shutdown(signal: NodeJS.Signals) {
    if (shutdownStarted) {
      return;
    }

    shutdownStarted = true;

    try {
      await app.close();
      console.log(`${options.moduleName} stopped after ${signal}`);
    } catch (error) {
      process.exitCode = 1;
      console.error(`${options.moduleName} failed to stop cleanly after ${signal}`, error);
    }
  }

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  return app;
}
