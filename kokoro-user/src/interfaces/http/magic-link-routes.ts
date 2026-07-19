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
import type { MagicLinkMailer } from "../../infrastructure/email/magic-link-mailer.js";
import { consumeMagicLinkRequestSchema, requestMagicLinkRequestSchema } from "./schemas.js";

export interface MagicLinkRouteOptions {
  deliveryMode: MagicLinkDeliveryMode;
  // smtp 档必备：发信器 + 登录链基址（main.ts 在 mode=smtp 时装配并已 fail-fast 校验齐全）。
  mailer?: MagicLinkMailer | undefined;
  linkBaseUrl?: string | undefined;
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
          // email+ip 两维限频；request.ip 由 fastify 从 socket/信任代理解析。
          ip: request.ip,
        });

        if (options.deliveryMode === "response") {
          // response 档仅限 dev 部署（生产 main.ts fail-fast 禁用）：一次性原文 token 直接回响应体。
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
        if (options.deliveryMode === "smtp") {
          // smtp 档：原文 token 只进邮件（不回体、不落日志）。链 = <base>?token=<原文>。
          if (!options.mailer || !options.linkBaseUrl) {
            request.log.error("smtp delivery misconfigured: missing mailer/linkBaseUrl");
            return sendError(reply, 500, "auth.magic_link_delivery_misconfigured", "登录邮件投递未配置", undefined, requestId);
          }
          const url = `${options.linkBaseUrl}?token=${encodeURIComponent(issued.linkToken)}`;
          const expiresInSeconds = Math.max(
            1,
            Math.round((issued.record.expiresAt.getTime() - Date.now()) / 1000),
          );
          try {
            await options.mailer.send({ to: issued.record.email, url, expiresInSeconds });
          } catch (mailError) {
            // 发信失败不泄露账户存在性细节给客户端；只上抛 502 + 服务端记因。
            request.log.error({ mailError }, "failed to send magic link email");
            return sendError(reply, 502, "auth.magic_link_delivery_failed", "登录邮件发送失败", undefined, requestId);
          }
          return sendData(
            reply,
            { email: issued.record.email, expires_at: issued.record.expiresAt.toISOString() },
            200,
            requestId,
          );
        }
        // log 档（缺省）：原文 token 绝不落日志（纲领：magic-link 原文不进日志）。只记哈希前缀做审计关联。
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
            refresh_token: issued.refreshToken,
            refresh_expires_at: issued.refreshExpiresAt.toISOString(),
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
