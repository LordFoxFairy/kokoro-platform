import { registerInternalSecretGuard, registerOpenApi } from "@kokoro/platform-kit";
import type { PrismaClient } from "../../../generated/prisma/index.js";
import Fastify from "fastify";
import { ModelService } from "../../application/model-service.js";
import { createPrismaClient } from "../../infrastructure/prisma/prisma-client.js";
import { PrismaModelRepository } from "../../infrastructure/prisma/prisma-model-repository.js";
import { registerModelAdminRoutes } from "./admin-routes.js";
import { registerModelRoutes } from "./routes.js";

export interface CreateModelServerOptions {
  prisma?: PrismaClient;
  // 入站信任密钥；不传/空串=受保护端点直通（测试/本地）；生产由 main.ts 从 env 注入启用 fail-closed。
  internalSecret?: string;
}

export function createModelServer(options: CreateModelServerOptions = {}) {
  const app = Fastify({
    logger: false,
  });

  // WHY: swagger 的 onRoute 钩子须先于路由装好，故 registerOpenApi 须在任何路由注册前调用。
  registerOpenApi(app, { title: "Kokoro Model API", version: "0.1.0" });

  // 服务间被调面：/admin(网关) 校验内部密钥；未配置直通。
  registerInternalSecretGuard(app, {
    secret: options.internalSecret ?? "",
    protectedPrefixes: ["/admin"],
  });

  const prisma = options.prisma ?? createPrismaClient();
  const repository = new PrismaModelRepository(prisma);
  const service = new ModelService(repository);

  // WHY: 路由须包进异步 plugin，确保在 swagger(void register 入队)之后加载，否则 onRoute 漏采 → /docs/json paths 为空。
  void app.register(async (instance) => {
    registerModelRoutes(instance, service);
    registerModelAdminRoutes(instance, repository);
  });

  app.addHook("onClose", async () => {
    if (!options.prisma) {
      await prisma.$disconnect();
    }
  });

  return app;
}
