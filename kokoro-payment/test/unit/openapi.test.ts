import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, RouteHandler } from "fastify";
import { isProductionEnv } from "@kokoro/platform-kit";
import type { PaymentReadCapabilities } from "../../src/domain/read-repository.js";
import { createPrismaClient } from "../../src/infrastructure/prisma/prisma-client.js";
import { createPrismaPaymentReadCapabilities } from "../../src/infrastructure/prisma/prisma-payment-read-repository.js";
import { createPaymentServer } from "../../src/interfaces/http/server.js";

// WHY: /docs/json 不触发任何查询，dummy URL 的 client 不会真实连接。
const prisma = createPrismaClient("postgresql://user:pass@localhost:5432/payment");
const emptyRows = async () => [];
const emptyReadCapabilities: PaymentReadCapabilities = {
  catalog: { listPlans: emptyRows },
  admin: {
    listOrders: emptyRows,
    listPaymentEvents: emptyRows,
    listPlans: emptyRows,
    listProviders: emptyRows,
    listRefunds: emptyRows,
    listSubscriptions: emptyRows,
    readAdminStats: async () => ({
      ordersTotal: 0,
      ordersPaid: 0,
      ordersPending: 0,
      ordersRefunded: 0,
      ordersCanceled: 0,
      revenueByCurrency: [],
    }),
  },
};

const EXPECTED_HTTP_INVENTORY = [
  "GET /admin/payments/events",
  "GET /admin/payments/manifest",
  "GET /admin/payments/orders",
  "GET /admin/payments/plans",
  "GET /admin/payments/providers",
  "GET /admin/payments/refunds",
  "GET /admin/payments/stats",
  "GET /admin/payments/subscriptions",
  "GET /healthz",
  "GET /metrics",
  "GET /plans",
  "POST /orders",
  "POST /orders/checkout",
  "POST /orders/sweep",
  "POST /orders/{id}/confirm",
  "POST /orders/{id}/refund",
  "POST /payment-events/record",
  "POST /payments/webhooks/{provider}",
] as const;

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);
type HiddenRouteRegistrar = (
  path: string,
  options: { schema: { hide: true } },
  handler: RouteHandler,
) => unknown;

function httpInventory(paths: Record<string, Record<string, unknown>>): string[] {
  return Object.entries(paths)
    .flatMap(([path, operations]) =>
      Object.keys(operations)
        .filter((method) => HTTP_METHODS.has(method))
        .map((method) => `${method.toUpperCase()} ${path}`),
    )
    .sort();
}

function inventoryDiff(paths: Record<string, Record<string, unknown>>) {
  const actual = httpInventory(paths);
  return {
    missing: EXPECTED_HTTP_INVENTORY.filter((route) => !actual.includes(route)),
    unexpected: actual.filter((route) => !EXPECTED_HTTP_INVENTORY.includes(route as (typeof EXPECTED_HTTP_INVENTORY)[number])),
  };
}

