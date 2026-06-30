import type { PrismaClient } from "../../../generated/prisma/index.js";
import Fastify from "fastify";
import { PaymentService } from "../../application/payment-service.js";
import { createPrismaClient } from "../../infrastructure/prisma/prisma-client.js";
import { PrismaPaymentRepository } from "../../infrastructure/prisma/prisma-payment-repository.js";
import type { GrantPurchaseCredits, ReverseCredits } from "../../domain/repository.js";
import { registerPaymentAdminRoutes } from "./admin-routes.js";
import { registerPaymentRoutes } from "./routes.js";

export interface CreatePaymentServerOptions {
  prisma?: PrismaClient;
  grantPurchaseCredits: GrantPurchaseCredits;
  reverseCredits: ReverseCredits;
}

export function createPaymentServer(options: CreatePaymentServerOptions) {
  const app = Fastify({
    logger: false,
  });

  const prisma = options.prisma ?? createPrismaClient();
  const repository = new PrismaPaymentRepository(prisma);
  const service = new PaymentService(
    repository,
    options.grantPurchaseCredits,
    options.reverseCredits,
  );

  registerPaymentRoutes(app, service);
  registerPaymentAdminRoutes(app, repository, service);

  app.addHook("onClose", async () => {
    if (!options.prisma) {
      await prisma.$disconnect();
    }
  });

  return app;
}
