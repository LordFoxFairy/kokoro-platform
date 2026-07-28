import {
  declareRouteAccess,
  isProductionEnv,
  registerOpenApi,
  registerRouteAccess,
  type RouteAccessConfig,
  type ServiceCaller,
} from "@kokoro/platform-kit";
import Fastify from "fastify";
import type { PrismaClient } from "../../../generated/prisma/index.js";
import { createPrismaClient } from "../../infrastructure/prisma/prisma-client.js";
import { PrismaPaymentRepository } from "../../infrastructure/prisma/prisma-payment-repository.js";
import { registerPaymentAdminRoutes } from "./admin-routes.js";
import { createPaymentReadRepository } from "./read-repository.js";
import { registerPaymentRoutes } from "./routes.js";
import { registerPaymentWebhookRoutes } from "./webhook-routes.js";

export interface CreatePaymentServerOptions {
  prisma?: PrismaClient;
  routeAccess?: RouteAccessConfig;
}

const PAYMENT_REQUIRED_CALLERS: ServiceCaller[] = ["admin", "web-bff"];

export function createPaymentServer(options: CreatePaymentServerOptions = {}) {
  const app = Fastify({ logger: false });
  registerOpenApi(app, { title: "Kokoro Payment Catalogue API", version: "0.1.0" });

  const ra = options.routeAccess ?? { secrets: {}, isProduction: isProductionEnv() };
  registerRouteAccess(app, { ...ra, requiredCallers: PAYMENT_REQUIRED_CALLERS });
  declareRouteAccess(app, { path: "/healthz", exact: true }, "public");
  declareRouteAccess(app, { path: "/metrics", exact: true }, "public");
  declareRouteAccess(app, "/payments/webhooks", "public");
  declareRouteAccess(app, { path: "/plans", exact: true }, "web-bff");
  declareRouteAccess(app, "/orders/checkout", "web-bff");
  declareRouteAccess(app, "/admin", "admin");
  // Preserve the existing caller boundary while returning a fail-closed response:
  // checkout belongs to Web BFF; order lifecycle and payment events belong to services.
  declareRouteAccess(app, "/orders", "runtime-internal");
  declareRouteAccess(app, "/payment-events", "runtime-internal");
  declareRouteAccess(app, "/docs", "admin");

  const prisma = options.prisma ?? createPrismaClient();
  const repository = createPaymentReadRepository(new PrismaPaymentRepository(prisma));

  void app.register(async (instance) => {
    registerPaymentRoutes(instance, repository);
    registerPaymentAdminRoutes(instance, repository);
  });
  void app.register(async (instance) => {
    registerPaymentWebhookRoutes(instance);
  });

  app.addHook("onClose", async () => {
    if (!options.prisma) await prisma.$disconnect();
  });
  return app;
}
