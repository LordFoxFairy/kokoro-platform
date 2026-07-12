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
import { MagicLinkService } from "../../application/magic-link-service.js";
import { SessionService } from "../../application/session-service.js";
import { UserService } from "../../application/user-service.js";
import type { MagicLinkDeliveryMode } from "../../domain/magic-link.js";
import { JoseSessionSigner } from "../../infrastructure/auth/jose-session-signer.js";
import { createPrismaClient } from "../../infrastructure/prisma/prisma-client.js";
import { PrismaMagicLinkRepository } from "../../infrastructure/prisma/prisma-magic-link-repository.js";
import { PrismaUserRepository } from "../../infrastructure/prisma/prisma-user-repository.js";
import { registerUserAdminRoutes } from "./admin-routes.js";
import { registerMagicLinkRoutes } from "./magic-link-routes.js";
import { registerUserRoutes } from "./routes.js";
import { registerSessionRoutes } from "./session-routes.js";

// 缺 secret 时 sessionSigning 省略 → /auth/sessions fail-closed（503），其它路由照常。
export interface SessionSigningOptions {
  secret: string;
  ttlSeconds: number;
  issuer: string;
  now?: () => Date;
}

// 缺省与 env schema 缺省一致；deliveryMode 缺省 log（最安全档，token 不回体）。
export interface MagicLinkServerOptions {
  ttlSeconds?: number;
  deliveryMode?: MagicLinkDeliveryMode;
  rateLimitMax?: number;
  rateLimitWindowSeconds?: number;
  now?: () => Date;
}

export interface CreateUserServerOptions {
  prisma?: PrismaClient;
  sessionSigning?: SessionSigningOptions;
  magicLinks?: MagicLinkServerOptions;
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
  declareRouteAccess(app, "/auth/magic-links", "web-bff");
  declareRouteAccess(app, "/auth/sessions", "runtime-internal");
  declareRouteAccess(app, "/owners", "runtime-internal");
  declareRouteAccess(app, "/users", "runtime-internal");
  declareRouteAccess(app, "/me", "runtime-internal");
  declareRouteAccess(app, "/teams", "runtime-internal");
  declareRouteAccess(app, "/service-accounts", "runtime-internal");
  declareRouteAccess(app, "/memberships", "runtime-internal");
  declareRouteAccess(app, "/admin", "admin");
  declareRouteAccess(app, "/docs", "runtime-internal");

  const prisma = options.prisma ?? createPrismaClient();
  const repository = new PrismaUserRepository(prisma);
  const service = new UserService(repository);
  const signing = options.sessionSigning;
  const sessionService = signing
    ? new SessionService(service, new JoseSessionSigner(signing.secret), {
        issuer: signing.issuer,
        ttlSeconds: signing.ttlSeconds,
        ...(signing.now ? { now: signing.now } : {}),
      })
    : null;

  const magicLinkDefaults = options.magicLinks ?? {};
  const magicLinkNow = magicLinkDefaults.now;
  const magicLinkService = new MagicLinkService(new PrismaMagicLinkRepository(prisma), {
    ttlSeconds: magicLinkDefaults.ttlSeconds ?? 900,
    rateLimitMax: magicLinkDefaults.rateLimitMax ?? 5,
    rateLimitWindowSeconds: magicLinkDefaults.rateLimitWindowSeconds ?? 900,
    ...(magicLinkNow ? { now: magicLinkNow } : {}),
  });
  const magicLinkDeliveryMode: MagicLinkDeliveryMode = magicLinkDefaults.deliveryMode ?? "log";

  // WHY: 路由须包进 register 闭包，确保在异步入队的 swagger 插件之后加载，否则 onRoute 钩子漏采。
  void app.register(async (instance) => {
    registerUserRoutes(instance, service);
    registerSessionRoutes(instance, sessionService);
    registerMagicLinkRoutes(instance, magicLinkService, sessionService, {
      deliveryMode: magicLinkDeliveryMode,
    });
    registerUserAdminRoutes(instance, repository, service);
  });

  app.addHook("onClose", async () => {
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
