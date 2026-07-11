import { jsonSchema, sendData, sendError, sendZodError } from "@kokoro/platform-kit";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { SessionService } from "../../application/session-service.js";
import { InvalidRuntimeNamespaceError } from "../../domain/session.js";
import { isUserLifecycleError } from "../../domain/user-deletion.js";
import { issueSessionRequestSchema } from "./schemas.js";

// sessionService=null 表示未配置签发密钥（KOKORO_AUTH_JWT_SECRET 缺）：路由仍注册，命中即 503。
export function registerSessionRoutes(
  app: FastifyInstance,
  sessionService: SessionService | null,
): void {
  app.post(
    "/auth/sessions",
    {
      schema: {
        tags: ["auth"],
        summary: "签发终端用户运行时会话 JWT",
        body: jsonSchema(issueSessionRequestSchema),
      },
    },
    async (request, reply) => {
      const requestId = getRequestId(request.headers["x-kokoro-request-id"] ?? request.headers["x-request-id"]);

      // fail-closed：未配置签发密钥绝不签发未签名 token。
      if (sessionService === null) {
        return sendError(reply, 503, "auth.not_configured", "会话签发未配置", undefined, requestId);
      }

      try {
        const input = issueSessionRequestSchema.parse(request.body);
        const issued = await sessionService.issue({
          siteId: input.site_id,
          externalUserId: input.external_user_id,
          email: input.email,
        });
        return sendData(
          reply,
          {
            token: issued.token,
            namespace: issued.namespace,
            user: issued.user,
            team: issued.team,
          },
          200,
          requestId,
        );
      } catch (error) {
        if (error instanceof ZodError) {
          return sendZodError(reply, error, requestId);
        }
        // 已删除用户/团队 → 复用生命周期 409（deleted 不可签发）。
        if (isUserLifecycleError(error)) {
          return sendError(reply, error.statusCode, error.code, error.message, undefined, requestId);
        }
        if (error instanceof InvalidRuntimeNamespaceError) {
          request.log.error("refusing to sign a non-opaque namespace");
          return sendError(reply, 500, "auth.invalid_namespace", "命名空间非法", undefined, requestId);
        }
        request.log.error({ error }, "failed to issue session");
        return sendError(reply, 500, "auth.issue_failed", "会话签发失败", undefined, requestId);
      }
    },
  );
}

function getRequestId(value: string | string[] | undefined): string {
  const single = Array.isArray(value) ? value[0] : value;
  const normalized = single?.trim();
  return normalized ? normalized : crypto.randomUUID();
}
