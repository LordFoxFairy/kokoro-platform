import { registerOpenApi, sendError } from "@kokoro/platform-kit";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import Fastify from "fastify";
import { UserService } from "../../application/user-service.js";
import { createPrismaClient } from "../../infrastructure/prisma/prisma-client.js";
import { PrismaUserRepository } from "../../infrastructure/prisma/prisma-user-repository.js";
import { registerUserAdminRoutes } from "./admin-routes.js";
import { registerUserRoutes } from "./routes.js";

export interface CreateUserServerOptions {
  prisma?: PrismaClient;
}

export function createUserServer(options: CreateUserServerOptions = {}) {
  const app = Fastify({
    logger: false,
  });

  registerOpenApi(app, { title: "Kokoro User API", version: "0.1.0" });
  registerUserErrorHandler(app);

  const prisma = options.prisma ?? createPrismaClient();
  const repository = new PrismaUserRepository(prisma);
  const service = new UserService(repository);

  // WHY: 路由须包进 register 闭包，确保在异步入队的 swagger 插件之后加载，否则 onRoute 钩子漏采。
  void app.register(async (instance) => {
    registerUserRoutes(instance, service);
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
