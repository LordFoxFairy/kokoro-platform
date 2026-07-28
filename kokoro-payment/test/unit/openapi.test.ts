import { describe, expect, it } from "vitest";
import { createPrismaClient } from "../../src/infrastructure/prisma/prisma-client.js";
import { createPaymentServer } from "../../src/interfaces/http/server.js";

// WHY: /docs/json 不触发任何查询，dummy URL 的 client 不会真实连接。
const prisma = createPrismaClient("postgresql://user:pass@localhost:5432/payment");

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
  it("serves /docs/json with collected route paths", async () => {
    const app = createPaymentServer({ prisma });
    try {
      const response = await app.inject({ method: "GET", url: "/docs/json" });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ openapi?: string; paths: Record<string, Record<string, unknown>> }>();
      expect(body.openapi).toBeTruthy();
      expect(inventoryDiff(body.paths)).toEqual({ missing: [], unexpected: [] });
    } finally {
      await app.close();
    }
  });

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
});
