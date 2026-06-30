import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { registerHealthRoute, sendData, sendError } from "@kokoro/platform-kit";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { ModuleConfig } from "./config.js";
import { GatewayError, getManifests, proxyResource } from "./gateway.js";

const resourceQuerySchema = z.object({
  moduleId: z.string().min(1),
  route: z.string().min(1),
});

const indexHtmlPath = fileURLToPath(new URL("../public/index.html", import.meta.url));

export function createAdminServer(modules: ModuleConfig[]): FastifyInstance {
  const app = Fastify({ logger: false });

  registerHealthRoute(app, "kokoro-platform-admin");

  app.get("/", async (_request, reply) => {
    const html = await readFile(indexHtmlPath, "utf8");
    return reply.code(200).type("text/html").send(html);
  });

  app.get("/api/manifests", async (_request, reply) => sendData(reply, await getManifests(modules)));

  app.get("/api/resource", async (request, reply) => {
    const query = resourceQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendError(reply, 400, "request.invalid", "无效的查询参数", { issues: query.error.issues });
    }
    try {
      const rows = await proxyResource(modules, query.data.moduleId, query.data.route);
      return sendData(reply, rows);
    } catch (error) {
      if (error instanceof GatewayError) {
        return sendError(reply, error.statusCode, "gateway.error", error.message);
      }
      return sendError(reply, 502, "gateway.error", error instanceof Error ? error.message : String(error));
    }
  });

  return app;
}
