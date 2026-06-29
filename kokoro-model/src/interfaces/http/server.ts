import type { PrismaClient } from "../../../generated/prisma/index.js";
import Fastify from "fastify";
import { ModelService } from "../../application/model-service.js";
import { createPrismaClient } from "../../infrastructure/prisma/prisma-client.js";
import { PrismaModelRepository } from "../../infrastructure/prisma/prisma-model-repository.js";
import { registerModelAdminRoutes } from "./admin-routes.js";
import { registerModelRoutes } from "./routes.js";

export interface CreateModelServerOptions {
  prisma?: PrismaClient;
}

export function createModelServer(options: CreateModelServerOptions = {}) {
  const app = Fastify({
    logger: false,
  });

  const prisma = options.prisma ?? createPrismaClient();
  const repository = new PrismaModelRepository(prisma);
  const service = new ModelService(repository);

  registerModelRoutes(app, service);
  registerModelAdminRoutes(app, repository);

  app.addHook("onClose", async () => {
    if (!options.prisma) {
      await prisma.$disconnect();
    }
  });

  return app;
}
