import type { PrismaClient } from "@prisma/client";
import Fastify from "fastify";
import { UserService } from "../../application/user-service.js";
import { createPrismaClient } from "../../infrastructure/prisma/prisma-client.js";
import { PrismaUserRepository } from "../../infrastructure/prisma/prisma-user-repository.js";
import { registerUserRoutes } from "./routes.js";

export interface CreateUserServerOptions {
  prisma?: PrismaClient;
}

export function createUserServer(options: CreateUserServerOptions = {}) {
  const app = Fastify({
    logger: false,
  });

  const prisma = options.prisma ?? createPrismaClient();
  const repository = new PrismaUserRepository(prisma);
  const service = new UserService(repository);

  registerUserRoutes(app, service);

  app.addHook("onClose", async () => {
    if (!options.prisma) {
      await prisma.$disconnect();
    }
  });

  return app;
}
