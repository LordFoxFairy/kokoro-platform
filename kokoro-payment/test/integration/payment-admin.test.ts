import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { paymentAdminManifest } from "../../src/interfaces/admin/manifest.js";
import { createPaymentServer } from "../../src/interfaces/http/server.js";
import {
  cleanPaymentDatabase,
  createTestPrismaClient,
  recordingGrant,
} from "./helpers.js";

const prisma = createTestPrismaClient();
const grant = recordingGrant();
const app = createPaymentServer({ prisma, grantPurchaseCredits: grant.grantPurchaseCredits });

describe("payment admin read-only API", () => {
  beforeEach(async () => {
    await cleanPaymentDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
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
