import type { PrismaClient } from "../../../generated/prisma/index.js";
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

  const prisma = options.prisma ?? createPrismaClient();
  const repository = new PrismaCreditRepository(prisma);
  const service = new CreditService(repository);

  registerCreditRoutes(app, service);
  registerCreditAdminRoutes(app, repository, service);

  app.addHook("onClose", async () => {
    if (!options.prisma) {
      await prisma.$disconnect();
    }
  });

  return app;
}
