import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PaymentService } from "../../src/application/payment-service.js";
import { PrismaPaymentRepository } from "../../src/infrastructure/prisma/prisma-payment-repository.js";
import { cleanPaymentDatabase, createTestPrismaClient } from "./helpers.js";

const prisma = createTestPrismaClient();
const repository = new PrismaPaymentRepository(prisma);
const service = new PaymentService(repository);

describe("PrismaPaymentRepository", () => {
  beforeEach(async () => {
    await cleanPaymentDatabase(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("upserts plans by key", async () => {
    const first = await service.upsertPlan({
      key: "music_pro",
      name: "Music Pro",
      currency: "USD",
      amountMinor: "1900",
      billingInterval: "month",
    });

    const second = await service.upsertPlan({
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

  it("creates orders idempotently", async () => {
    const plan = await service.upsertPlan({
      key: "creator",
      name: "Creator",
      currency: "USD",
      amountMinor: "2900",
      billingInterval: "month",
    });

    const first = await service.createOrder({
      teamId: "team_pay",
      planId: plan.id,
      amountMinor: "2900",
      currency: "USD",
      idempotencyKey: "order_1",
    });

    const second = await service.createOrder({
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
      key: "creator_concurrent",
      name: "Creator Concurrent",
      currency: "USD",
      amountMinor: "3900",
      billingInterval: "month",
    });

    const [first, second] = await Promise.all([
      service.createOrder({
        teamId: "team_pay_concurrent",
        planId: plan.id,
        amountMinor: "3900",
        currency: "USD",
        idempotencyKey: "order_concurrent",
      }),
      service.createOrder({
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
