import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPaymentServer } from "../../src/interfaces/http/server.js";
import {
  TEST_SITE_ID,
  cleanPaymentDatabase,
  createTestPrismaClient,
  paymentReadCapabilities,
  siteHeaders,
} from "./helpers.js";

const prisma = createTestPrismaClient();
const app = createPaymentServer({ readCapabilities: paymentReadCapabilities(prisma) });

const disabledRequests = [
  ["/orders/checkout", { teamId: "team-1", planId: "plan-1" }],
  ["/orders", { teamId: "team-1", planId: "plan-1" }],
  ["/orders/sweep", {}],
  ["/orders/order-1/confirm", {}],
  ["/orders/order-1/refund", {}],
  ["/payment-events/record", { provider: "mock", eventId: "evt-1", eventType: "paid" }],
] as const;

describe("payment redeem-only HTTP API (real mysql)", () => {
  beforeEach(async () => {
    await cleanPaymentDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("lists only the active, non-deleted plans from the requested Site", async () => {
    await prisma.plan.createMany({
      data: [
        { siteId: TEST_SITE_ID, key: "active", name: "Active", currency: "USD", amountMinor: 4900n, creditMicros: 1_000_000n, billingInterval: "month", status: "active" },
        { siteId: TEST_SITE_ID, key: "disabled", name: "Disabled", currency: "USD", amountMinor: 4900n, creditMicros: 0n, billingInterval: "month", status: "disabled" },
        { siteId: TEST_SITE_ID, key: "deleted", name: "Deleted", currency: "USD", amountMinor: 4900n, creditMicros: 0n, billingInterval: "month", status: "active", deletedAt: new Date() },
        { siteId: "site-other", key: "other", name: "Other", currency: "USD", amountMinor: 4900n, creditMicros: 0n, billingInterval: "month", status: "active" },
      ],
    });

    const response = await app.inject({ method: "GET", url: "/plans", headers: siteHeaders });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.plans).toEqual([
      expect.objectContaining({ key: "active", amountMinor: "4900", creditMicros: "1000000" }),
    ]);
    expect(Object.keys(response.json().data.plans[0]).sort()).toEqual(
      ["amountMinor", "billingInterval", "creditMicros", "currency", "id", "key", "name"],
    );
  });

  it("requires Site context for catalogue reads", async () => {
    const response = await app.inject({ method: "GET", url: "/plans" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("payment.site_required");
  });

  it.each(disabledRequests)("returns one disabled code for POST %s without persistence", async (url, payload) => {
    const before = {
      orders: await prisma.order.count(),
      events: await prisma.paymentEvent.count(),
      refunds: await prisma.refund.count(),
      subscriptions: await prisma.subscription.count(),
    };
    const response = await app.inject({ method: "POST", url, headers: siteHeaders, payload });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("ACQUISITION_CHANNEL_DISABLED");
    expect({
      orders: await prisma.order.count(),
      events: await prisma.paymentEvent.count(),
      refunds: await prisma.refund.count(),
      subscriptions: await prisma.subscription.count(),
    }).toEqual(before);
  });

  it.each([
    ["POST", "/plans/upsert"],
    ["DELETE", "/plans/plan-1"],
    ["POST", "/plans/plan-1/restore"],
  ] as const)("does not register %s %s", async (method, url) => {
    const response = await app.inject({ method, url, headers: siteHeaders, payload: {} });
    expect(response.statusCode).toBe(404);
    expect(await prisma.plan.count()).toBe(0);
  });
});
