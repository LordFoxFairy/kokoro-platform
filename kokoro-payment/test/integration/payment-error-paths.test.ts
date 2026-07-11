import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPaymentRepository } from "../../src/infrastructure/prisma/prisma-payment-repository.js";
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
const repository = new PrismaPaymentRepository(prisma);
const app = createPaymentServer({
  prisma,
  grantPurchaseCredits: recordingGrant().grantPurchaseCredits,
  reverseCredits: recordingReverse().reverseCredits,
});

async function seedPlan(key: string) {
  return prisma.plan.create({
    data: {
      siteId: TEST_SITE_ID,
      key,
      name: "Error Path Plan",
      currency: "USD",
      amountMinor: 4900n,
      creditMicros: 0n,
      billingInterval: "month",
      status: "active",
    },
  });
}

describe("payment HTTP error paths (real mysql)", () => {
  beforeEach(async () => {
    await cleanPaymentDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("sweep with no stale confirming orders reports recovered=0", async () => {
    const response = await app.inject({ method: "POST", url: "/orders/sweep" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ recovered: 0 });
  });

  it("plan delete returns 404 for an unknown plan", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/plans/plan_ghost",
      payload: { deletedBy: "operator-1" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("payment.plan.not_found");
  });

  it("plan restore returns 404 for an unknown plan", async () => {
    const response = await app.inject({ method: "POST", url: "/plans/plan_ghost/restore" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("payment.plan.not_found");
  });

  it("confirm returns 409 for a canceled order", async () => {
    const plan = await seedPlan("error_confirm_plan");
    const order = await prisma.order.create({
      data: {
        siteId: TEST_SITE_ID,
        teamId: "team_error",
        planId: plan.id,
        amountMinor: 4900n,
        currency: "USD",
        idempotencyKey: "error_confirm_order",
        status: "canceled",
      },
    });
    const response = await app.inject({ method: "POST", url: `/orders/${order.id}/confirm` });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("payment.order_not_confirmable");
  });

  it("order create returns 409 when the amount does not match plan pricing", async () => {
    const plan = await seedPlan("error_amount_plan");
    const response = await app.inject({
      method: "POST",
      url: "/orders",
      headers: siteHeaders,
      payload: {
        teamId: "team_error",
        planId: plan.id,
        amountMinor: "100",
        currency: "USD",
        idempotencyKey: "error_amount_order",
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("payment.order_amount_mismatch");
  });
});

describe("PrismaPaymentRepository event transition (real mysql)", () => {
  beforeEach(async () => {
    await cleanPaymentDatabase(prisma);
  });

  it("conditional transition: loser gets null and does not overwrite the winner", async () => {
    const event = await repository.recordPaymentEvent({
      provider: "mockpay",
      eventId: "evt_transition",
      eventType: "payment_succeeded",
      payload: { data: { orderId: "order_x" } },
    });
    expect(event.status).toBe("received");

    const winner = await repository.transitionPaymentEventStatus(
      event.id,
      ["received", "failed"],
      "processed",
      null,
    );
    expect(winner?.status).toBe("processed");

    // 已 processed：既不在 from 集合内，返回 null（并发败者/重复处理不得回写）。
    const loser = await repository.transitionPaymentEventStatus(
      event.id,
      ["received", "failed"],
      "failed",
      "should not overwrite",
    );
    expect(loser).toBeNull();

    const stored = await repository.findPaymentEventById(event.id);
    expect(stored?.status).toBe("processed");
    expect(stored?.lastError).toBeNull();
  });

  it("findPaymentEventById returns null for an unknown id", async () => {
    expect(await repository.findPaymentEventById("evt_ghost")).toBeNull();
  });
});
