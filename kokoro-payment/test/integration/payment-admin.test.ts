import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { paymentAdminManifest } from "../../src/interfaces/admin/manifest.js";
import { createPaymentServer } from "../../src/interfaces/http/server.js";
import { TEST_SITE_ID, cleanPaymentDatabase, createTestPrismaClient } from "./helpers.js";

const prisma = createTestPrismaClient();
const app = createPaymentServer({ prisma });

describe("payment read-only Admin API (real mysql)", () => {
  beforeEach(() => cleanPaymentDatabase(prisma));
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("serves a manifest whose resources have no mutation actions", async () => {
    const response = await app.inject({ method: "GET", url: "/admin/payments/manifest" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.id).toBe("kokoro-payment");
    expect(response.json().data.resources.every((resource: { actions: unknown[] }) => resource.actions.length === 0)).toBe(true);
  });

  it("returns empty arrays for every historical resource before seeding", async () => {
    for (const resource of paymentAdminManifest.resources) {
      const suffix = resource.siteScopeField === null ? "" : `?siteId=${TEST_SITE_ID}`;
      const response = await app.inject({ method: "GET", url: `${resource.route}${suffix}` });
      expect(response.statusCode, resource.route).toBe(200);
      expect(response.json().data, resource.route).toEqual([]);
    }
  });

  it("projects existing commerce records without mutating them", async () => {
    const plan = await prisma.plan.create({
      data: { siteId: TEST_SITE_ID, key: "history", name: "History", currency: "USD", amountMinor: 4900n, creditMicros: 0n, billingInterval: "month", status: "active" },
    });
    const order = await prisma.order.create({
      data: { siteId: TEST_SITE_ID, teamId: "team-1", planId: plan.id, amountMinor: 4900n, currency: "USD", idempotencyKey: "history-order", status: "paid" },
    });
    await prisma.subscription.create({ data: { teamId: "team-1", planId: plan.id, status: "active" } });
    await prisma.refund.create({ data: { orderId: order.id, amountMinor: 4900n, currency: "USD", status: "succeeded" } });
    await prisma.paymentEvent.create({ data: { provider: "legacy", eventId: "evt-history", eventType: "paid", payload: {}, status: "processed" } });
    await prisma.paymentProvider.create({ data: { key: "legacy", kind: "mock", webhookSecretRef: "LEGACY_REF", enabled: false } });

    for (const resource of paymentAdminManifest.resources) {
      const suffix = resource.siteScopeField === null ? "" : `?siteId=${TEST_SITE_ID}`;
      const response = await app.inject({ method: "GET", url: `${resource.route}${suffix}` });
      expect(response.statusCode, resource.route).toBe(200);
      expect(response.json().data, resource.route).toHaveLength(1);
    }
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "paid" });
  });

  it("includes soft-deleted plans in the read-only migration view", async () => {
    await prisma.plan.create({
      data: { siteId: TEST_SITE_ID, key: "deleted", name: "Deleted", currency: "USD", amountMinor: 4900n, creditMicros: 0n, billingInterval: "month", status: "active", deletedAt: new Date(), deletedBy: "operator-1" },
    });
    const response = await app.inject({ method: "GET", url: `/admin/payments/plans?siteId=${TEST_SITE_ID}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().data[0]).toMatchObject({ key: "deleted", deletedBy: "operator-1" });
  });

  it.each([
    ["POST", "/admin/payments/grant-plan"],
    ["DELETE", "/admin/payments/plans/plan-1"],
    ["POST", "/admin/payments/plans/plan-1/restore"],
    ["POST", "/orders/order-1/refund"],
    ["POST", "/admin/payments/providers/upsert"],
    ["DELETE", "/admin/payments/providers/mock"],
    ["POST", "/admin/payments/events/event-1/replay"],
  ] as const)("does not expose %s %s", async (method, url) => {
    const response = await app.inject({ method, url, headers: { "x-kokoro-site-id": TEST_SITE_ID }, payload: {} });
    expect(response.statusCode).toBe(method === "POST" && url.startsWith("/orders/") ? 503 : 404);
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.refund.count()).toBe(0);
  });
});
