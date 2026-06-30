import { registerOpenApi } from "@kokoro/platform-kit";
import type { PrismaClient } from "@prisma/client";
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
