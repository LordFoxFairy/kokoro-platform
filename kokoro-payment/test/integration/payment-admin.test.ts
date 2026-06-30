import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { paymentAdminManifest } from "../../src/interfaces/admin/manifest.js";
import { createPaymentServer } from "../../src/interfaces/http/server.js";
import {
  TEST_SITE_ID,
  cleanPaymentDatabase,
  createTestPrismaClient,
  recordingGrant,
  recordingReverse,
  siteHeaders,
} from "./helpers.js";

const prisma = createTestPrismaClient();
const grant = recordingGrant();
const reverse = recordingReverse();
const app = createPaymentServer({
  prisma,
  grantPurchaseCredits: grant.grantPurchaseCredits,
  reverseCredits: reverse.reverseCredits,
});

// 单个共享 app 在所有 describe 跑完后关闭一次，避免第二个 describe 复用已关闭实例。
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("payment admin read-only API", () => {
  beforeEach(async () => {
    await cleanPaymentDatabase(prisma);
  });

  it("serves the admin manifest", async () => {
    const response = await app.inject({ method: "GET", url: "/admin/payments/manifest" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.id).toBe("kokoro-payment");
    expect(response.json().data.basePath).toBe("/admin/payments");
  });

  it("returns empty arrays for every resource route before seeding", async () => {
    for (const resource of paymentAdminManifest.resources) {
      const response = await app.inject({ method: "GET", url: resource.route });
      expect(response.statusCode, resource.route).toBe(200);
      expect(Array.isArray(response.json().data), resource.route).toBe(true);
      expect(response.json().data, resource.route).toEqual([]);
    }
  });

  it("surfaces seeded rows across all resource lists", async () => {
    const plan = await prisma.plan.create({
      data: {
        siteId: TEST_SITE_ID,
        key: "admin_seed_plan",
        name: "Admin Seed Plan",
        currency: "USD",
        amountMinor: 4900n,
        creditMicros: 0n,
        billingInterval: "month",
        status: "active",
      },
    });
    const order = await prisma.order.create({
      data: {
        siteId: TEST_SITE_ID,
        teamId: "team_admin_seed",
        planId: plan.id,
        amountMinor: 4900n,
        currency: "USD",
        idempotencyKey: "admin_seed_order",
        status: "pending",
      },
    });
    await prisma.subscription.create({
      data: {
        teamId: "team_admin_seed",
        planId: plan.id,
        status: "active",
      },
    });
    await prisma.paymentEvent.create({
      data: {
        provider: "stripe",
        eventId: "evt_admin_seed",
        eventType: "invoice.paid",
        payload: { subscription: "sub_seed" },
        status: "received",
      },
    });
    await prisma.refund.create({
      data: {
        orderId: order.id,
        amountMinor: 4900n,
        currency: "USD",
        status: "pending",
      },
    });

    const expectations: Record<string, (data: unknown[]) => void> = {
      "/admin/payments/plans": (data) => {
        expect(data).toHaveLength(1);
        expect((data[0] as { key: string }).key).toBe("admin_seed_plan");
      },
      "/admin/payments/orders": (data) => {
        expect(data).toHaveLength(1);
        expect((data[0] as { idempotencyKey: string }).idempotencyKey).toBe("admin_seed_order");
      },
      "/admin/payments/subscriptions": (data) => {
        expect(data).toHaveLength(1);
        expect((data[0] as { status: string }).status).toBe("active");
      },
      "/admin/payments/events": (data) => {
        expect(data).toHaveLength(1);
        expect((data[0] as { eventId: string }).eventId).toBe("evt_admin_seed");
      },
      "/admin/payments/refunds": (data) => {
        expect(data).toHaveLength(1);
        expect((data[0] as { amountMinor: string }).amountMinor).toBe("4900");
      },
    };

    for (const resource of paymentAdminManifest.resources) {
      const response = await app.inject({ method: "GET", url: resource.route });
      expect(response.statusCode, resource.route).toBe(200);
      expectations[resource.route]?.(response.json().data);
    }
  });
});

describe("admin grant-plan + refund", () => {
  beforeEach(async () => {
    await cleanPaymentDatabase(prisma);
  });

  async function seedPlan(creditMicros: bigint) {
    return prisma.plan.create({
      data: {
        siteId: TEST_SITE_ID,
        key: `grant_plan_${creditMicros}`,
        name: "Grant Plan",
        currency: "USD",
        amountMinor: 4900n,
        creditMicros,
        billingInterval: "month",
        status: "active",
      },
    });
  }

  it("grant-plan creates a paid order and grants plan credits", async () => {
    const plan = await seedPlan(1_000_000n);
    const before = grant.grants.length;

    const response = await app.inject({
      method: "POST",
      url: "/admin/payments/grant-plan",
      headers: siteHeaders,
      payload: { teamId: "team_grant", planId: plan.id },
    });

    expect(response.statusCode).toBe(200);
    const order = response.json().data as { id: string; status: string; teamId: string };
    expect(order.status).toBe("paid");
    expect(order.teamId).toBe("team_grant");

    const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.status).toBe("paid");
    expect(grant.grants).toHaveLength(before + 1);
  });

  it("grant-plan returns 404 for an unknown plan", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/admin/payments/grant-plan",
      headers: siteHeaders,
      payload: { teamId: "team_grant", planId: "plan_missing" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("payment.plan_not_found");
  });

  it("refund marks order refunded, reverses credits, and records a Refund row", async () => {
    const plan = await seedPlan(1_000_000n);
    const granted = await app.inject({
      method: "POST",
      url: "/admin/payments/grant-plan",
      headers: siteHeaders,
      payload: { teamId: "team_refund", planId: plan.id },
    });
    const order = granted.json().data as { id: string };
    const reversalsBefore = reverse.reversals.length;

    const response = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/refund`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json().data as {
      order: { status: string };
      refund: { status: string; amountMinor: string };
    };
    expect(body.order.status).toBe("refunded");
    expect(body.refund.status).toBe("succeeded");
    expect(body.refund.amountMinor).toBe("4900");

    const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.status).toBe("refunded");
    const refunds = await prisma.refund.findMany({ where: { orderId: order.id } });
    expect(refunds).toHaveLength(1);
    expect(reverse.reversals).toHaveLength(reversalsBefore + 1);
    const lastReversal = reverse.reversals.at(-1);
    expect(lastReversal?.idempotencyKey).toBe(`order-refund:${order.id}`);
    expect(lastReversal?.reason).toBe("refund");
  });

  it("refund returns 409 for a non-paid order", async () => {
    const plan = await seedPlan(0n);
    const order = await prisma.order.create({
      data: {
        siteId: TEST_SITE_ID,
        teamId: "team_pending",
        planId: plan.id,
        amountMinor: 4900n,
        currency: "USD",
        idempotencyKey: "pending_refund_order",
        status: "pending",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/orders/${order.id}/refund`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("payment.order_not_refundable");
  });

  it("refund returns 404 for an unknown order", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/orders/order_missing/refund",
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("payment.order_not_found");
  });
});
