import { jsonSchema, sendData, sendError, sendZodError } from "@kokoro/platform-kit";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { MagicLinkService } from "../../application/magic-link-service.js";
import type { SessionService } from "../../application/session-service.js";
import {
  magicLinkExternalUserId,
  MagicLinkInvalidError,
  MagicLinkRateLimitedError,
  type MagicLinkDeliveryMode,
} from "../../domain/magic-link.js";
import { InvalidRuntimeNamespaceError } from "../../domain/session.js";
import { isUserLifecycleError } from "../../domain/user-deletion.js";
import { consumeMagicLinkRequestSchema, requestMagicLinkRequestSchema } from "./schemas.js";

export interface MagicLinkRouteOptions {
  deliveryMode: MagicLinkDeliveryMode;
}

// sessionService=null 表示未配置签发密钥：申请仍可落链，消费命中即 503（与 /auth/sessions 同 fail-closed 语义）。
export function registerMagicLinkRoutes(
  app: FastifyInstance,
  magicLinkService: MagicLinkService,
  sessionService: SessionService | null,
  options: MagicLinkRouteOptions,
): void {
  app.post(
    "/auth/magic-links",
    {
      schema: {
        tags: ["auth"],
        summary: "申请一次性 magic-link 登录 token",
        body: jsonSchema(requestMagicLinkRequestSchema),
      },
    },
    async (request, reply) => {
      const requestId = getRequestId(request.headers["x-kokoro-request-id"] ?? request.headers["x-request-id"]);

      try {
        const input = requestMagicLinkRequestSchema.parse(request.body);
        const issued = await magicLinkService.request({
          siteId: input.site_id,
          email: input.email,
          nonceHash: input.nonce_hash ?? null,
        });

        // V1 dev 投递两档。邮件投递（SMTP/供应商）后续接在这里，替换 log 档落点，本仓不臆造 SMTP。
        if (options.deliveryMode === "response") {
          // response 档仅限 dev 部署：一次性原文 token 直接回响应体。
          return sendData(
            reply,
            {
              email: issued.record.email,
              expires_at: issued.record.expiresAt.toISOString(),
              link_token: issued.linkToken,
            },
            200,
            requestId,
          );
        }
        // log 档：原文 token 绝不落日志（纲领：magic-link 原文不进日志）。只记哈希前缀做审计关联，
        // 无法从中还原链接——真正的邮件投递接入时替换此落点。dev 端到端用 response 档取可点链。
        request.log.info(
          {
            siteId: issued.record.siteId,
            email: issued.record.email,
            tokenHashPrefix: issued.record.tokenHash.slice(0, 12),
          },
          "magic link issued (log delivery, hash prefix only)",
        );
        return sendData(
          reply,
          { email: issued.record.email, expires_at: issued.record.expiresAt.toISOString() },
          200,
          requestId,
        );
      } catch (error) {
        if (error instanceof ZodError) {
          return sendZodError(reply, error, requestId);
        }
        if (error instanceof MagicLinkRateLimitedError) {
          return sendError(reply, 429, "auth.magic_link_rate_limited", "该邮箱申请过于频繁", undefined, requestId);
        }
        request.log.error({ error }, "failed to issue magic link");
        return sendError(reply, 500, "auth.magic_link_issue_failed", "magic link 签发失败", undefined, requestId);
      }
    },
  );

  app.post(
    "/auth/magic-links/consume",
    {
      schema: {
        tags: ["auth"],
        summary: "消费 magic-link token 并签发运行时会话",
        body: jsonSchema(consumeMagicLinkRequestSchema),
      },
    },
    async (request, reply) => {
      const requestId = getRequestId(request.headers["x-kokoro-request-id"] ?? request.headers["x-request-id"]);

      // fail-closed：未配置签发密钥绝不签发未签名 token。
      if (sessionService === null) {
        return sendError(reply, 503, "auth.not_configured", "会话签发未配置", undefined, requestId);
      }

      try {
        const input = consumeMagicLinkRequestSchema.parse(request.body);
        const link = await magicLinkService.consume(input.token, input.nonce_hash ?? null);
        // 复用 /auth/sessions 语义：resolve-or-create user+personal team → 签发；返回形状同 /auth/sessions。
        const issued = await sessionService.issue({
          siteId: link.siteId,
          externalUserId: magicLinkExternalUserId(link.email),
          email: link.email,
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
        // 统一 401：过期/已消费/已作废/不存在不区分，避免给探测者 oracle。
        if (error instanceof MagicLinkInvalidError) {
          return sendError(reply, 401, "auth.magic_link_invalid", "magic link 无效或已失效", undefined, requestId);
        }
        // 已删除用户/团队 → 复用生命周期 409（deleted 不可签发）。
        if (isUserLifecycleError(error)) {
          return sendError(reply, error.statusCode, error.code, error.message, undefined, requestId);
        }
        if (error instanceof InvalidRuntimeNamespaceError) {
          request.log.error("refusing to sign a non-opaque namespace");
          return sendError(reply, 500, "auth.invalid_namespace", "命名空间非法", undefined, requestId);
        }
        request.log.error({ error }, "failed to consume magic link");
        return sendError(reply, 500, "auth.magic_link_consume_failed", "magic link 消费失败", undefined, requestId);
      }
    },
  );
}

function getRequestId(value: string | string[] | undefined): string {
  const single = Array.isArray(value) ? value[0] : value;
  const normalized = single?.trim();
  return normalized ? normalized : crypto.randomUUID();
}
