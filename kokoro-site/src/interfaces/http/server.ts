import type { PrismaClient } from "../../../generated/prisma/index.js";
import { registerOpenApi } from "@kokoro/platform-kit";
import Fastify from "fastify";
import { SiteService } from "../../application/site-service.js";
import { createPrismaClient } from "../../infrastructure/prisma/prisma-client.js";
import { PrismaSiteRepository } from "../../infrastructure/prisma/prisma-site-repository.js";
import { registerSiteAdminRoutes } from "./admin-routes.js";
import { registerSiteRoutes } from "./routes.js";

export interface CreateSiteServerOptions {
  prisma?: PrismaClient;
}

export function createSiteServer(options: CreateSiteServerOptions = {}) {
  const app = Fastify({
    logger: false,
  });

  registerOpenApi(app, { title: "Kokoro Site API", version: "0.1.0" });

  const prisma = options.prisma ?? createPrismaClient();
  const repository = new PrismaSiteRepository(prisma);
  const service = new SiteService(repository);

  // 路由须晚于 swagger 插件加载，否则 onRoute 钩子漏采 → /docs/json paths 为空。
  void app.register(async (instance) => {
    registerSiteRoutes(instance, service);
    registerSiteAdminRoutes(instance, repository);
  });

  app.addHook("onClose", async () => {
    if (!options.prisma) {
      await prisma.$disconnect();
    }
  });

  return app;
}
