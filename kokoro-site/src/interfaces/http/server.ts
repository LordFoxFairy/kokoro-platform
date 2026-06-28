import type { PrismaClient } from "../../../generated/prisma/index.js";
import Fastify from "fastify";
import { SiteService } from "../../application/site-service.js";
import { createPrismaClient } from "../../infrastructure/prisma/prisma-client.js";
import { PrismaSiteRepository } from "../../infrastructure/prisma/prisma-site-repository.js";
import { registerSiteRoutes } from "./routes.js";

export interface CreateSiteServerOptions {
  prisma?: PrismaClient;
}

export function createSiteServer(options: CreateSiteServerOptions = {}) {
  const app = Fastify({
    logger: false,
  });

  const prisma = options.prisma ?? createPrismaClient();
  const repository = new PrismaSiteRepository(prisma);
  const service = new SiteService(repository);

  registerSiteRoutes(app, service);

  app.addHook("onClose", async () => {
    if (!options.prisma) {
      await prisma.$disconnect();
    }
  });

  return app;
}
