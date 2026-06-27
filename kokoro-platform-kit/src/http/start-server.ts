import type { FastifyInstance } from "fastify";

export interface StartHttpServerOptions {
  moduleName: string;
  port: number;
  createServer: () => FastifyInstance;
}

export async function startHttpServer(options: StartHttpServerOptions): Promise<FastifyInstance> {
  const app = options.createServer();

  await app.listen({
    host: "0.0.0.0",
    port: options.port,
  });

  console.log(`${options.moduleName} listening on ${options.port}`);

  async function shutdown() {
    await app.close();
  }

  process.once("SIGINT", () => {
    void shutdown();
  });

  process.once("SIGTERM", () => {
    void shutdown();
  });

  return app;
}
