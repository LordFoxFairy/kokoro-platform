import {
  declareRouteAccess,
  isProductionEnv,
  registerOpenApi,
  registerRouteAccess,
  type RouteAccessConfig,
  type ServiceCaller,
} from "@kokoro/platform-kit";
import Fastify, { type FastifyInstance } from "fastify";
import type { PaymentReadCapabilities } from "../../domain/read-repository.js";
import { registerPaymentAdminRoutes } from "./admin-routes.js";
import { registerPaymentRoutes } from "./routes.js";
import { registerPaymentWebhookRoutes } from "./webhook-routes.js";

export interface CreatePaymentServerOptions {
  readCapabilities: PaymentReadCapabilities;
  closeReadStore?: () => Promise<void>;
  routeAccess?: RouteAccessConfig;
}

const PAYMENT_REQUIRED_CALLERS: ServiceCaller[] = ["admin", "web-bff"];

const PAYMENT_RUNTIME_ROUTE_INVENTORY = Object.freeze([
  "GET /admin/payments/events",
  "GET /admin/payments/manifest",
  "GET /admin/payments/orders",
  "GET /admin/payments/plans",
  "GET /admin/payments/providers",
  "GET /admin/payments/refunds",
  "GET /admin/payments/stats",
  "GET /admin/payments/subscriptions",
  "GET /docs",
  "GET /docs/json",
  "GET /docs/static/*",
  "GET /docs/static/index.html",
  "GET /docs/static/swagger-initializer.js",
  "GET /docs/yaml",
  "GET /healthz",
  "GET /metrics",
  "GET /plans",
  "HEAD /admin/payments/events",
  "HEAD /admin/payments/manifest",
  "HEAD /admin/payments/orders",
  "HEAD /admin/payments/plans",
  "HEAD /admin/payments/providers",
  "HEAD /admin/payments/refunds",
  "HEAD /admin/payments/stats",
  "HEAD /admin/payments/subscriptions",
  "HEAD /docs",
  "HEAD /docs/",
  "HEAD /docs/json",
  "HEAD /docs/static/*",
  "HEAD /docs/static/index.html",
  "HEAD /docs/static/swagger-initializer.js",
  "HEAD /docs/yaml",
  "HEAD /healthz",
  "HEAD /metrics",
  "HEAD /plans",
  "POST /orders",
  "POST /orders/:id/confirm",
  "POST /orders/:id/refund",
  "POST /orders/checkout",
  "POST /orders/sweep",
  "POST /payment-events/record",
  "POST /payments/webhooks/:provider",
] as const);

export class PaymentRouteInventoryError extends Error {
  readonly code = "payment.route_inventory_mismatch";

  constructor(
    readonly missing: string[],
    readonly unexpected: string[],
  ) {
    super(
      `payment runtime route inventory mismatch: missing=${missing.join(",")}; unexpected=${unexpected.join(",")}`,
    );
    this.name = "PaymentRouteInventoryError";
  }
}

function registerPaymentRouteInventory(app: FastifyInstance): void {
  const expected = new Set<string>(PAYMENT_RUNTIME_ROUTE_INVENTORY);
  const observed = new Set<string>();

  // onRoute observes Fastify's real registration path, including encapsulated plugins,
  // aliases and schema.hide routes. OpenAPI visibility is deliberately irrelevant here.
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) observed.add(`${method.toUpperCase()} ${route.url}`);
  });
  app.addHook("onReady", () => {
    const missing = [...expected].filter((route) => !observed.has(route)).sort();
    const unexpected = [...observed].filter((route) => !expected.has(route)).sort();
    if (missing.length > 0 || unexpected.length > 0) {
      throw new PaymentRouteInventoryError(missing, unexpected);
    }
  });
}

export function createPaymentServer(options: CreatePaymentServerOptions) {
  const app = Fastify({ logger: false });
  registerPaymentRouteInventory(app);
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

  void app.register(async (instance) => {
    registerPaymentRoutes(instance, options.readCapabilities.catalog);
    registerPaymentAdminRoutes(instance, options.readCapabilities.admin);
  });
  void app.register(async (instance) => {
    registerPaymentWebhookRoutes(instance);
  });

  if (options.closeReadStore) app.addHook("onClose", options.closeReadStore);
  return app;
}
