import type { PrismaClient } from "../../../generated/prisma/index.js";
import { registerOpenApi } from "@kokoro/platform-kit";
import Fastify from "fastify";
import { CreditService } from "../../application/credit-service.js";
import { createPrismaClient } from "../../infrastructure/prisma/prisma-client.js";
import { PrismaCreditRepository } from "../../infrastructure/prisma/prisma-credit-repository.js";
import { registerCreditAdminRoutes } from "./admin-routes.js";
import { registerCreditRoutes } from "./routes.js";

export interface CreateCreditServerOptions {
  prisma?: PrismaClient;
}

export function createCreditServer(options: CreateCreditServerOptions = {}) {
  const app = Fastify({
    logger: false,
  });

  registerOpenApi(app, { title: "Kokoro Credit API", version: "0.1.0" });

  const prisma = options.prisma ?? createPrismaClient();
  const repository = new PrismaCreditRepository(prisma);
  const service = new CreditService(repository);

  // WHY: 包进 register 确保路由在 swagger onRoute 钩子就绪后加载，否则 /docs/json paths 漏采。
  void app.register(async (instance) => {
    registerCreditRoutes(instance, service);
    registerCreditAdminRoutes(instance, repository, service);
  });

  app.addHook("onClose", async () => {
    if (!options.prisma) {
      await prisma.$disconnect();
    }
  });

  return app;
}
