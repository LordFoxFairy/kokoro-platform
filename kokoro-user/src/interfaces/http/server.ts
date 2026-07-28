import {
  declareRouteAccess,
  registerOpenApi,
  registerRouteAccess,
  sendError,
  type RouteAccessConfig,
  type ServiceCaller,
} from "@kokoro/platform-kit";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import Fastify from "fastify";
import { Redis } from "ioredis";
import {
  InMemoryMagicLinkRateLimiter,
  RedisMagicLinkRateLimiter,
  type MagicLinkRateLimiter,
} from "../../application/magic-link-rate-limiter.js";
import { MagicLinkService } from "../../application/magic-link-service.js";
import { RefreshService } from "../../application/refresh-service.js";
import { SessionService } from "../../application/session-service.js";
import { TeamService } from "../../application/team-service.js";
import { UserService } from "../../application/user-service.js";
import type { MagicLinkDeliveryMode } from "../../domain/magic-link.js";
import { resolveSessionSigning } from "../../infrastructure/auth/signing.js";
import { createPrismaClient } from "../../infrastructure/prisma/prisma-client.js";
import { PrismaMagicLinkRepository } from "../../infrastructure/prisma/prisma-magic-link-repository.js";
import { PrismaRefreshTokenRepository } from "../../infrastructure/prisma/prisma-refresh-token-repository.js";
import { PrismaUserRepository } from "../../infrastructure/prisma/prisma-user-repository.js";
import { registerUserAdminRoutes } from "./admin-routes.js";
import { registerBffRoutes } from "./bff-routes.js";
import { registerJwksRoutes } from "./jwks-routes.js";
import type { MagicLinkMailer } from "../../infrastructure/email/magic-link-mailer.js";
import { registerMagicLinkRoutes } from "./magic-link-routes.js";
import { registerRefreshRoutes } from "./refresh-routes.js";
import { registerUserRoutes } from "./routes.js";
import { registerSessionRoutes } from "./session-routes.js";

// 签发物料（HS256 secret 或 RS256 私钥，二选一，交由 resolveSessionSigning 裁决）；
// 都不配 → sessionService 省略 → /auth/sessions fail-closed（503）。RS256 档同时挂 JWKS 端点。
// isProduction=true 时未配私钥（HS256/空）→ 启动 fail-fast（纲领生产 fail-closed）。
export interface SessionSigningOptions {
  ttlSeconds: number;
  issuer: string;
  now?: () => Date;
  secret?: string;
  privateKeyPem?: string;
  previousPrivateKeyPem?: string;
  isProduction?: boolean;
  // 长效 refresh token 存活时长（秒）；缺省 30 天。仅在签发档存在时生效（refreshService 与 sessionService 同生同灭）。
  refreshTtlSeconds?: number;
}

// 缺省与 env schema 缺省一致；deliveryMode 缺省 log（最安全档，token 不回体）。
export interface MagicLinkServerOptions {
  ttlSeconds?: number;
  deliveryMode?: MagicLinkDeliveryMode;
  // smtp 档：发信器 + 登录链基址（main.ts 依 env 装配并 fail-fast 校验）。
  mailer?: MagicLinkMailer;
  linkBaseUrl?: string;
  rateLimitMax?: number;
  rateLimitIpMax?: number;
  rateLimitWindowSeconds?: number;
  // 配置即用 Redis 固定窗口限频（多副本一致）；缺省=进程内存。测试可直接注入 rateLimiter 覆盖。
  redisUrl?: string;
  rateLimiter?: MagicLinkRateLimiter;
  now?: () => Date;
}

// 团队自助面配置：邀请 TTL；缺省 7 天。
export interface TeamServerOptions {
  inviteTtlSeconds?: number;
  now?: () => Date;
}

export interface CreateUserServerOptions {
  prisma?: PrismaClient;
  sessionSigning?: SessionSigningOptions;
  magicLinks?: MagicLinkServerOptions;
  teams?: TeamServerOptions;
  // 入站访问控制配置；不传=空 secret + 非生产=dev 直通（测试/本地）；生产由 main.ts 注入 per-caller secret。
  routeAccess?: RouteAccessConfig;
}

// user 所需 caller 凭据：credit(查 owner active)/web-bff(magic-links)/session(收编的 /auth/sessions)/admin(网关) 入站。
const USER_REQUIRED_CALLERS: ServiceCaller[] = ["credit", "web-bff", "session", "admin"];

