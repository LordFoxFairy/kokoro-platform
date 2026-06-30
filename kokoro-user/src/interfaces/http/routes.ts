import {
  readRequestContext,
  registerHealthRoute,
  sendData,
  sendError,
  sendZodError,
} from "@kokoro/platform-kit";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { UserService } from "../../application/user-service.js";
import { ensureUserRequestSchema } from "./schemas.js";

export function registerUserRoutes(app: FastifyInstance, service: UserService): void {
  registerHealthRoute(app, "user");

  app.post("/users/ensure", async (request, reply) => {
    const requestId = getRequestId(request.headers["x-request-id"]);

    // siteId 是上下文（来自 header），不是业务载荷，不进 body schema。
    const ctx = readRequestContext(request.headers);
    if (ctx.siteId === null) {
      return sendError(reply, 400, "context.site_required", "缺少站点上下文", undefined, requestId);
    }
    const siteId = ctx.siteId;

    try {
      const input = ensureUserRequestSchema.parse(request.body);
      const result = await service.ensureUserWithPersonalTeam({ ...input, siteId });
      return sendData(reply, result, 200, requestId);
    } catch (error) {
      if (error instanceof ZodError) {
        return sendZodError(reply, error, requestId);
      }

      request.log.error({ error }, "failed to ensure user");
      return sendError(reply, 500, "user.ensure_failed", "用户创建或更新失败", undefined, requestId);
    }
  });

  app.get("/me/teams", async (request, reply) => {
    const requestId = getRequestId(request.headers["x-request-id"]);
    const userId = getSingleHeader(request.headers["x-user-id"]);

    if (!userId) {
      return sendError(reply, 400, "request.missing_user", "缺少 x-user-id", undefined, requestId);
    }

    try {
      const teams = await service.listTeamsForUser(userId);
      return sendData(reply, teams, 200, requestId);
    } catch (error) {
      request.log.error({ error }, "failed to list user teams");
      return sendError(reply, 500, "team.list_failed", "团队列表获取失败", undefined, requestId);
    }
  });
}

function getRequestId(value: string | string[] | undefined): string {
  return getSingleHeader(value) ?? crypto.randomUUID();
}

function getSingleHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return normalizeHeaderValue(value[0]);
  }

  return normalizeHeaderValue(value);
}

function normalizeHeaderValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