describe("payment OpenAPI", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["development", "production"] as const)(
    "serves the exact /docs/json route inventory with NODE_ENV=%s",
    async (nodeEnv) => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      vi.stubEnv("KOKORO_ENV", "");
      const app = createPaymentServer({
        readCapabilities: createPrismaPaymentReadCapabilities(prisma),
        routeAccess: {
          secrets: { admin: "admin-secret", "web-bff": "web-secret" },
          isProduction: isProductionEnv(),
        },
      });
      try {
        const response = await app.inject({
          method: "GET",
          url: "/docs/json",
          headers: {
            "x-kokoro-service": "admin",
            "x-kokoro-internal-secret": "admin-secret",
          },
        });
        expect(response.statusCode).toBe(200);
        const body = response.json<{
          openapi?: string;
          paths: Record<string, Record<string, unknown>>;
        }>();
        expect(body.openapi).toBeTruthy();
        expect(inventoryDiff(body.paths)).toEqual({ missing: [], unexpected: [] });
      } finally {
        await app.close();
      }
    },
  );

  it("makes every extra, removed, or method-changed route fail the inventory", () => {
    const baseline = Object.fromEntries(
      EXPECTED_HTTP_INVENTORY.map((entry) => {
        const separator = entry.indexOf(" ");
        const method = entry.slice(0, separator).toLowerCase();
        const path = entry.slice(separator + 1);
        return [path, { [method]: {} }];
      }),
    );
    expect(inventoryDiff({ ...baseline, "/orders/reopen": { post: {} } }).unexpected).toEqual([
      "POST /orders/reopen",
    ]);
    const { "/plans": _removed, ...withoutPlans } = baseline;
    expect(inventoryDiff(withoutPlans).missing).toContain("GET /plans");
    expect(inventoryDiff({ ...baseline, "/plans": { post: {} } })).toMatchObject({
      missing: expect.arrayContaining(["GET /plans"]),
      unexpected: expect.arrayContaining(["POST /plans"]),
    });
  });

  it.each([
    ["direct", (router: FastifyInstance, handler: RouteHandler) =>
      router.post("/orders/reopen", { schema: { hide: true } }, handler)],
    ["bind", (router: FastifyInstance, handler: RouteHandler) => {
      const register = router.post.bind(router);
      register("/orders/reopen", { schema: { hide: true } }, handler);
    }],
    ["call", (router: FastifyInstance, handler: RouteHandler) => {
      const register = router.post as unknown as HiddenRouteRegistrar;
      register.call(router, "/orders/reopen", { schema: { hide: true } }, handler);
    }],
    ["apply", (router: FastifyInstance, handler: RouteHandler) => {
      const register = router.post as unknown as HiddenRouteRegistrar;
      const args: Parameters<HiddenRouteRegistrar> = [
        "/orders/reopen",
        { schema: { hide: true } },
        handler,
      ];
      register.apply(router, args);
    }],
  ] as const)("rejects an actual hidden route registered through %s", async (_name, register) => {
    const app = createPaymentServer({
      readCapabilities: createPrismaPaymentReadCapabilities(prisma),
    });
    void app.register(async function hiddenAcquisitionPlugin(arbitraryPluginInstance) {
      register(arbitraryPluginInstance, async () => ({ ok: true }));
    });

    let startupError: unknown;
    try {
      await app.ready();
    } catch (error) {
      startupError = error;
    } finally {
      await app.close();
    }
    expect(startupError).toMatchObject({ code: "payment.route_inventory_mismatch" });
  });

  it("rejects a constrained duplicate instead of collapsing route cardinality", async () => {
    const app = createPaymentServer({
      readCapabilities: emptyReadCapabilities,
      routeAccess: {
        secrets: { admin: "admin-secret", "web-bff": "web-secret" },
        isProduction: true,
      },
    });
    app.post(
      "/orders",
      { constraints: { host: "acquisition-bypass.example" } },
      async () => ({ bypass: true }),
    );

    let startupError: unknown;
    try {
      await app.ready();
    } catch (error) {
      startupError = error;
    } finally {
      await app.close();
    }
    expect(startupError).toMatchObject({ code: "payment.route_inventory_mismatch" });
  });

  it("rejects a route URL changed by a later descendant onRoute hook", async () => {
    const app = createPaymentServer({
      readCapabilities: createPrismaPaymentReadCapabilities(prisma),
      routeAccess: {
        secrets: { admin: "admin-secret", "web-bff": "web-secret" },
        isProduction: true,
      },
    });
    app.addHook("onRoute", (route) => {
      if (route.method === "GET" && route.url === "/plans") {
        Reflect.set(route, "url", "/stealth-plans");
      }
    });

    let startupError: unknown;
    try {
      await app.ready();
    } catch (error) {
      startupError = error;
    } finally {
      await app.close();
    }
    expect(startupError).toMatchObject({ code: "payment.route_inventory_mismatch" });
  });

  it("rejects a route handler changed by a later descendant onRoute hook", async () => {
    const app = createPaymentServer({
      readCapabilities: emptyReadCapabilities,
      routeAccess: {
        secrets: { admin: "admin-secret", "web-bff": "web-secret" },
        isProduction: true,
      },
    });
    app.addHook("onRoute", (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      if (methods.includes("POST") && route.url === "/orders") {
        route.handler = async () => ({ bypass: true });
      }
    });

    let startupError: unknown;
    try {
      await app.ready();
    } catch (error) {
      startupError = error;
    } finally {
      await app.close();
    }
    expect(startupError).toMatchObject({ code: "payment.route_inventory_mismatch" });
  });

  it("fails closed at request time when later hooks strip route admission metadata", async () => {
    const app = createPaymentServer({
      readCapabilities: emptyReadCapabilities,
      routeAccess: {
        secrets: { admin: "admin-secret", "web-bff": "web-secret" },
        isProduction: true,
      },
    });
    app.addHook("onRoute", (route) => {
      if (route.method === "GET" && route.url === "/plans") {
        Reflect.set(route, "config", Object.fromEntries(Object.entries(route.config ?? {})));
      }
    });

    try {
      await app.ready();
      const response = await app.inject({
        method: "GET",
        url: "/plans",
        headers: {
          "x-kokoro-service": "web-bff",
          "x-kokoro-internal-secret": "web-secret",
          "x-kokoro-site-id": "site-1",
        },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: { code: "payment.route_inventory_mismatch" },
      });
    } finally {
      await app.close();
    }
  });

  it("uses the actual process environment for production credential fail-fast", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("KOKORO_ENV", "");
    expect(isProductionEnv()).toBe(true);
    expect(() =>
      createPaymentServer({
        readCapabilities: createPrismaPaymentReadCapabilities(prisma),
      }),
    ).toThrow();

    vi.stubEnv("NODE_ENV", "development");
    expect(isProductionEnv()).toBe(false);
    const developmentApp = createPaymentServer({
      readCapabilities: createPrismaPaymentReadCapabilities(prisma),
    });
    await developmentApp.close();
  });
});
