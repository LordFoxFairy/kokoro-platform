import {
  declareRouteAccess,
  isProductionEnv,
  registerOpenApi,
  registerRouteAccess,
  sendError,
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
const PAYMENT_ROUTE_ADMISSION = Symbol("payment.route.admission");

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
    readonly duplicates: string[] = [],
    readonly routingMetadata: string[] = [],
  ) {
    super(
      [
        `payment runtime route inventory mismatch: missing=${missing.join(",")}`,
        `unexpected=${unexpected.join(",")}`,
        `duplicates=${duplicates.join(",")}`,
        `routingMetadata=${routingMetadata.join(",")}`,
      ].join("; "),
    );
    this.name = "PaymentRouteInventoryError";
  }
}

function registerPaymentRouteInventory(app: FastifyInstance): void {
  const expected = new Set<string>(PAYMENT_RUNTIME_ROUTE_INVENTORY);
  const observed = new Map<string, number>();
  const routingMetadata = new Set<string>();
  const admissions = new WeakSet<object>();
  const originalHandlers = new Map<string, unknown>();
  const finalHandlers = new Map<string, unknown>();

  // onRoute observes Fastify's real registration path, including encapsulated plugins,
  // aliases and schema.hide routes. OpenAPI visibility is deliberately irrelevant here.
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const routeKeys = methods.map((method) => `${method.toUpperCase()} ${route.url}`);
    for (const routeKey of routeKeys) {
      observed.set(routeKey, (observed.get(routeKey) ?? 0) + 1);
      if (!originalHandlers.has(routeKey)) originalHandlers.set(routeKey, route.handler);
    }

    const originalHandler = route.handler;
    const handlerDescriptor = Object.getOwnPropertyDescriptor(route, "handler");
    Object.defineProperty(route, "handler", {
      configurable: false,
      enumerable: handlerDescriptor?.enumerable ?? true,
      get: () => originalHandler,
      set: (replacement) => {
        if (replacement === originalHandler) return;
        for (const routeKey of routeKeys) routingMetadata.add(`${routeKey}:handler`);
      },
    });

    if (route.constraints !== undefined && Reflect.ownKeys(route.constraints).length > 0) {
      routingMetadata.add(`${routeKeys.join("|")}:constraints`);
    }
    if (route.prefixTrailingSlash !== undefined) {
      routingMetadata.add(`${routeKeys.join("|")}:prefixTrailingSlash`);
    }
    if (Reflect.get(route, "websocket") === true) {
      routingMetadata.add(`${routeKeys.join("|")}:websocket`);
    }
    if (Reflect.get(route, "version") !== undefined) {
      routingMetadata.add(`${routeKeys.join("|")}:version`);
    }

    const admission = Object.freeze({ routeKeys: Object.freeze(routeKeys) });
    admissions.add(admission);
    const config = { ...(route.config ?? {}) };
    Object.defineProperty(config, PAYMENT_ROUTE_ADMISSION, {
      configurable: false,
      enumerable: true,
      value: admission,
      writable: false,
    });
    route.config = config;
  });
  app.addHook("onReady", () => {
    const missing = new Set(
      [...expected].filter((route) => (observed.get(route) ?? 0) === 0),
    );
    const unexpected = [...observed.keys()].filter((route) => !expected.has(route)).sort();
    const duplicates = [...observed]
      .filter(([route, count]) => expected.has(route) && count !== 1)
      .map(([route, count]) => `${route}#${count}`)
      .sort();

    for (const route of expected) {
      const separator = route.indexOf(" ");
      const method = route.slice(0, separator);
      const url = route.slice(separator + 1);
      if (!app.hasRoute({ method, url })) {
        missing.add(route);
        continue;
      }
      const found = app.findRoute({ method, url });
      if (found === undefined || found === null) {
        missing.add(route);
        continue;
      }
      if (!originalHandlers.has(route)) routingMetadata.add(`${route}:handler`);
      finalHandlers.set(route, found.handler);
    }

    if (
      missing.size > 0 ||
      unexpected.length > 0 ||
      duplicates.length > 0 ||
      routingMetadata.size > 0
    ) {
      throw new PaymentRouteInventoryError(
        [...missing].sort(),
        unexpected,
        duplicates,
        [...routingMetadata].sort(),
      );
    }
  });
  app.addHook("onRequest", async (request, reply) => {
    const routeUrl = request.routeOptions.url;
    if (request.is404 || routeUrl === undefined) return;

    const routeKey = `${request.method.toUpperCase()} ${routeUrl}`;
    const admission = Reflect.get(request.routeOptions.config, PAYMENT_ROUTE_ADMISSION);
    const admitted =
      typeof admission === "object" &&
      admission !== null &&
      admissions.has(admission) &&
      Array.isArray(Reflect.get(admission, "routeKeys")) &&
      Reflect.get(admission, "routeKeys").includes(routeKey);
    const matched = app.findRoute({ method: request.method, url: request.url });
    if (
      !admitted ||
      matched === undefined ||
      matched === null ||
      matched.handler !== finalHandlers.get(routeKey)
    ) {
      return sendError(
        reply,
        503,
        "payment.route_inventory_mismatch",
        "Payment route admission failed",
        undefined,
        request.id,
      );
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
