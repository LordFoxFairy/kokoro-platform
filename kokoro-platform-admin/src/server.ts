import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readRequestContext, registerHealthRoute, sendData, sendError } from "@kokoro/platform-kit";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { ConsoleAuditSink } from "./audit.js";
import type { ModuleConfig } from "./config.js";
import { GatewayError, getManifests, proxyAction, proxyResource, type ActionRequest, type AuditSink } from "./gateway.js";

const resourceQuerySchema = z.object({
  moduleId: z.string().min(1),
  route: z.string().min(1),
});

const actionBodySchema = z
  .object({
    moduleId: z.string().min(1),
    resourceId: z.string().min(1),
    actionId: z.string().min(1),
    params: z.record(z.string()).optional(),
    body: z.unknown().optional(),
    siteId: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
  })
  .strict();

const indexHtmlPath = fileURLToPath(new URL("../public/index.html", import.meta.url));

export function createAdminServer(modules: ModuleConfig[], audit: AuditSink = new ConsoleAuditSink()): FastifyInstance {
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

  app.post("/api/action", async (request, reply) => {
    const parsed = actionBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "request.invalid", "无效的操作请求", { issues: parsed.error.issues });
    }
    const ctx = readRequestContext(request.headers);
    // 条件 spread 丢掉 undefined 键，匹配 exactOptionalPropertyTypes 下的 ActionRequest。
    const data = parsed.data;
    const actionRequest: ActionRequest = {
      moduleId: data.moduleId,
      resourceId: data.resourceId,
      actionId: data.actionId,
      ...(data.params === undefined ? {} : { params: data.params }),
      ...(data.body === undefined ? {} : { body: data.body }),
      ...(data.siteId === undefined ? {} : { siteId: data.siteId }),
      ...(data.reason === undefined ? {} : { reason: data.reason }),
    };
    try {
      const result = await proxyAction(modules, audit, actionRequest, ctx.requestId);
      return sendData(reply, result, 200, ctx.requestId);
    } catch (error) {
      if (error instanceof GatewayError) {
        return sendError(reply, error.statusCode, "gateway.error", error.message, undefined, ctx.requestId);
      }
      return sendError(reply, 502, "gateway.error", error instanceof Error ? error.message : String(error), undefined, ctx.requestId);
    }
  });

  return app;
}
