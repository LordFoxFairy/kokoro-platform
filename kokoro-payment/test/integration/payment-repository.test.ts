import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PaymentService } from "../../src/application/payment-service.js";
import { PrismaPaymentRepository } from "../../src/infrastructure/prisma/prisma-payment-repository.js";
import {
  cleanPaymentDatabase,
  createTestPrismaClient,
  recordingGrant,
  recordingReverse,
} from "./helpers.js";

const prisma = createTestPrismaClient();
const repository = new PrismaPaymentRepository(prisma);
const service = new PaymentService(
  repository,
  recordingGrant().grantPurchaseCredits,
  recordingReverse().reverseCredits,
);

describe("PrismaPaymentRepository", () => {
  beforeEach(async () => {
    await cleanPaymentDatabase(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("upserts plans by key", async () => {
    const first = await service.upsertPlan({
      siteId: "site_1",
      key: "music_pro",
      name: "Music Pro",
      currency: "USD",
      amountMinor: "1900",
      billingInterval: "month",
    });

    const second = await service.upsertPlan({
      siteId: "site_1",
      key: "music_pro",
      name: "Music Pro Updated",
      currency: "USD",
      amountMinor: "2500",
      billingInterval: "month",
    });

    expect(second.id).toBe(first.id);
    expect(second.name).toBe("Music Pro Updated");
    expect(second.amountMinor).toBe("2500");
  });

  it("isolates plans per site: same key under two sites yields two plans", async () => {
    const siteA = await service.upsertPlan({
      siteId: "site_a",
      key: "shared_key",
      name: "Site A Plan",
      currency: "USD",
      amountMinor: "1000",
      billingInterval: "month",
    });
    const siteB = await service.upsertPlan({
      siteId: "site_b",
      key: "shared_key",
      name: "Site B Plan",
      currency: "USD",
      amountMinor: "2000",
      billingInterval: "month",
    });

    expect(siteB.id).not.toBe(siteA.id);
    expect(siteA.siteId).toBe("site_a");
    expect(siteB.siteId).toBe("site_b");
    expect(siteA.amountMinor).toBe("1000");
    expect(siteB.amountMinor).toBe("2000");
  });

  it("creates orders idempotently", async () => {
    const plan = await service.upsertPlan({
      siteId: "site_1",
      key: "creator",
      name: "Creator",
      currency: "USD",
      amountMinor: "2900",
      billingInterval: "month",
    });

    const first = await service.createOrder({
      siteId: "site_1",
      teamId: "team_pay",
      planId: plan.id,
      amountMinor: "2900",
      currency: "USD",
      idempotencyKey: "order_1",
    });

    const second = await service.createOrder({
      siteId: "site_1",
      teamId: "team_pay",
      planId: plan.id,
      amountMinor: "2900",
      currency: "USD",
      idempotencyKey: "order_1",
    });

    expect(second.id).toBe(first.id);
    expect(second.status).toBe("pending");
  });

  it("handles concurrent order creation with the same idempotency key", async () => {
    const plan = await service.upsertPlan({
      siteId: "site_1",
      key: "creator_concurrent",
      name: "Creator Concurrent",
      currency: "USD",
      amountMinor: "3900",
      billingInterval: "month",
    });

    const [first, second] = await Promise.all([
      service.createOrder({
        siteId: "site_1",
        teamId: "team_pay_concurrent",
        planId: plan.id,
        amountMinor: "3900",
        currency: "USD",
        idempotencyKey: "order_concurrent",
      }),
      service.createOrder({
        siteId: "site_1",
        teamId: "team_pay_concurrent",
        planId: plan.id,
        amountMinor: "3900",
        currency: "USD",
        idempotencyKey: "order_concurrent",
      }),
    ]);

    expect(second.id).toBe(first.id);
  });

  it("records provider payment events idempotently", async () => {
    const first = await service.recordPaymentEvent({
      provider: "stripe",
      eventId: "evt_1",
      eventType: "checkout.session.completed",
      payload: {
        orderId: "order_external",
      },
    });

    const second = await service.recordPaymentEvent({
      provider: "stripe",
      eventId: "evt_1",
      eventType: "checkout.session.completed",
      payload: {
        orderId: "order_external",
      },
    });

    expect(second.id).toBe(first.id);
  });

  it("handles concurrent provider events with the same provider event id", async () => {
    const [first, second] = await Promise.all([
      service.recordPaymentEvent({
        provider: "stripe",
        eventId: "evt_concurrent",
        eventType: "checkout.session.completed",
        payload: {
          orderId: "order_external_concurrent",
        },
      }),
      service.recordPaymentEvent({
        provider: "stripe",
        eventId: "evt_concurrent",
        eventType: "checkout.session.completed",
        payload: {
          orderId: "order_external_concurrent",
        },
      }),
    ]);

    expect(second.id).toBe(first.id);
  });
});