export function createUserServer(options: CreateUserServerOptions = {}) {
  const app = Fastify({
    logger: false,
  });

  registerOpenApi(app, { title: "Kokoro User API", version: "0.1.0" });
  registerUserErrorHandler(app);

  // 服务间被调面：default-internal。/healthz 公开；/auth/magic-links 仅 web-bff；
  // /auth/sessions 收编 runtime-internal（纲领 §5.1：不再任意签发 oracle）；/admin 仅 admin 网关；其余归 runtime-internal。
  const ra = options.routeAccess ?? { secrets: {}, isProduction: false };
  registerRouteAccess(app, { ...ra, requiredCallers: USER_REQUIRED_CALLERS });
  declareRouteAccess(app, { path: "/healthz", exact: true }, "public");
  declareRouteAccess(app, { path: "/metrics", exact: true }, "public");
  // JWKS 公钥集：公开面（session 验签方无凭据抓取）。RS256 档才真有内容，HS256/未配档不注册路由。
  declareRouteAccess(app, { path: "/.well-known/jwks.json", exact: true }, "public");
  declareRouteAccess(app, "/auth/magic-links", "web-bff");
  // refresh 换签：仅 web-bff（与 magic-links 同鉴权面，web BFF 对接）。
  declareRouteAccess(app, "/auth/refresh", "web-bff");
  declareRouteAccess(app, "/auth/sessions", "runtime-internal");
  declareRouteAccess(app, "/owners", "runtime-internal");
  declareRouteAccess(app, "/users", "runtime-internal");
  declareRouteAccess(app, "/me", "runtime-internal");
  declareRouteAccess(app, "/teams", "runtime-internal");
  declareRouteAccess(app, "/service-accounts", "runtime-internal");
  declareRouteAccess(app, "/memberships", "runtime-internal");
  // 团队自助面：仅 web-bff（携 user principal）。与 runtime-internal 互不越界，user principal 不下传 runtime。
  declareRouteAccess(app, "/bff", "web-bff");
  declareRouteAccess(app, "/admin", "admin");
  declareRouteAccess(app, { path: "/docs/json", exact: true }, "runtime-internal");

  const prisma = options.prisma ?? createPrismaClient();
  const repository = new PrismaUserRepository(prisma);
  const service = new UserService(repository);
  const signing = options.sessionSigning;
  // 签发档位裁决：RS256 私钥 → RS256 + JWKS；HS256 secret → dev 退化；生产未配私钥 → fail-fast。
  const resolvedSigning = signing
    ? resolveSessionSigning({
        privateKeyPem: signing.privateKeyPem,
        previousPrivateKeyPem: signing.previousPrivateKeyPem,
        hs256Secret: signing.secret,
        isProduction: signing.isProduction ?? false,
      })
    : null;
  // refreshService 与 sessionService 同生同灭（都需签发密钥）：无签发档 → 两者皆 null → /auth/refresh 503。
  const refreshService =
    signing && resolvedSigning
      ? new RefreshService(new PrismaRefreshTokenRepository(prisma), resolvedSigning.signer, {
          issuer: signing.issuer,
          jwtTtlSeconds: signing.ttlSeconds,
          refreshTtlSeconds: signing.refreshTtlSeconds ?? 2592000,
          ...(signing.now ? { now: signing.now } : {}),
        })
      : null;
  const sessionService =
    signing && resolvedSigning && refreshService
      ? new SessionService(service, resolvedSigning.signer, refreshService, {
          issuer: signing.issuer,
          ttlSeconds: signing.ttlSeconds,
          ...(signing.now ? { now: signing.now } : {}),
        })
      : null;
  const jwksProvider = resolvedSigning?.jwks ?? null;

  const magicLinkDefaults = options.magicLinks ?? {};
  const magicLinkNow = magicLinkDefaults.now;
  const rateLimitMax = magicLinkDefaults.rateLimitMax ?? 5;
  const rateLimitIpMax = magicLinkDefaults.rateLimitIpMax ?? rateLimitMax * 10;
  const rateLimitWindowSeconds = magicLinkDefaults.rateLimitWindowSeconds ?? 900;
  // 限频后端：显式注入 > Redis（配 redisUrl）> 进程内存（缺省）。Redis client 随 server 关停 quit。
  let redisClient: Redis | null = null;
  let magicLinkRateLimiter: MagicLinkRateLimiter | undefined = magicLinkDefaults.rateLimiter;
  if (!magicLinkRateLimiter && magicLinkDefaults.redisUrl) {
    redisClient = new Redis(magicLinkDefaults.redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
    // 连接期错误只告警不崩（fail-open 由 limiter 兜底）。
    redisClient.on("error", (error: unknown) => {
      console.warn("[kokoro-user] magic-link rate limiter redis error", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    magicLinkRateLimiter = new RedisMagicLinkRateLimiter(
      redisClient,
      { max: rateLimitMax, ipMax: rateLimitIpMax, windowSeconds: rateLimitWindowSeconds },
      {
        warn: (message, meta) => {
          console.warn(`[kokoro-user] ${message}`, meta);
        },
      },
    );
  }
  const magicLinkService = new MagicLinkService(new PrismaMagicLinkRepository(prisma), {
    ttlSeconds: magicLinkDefaults.ttlSeconds ?? 900,
    rateLimitMax,
    rateLimitIpMax,
    rateLimitWindowSeconds,
    ...(magicLinkRateLimiter ? { rateLimiter: magicLinkRateLimiter } : {}),
    ...(magicLinkNow ? { now: magicLinkNow } : {}),
  });
  const magicLinkDeliveryMode: MagicLinkDeliveryMode = magicLinkDefaults.deliveryMode ?? "log";

  // refresh 端点限频复用 magic-link 限频器：有显式/Redis 档则复用（键前缀 refresh-ip: 不与 email 交叉），
  // 否则给 refresh 一个独立进程内存实例（单副本 dev）。配置数值沿用 magic-link（不新增 env）。
  const refreshRateLimiter: MagicLinkRateLimiter =
    magicLinkRateLimiter ??
    new InMemoryMagicLinkRateLimiter({
      max: rateLimitMax,
      ipMax: rateLimitIpMax,
      windowSeconds: rateLimitWindowSeconds,
    });

  const teamDefaults = options.teams ?? {};
  const teamService = new TeamService(repository, {
    inviteTtlSeconds: teamDefaults.inviteTtlSeconds ?? 604800,
    ...(teamDefaults.now ? { now: teamDefaults.now } : {}),
  });

  // WHY: 路由须包进 register 闭包，确保在异步入队的 swagger 插件之后加载，否则 onRoute 钩子漏采。
  void app.register(async (instance) => {
    registerUserRoutes(instance, service);
    registerSessionRoutes(instance, sessionService);
    registerBffRoutes(instance, teamService, sessionService);
    registerMagicLinkRoutes(instance, magicLinkService, sessionService, {
      deliveryMode: magicLinkDeliveryMode,
      ...(magicLinkDefaults.mailer ? { mailer: magicLinkDefaults.mailer } : {}),
      ...(magicLinkDefaults.linkBaseUrl ? { linkBaseUrl: magicLinkDefaults.linkBaseUrl } : {}),
    });
    registerRefreshRoutes(instance, refreshService, {
      rateLimiter: refreshRateLimiter,
      ...(magicLinkNow ? { now: magicLinkNow } : {}),
    });
    if (jwksProvider) {
      registerJwksRoutes(instance, jwksProvider);
    }
    registerUserAdminRoutes(instance, repository, service);
  });

  app.addHook("onClose", async () => {
    if (redisClient) {
      redisClient.disconnect();
    }
    if (!options.prisma) {
      await prisma.$disconnect();
    }
  });

  return app;
}

function registerUserErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const requestId = getRequestId(request.headers);
    const client = asClientError(error);
    if (client) {
      return sendError(reply, client.statusCode, client.code, client.message, undefined, requestId);
    }

    request.log.error({ error }, "unexpected user http error");
    return sendError(reply, 500, "internal.error", "内部错误", undefined, requestId);
  });
}

function asClientError(error: unknown): { statusCode: number; code: string; message: string } | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("statusCode" in error) ||
    typeof error.statusCode !== "number" ||
    error.statusCode < 400 ||
    error.statusCode >= 500
  ) {
    return null;
  }

  const fastifyCode = "code" in error && typeof error.code === "string" ? error.code : undefined;
  const isValidationError =
    fastifyCode === "FST_ERR_VALIDATION" || ("validation" in error && Array.isArray(error.validation));
  const code = isValidationError ? "request.invalid" : fastifyCode ?? "request.invalid";
  const message =
    isValidationError ? "请求参数无效" : "message" in error && typeof error.message === "string" ? error.message : "请求无效";
  return { statusCode: error.statusCode, code, message };
}

function getRequestId(headers: FastifyRequest["headers"]): string {
  return (
    headerValue(headers, "x-kokoro-request-id") ??
    headerValue(headers, "x-request-id") ??
    crypto.randomUUID()
  );
}

function headerValue(headers: FastifyRequest["headers"], key: string): string | undefined {
  const value = headers[key];
  return Array.isArray(value) ? value[0] : value;
}
