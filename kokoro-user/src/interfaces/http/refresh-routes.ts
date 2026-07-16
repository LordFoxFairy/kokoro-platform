import { jsonSchema, sendData, sendError, sendZodError } from "@kokoro/platform-kit";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { MagicLinkRateLimiter } from "../../application/magic-link-rate-limiter.js";
import type { RefreshService } from "../../application/refresh-service.js";
import { RefreshTokenInvalidError } from "../../domain/refresh-token.js";
import { refreshSessionRequestSchema } from "./schemas.js";

export interface RefreshRouteOptions {
  // 复用 magic-link 的固定窗口限频器，按来源 IP 维度给 refresh 端点限频。
  rateLimiter: MagicLinkRateLimiter;
  // 可注入时钟，便于测试确定限频窗口；缺省真实时间。
  now?: () => Date;
}

// refresh 端点按 IP 维度限频：借用 magic-link 限频器的 email 主维承载 IP（专属实例，键不与 magic-link 交叉）。
function refreshRateKey(ip: string): { email: string } {
  return { email: `refresh-ip:${ip}` };
}

// refreshService=null 表示未配置签发密钥（与 /auth/sessions 同 fail-closed）：路由仍注册，命中即 503。
export function registerRefreshRoutes(
  app: FastifyInstance,
  refreshService: RefreshService | null,
  options: RefreshRouteOptions,
): void {
  const now = options.now ?? (() => new Date());

  app.post(
    "/auth/refresh",
    {
      schema: {
        tags: ["auth"],
        summary: "用 refresh token 换新 access JWT 并轮换 refresh",
        body: jsonSchema(refreshSessionRequestSchema),
      },
    },
    async (request, reply) => {
      const requestId = getRequestId(request.headers["x-kokoro-request-id"] ?? request.headers["x-request-id"]);

      // fail-closed：未配置签发密钥绝不签发未签名 token。
      if (refreshService === null) {
        return sendError(reply, 503, "auth.not_configured", "会话签发未配置", undefined, requestId);
      }

      // 按 IP 限频（request.ip 由 fastify 从 socket/信任代理解析）。fail-open 由限频器自理，绝不抛。
      const allowed = await options.rateLimiter.consume(refreshRateKey(request.ip), now());
      if (!allowed) {
        return sendError(reply, 429, "auth.refresh_rate_limited", "refresh 请求过于频繁", undefined, requestId);
      }

      try {
        const input = refreshSessionRequestSchema.parse(request.body);
        const rotated = await refreshService.rotate(input.refresh_token);
        return sendData(
          reply,
          {
            token: rotated.token,
            namespace: rotated.namespace,
            site_id: rotated.siteId,
            refresh_token: rotated.refreshToken,
            refresh_expires_at: rotated.refreshExpiresAt.toISOString(),
          },
          200,
          requestId,
        );
      } catch (error) {
        if (error instanceof ZodError) {
          return sendZodError(reply, error, requestId);
        }
        // 统一 401：无效/过期/吊销/重放不区分，避免给探测者 oracle。
        if (error instanceof RefreshTokenInvalidError) {
          return sendError(reply, 401, "invalid_refresh", "refresh 无效或已失效", undefined, requestId);
        }
        request.log.error({ error }, "failed to rotate refresh token");
        return sendError(reply, 500, "auth.refresh_failed", "refresh 换签失败", undefined, requestId);
      }
    },
  );

  app.post(
    "/auth/refresh/revoke",
    {
      schema: {
        tags: ["auth"],
        summary: "登出：吊销该 refresh 所属 namespace 的全部活 refresh",
        body: jsonSchema(refreshSessionRequestSchema),
      },
    },
    async (request, reply) => {
      const requestId = getRequestId(request.headers["x-kokoro-request-id"] ?? request.headers["x-request-id"]);

      // 未配置签发 = 无可吊销：登出幂等成功（204），不 fail-closed（清 cookie 已断本浏览器）。
      if (refreshService === null) {
        return reply.status(204).send();
      }

      const allowed = await options.rateLimiter.consume(refreshRateKey(request.ip), now());
      if (!allowed) {
        return sendError(reply, 429, "auth.refresh_rate_limited", "refresh 请求过于频繁", undefined, requestId);
      }

      try {
        const input = refreshSessionRequestSchema.parse(request.body);
        // 幂等：无效/未知 token 也当作已登出，静默成功——不给探测者 oracle。
        await refreshService.revoke(input.refresh_token);
        return reply.status(204).send();
      } catch (error) {
        if (error instanceof ZodError) {
          return sendZodError(reply, error, requestId);
        }
        request.log.error({ error }, "failed to revoke refresh token");
        return sendError(reply, 500, "auth.refresh_revoke_failed", "refresh 吊销失败", undefined, requestId);
      }
    },
  );
}

function getRequestId(value: string | string[] | undefined): string {
  const single = Array.isArray(value) ? value[0] : value;
  const normalized = single?.trim();
  return normalized ? normalized : crypto.randomUUID();
}
