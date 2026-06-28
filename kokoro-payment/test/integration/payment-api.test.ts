import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPaymentServer } from "../../src/interfaces/http/server.js";
import {
  cleanPaymentDatabase,
  createTestPrismaClient,
  recordingGrant,
} from "./helpers.js";

const prisma = createTestPrismaClient();
const grant = recordingGrant();
const app = createPaymentServer({ prisma, grantPurchaseCredits: grant.grantPurchaseCredits });

describe("payment HTTP API", () => {
  beforeEach(async () => {
    await cleanPaymentDatabase(prisma);
    grant.grants.length = 0;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("upserts a plan and creates an order", async () => {
    const planResponse = await app.inject({
      method: "POST",
      url: "/plans/upsert",
      payload: {
        key: "studio_bundle",
        name: "Studio Bundle",
        currency: "USD",
        amountMinor: "4900",
        billingInterval: "month",
      },
    });

    expect(planResponse.statusCode).toBe(200);

    const orderResponse = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        teamId: "team_studio",
        planId: planResponse.json().data.id,
        amountMinor: "4900",
        currency: "USD",
        idempotencyKey: "api_order_1",
      },
    });

    expect(orderResponse.statusCode).toBe(200);
    expect(orderResponse.json().data.status).toBe("pending");
  });

  it("rejects order idempotency key reuse with different request data", async () => {
    const planResponse = await app.inject({
      method: "POST",
      url: "/plans/upsert",
      payload: {
        key: "studio_conflict",
        name: "Studio Conflict",
        currency: "USD",
        amountMinor: "4900",
        billingInterval: "month",
      },
    });

    const planId = planResponse.json().data.id;
    await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        teamId: "team_conflict",
        planId,
        amountMinor: "4900",
        currency: "USD",
        idempotencyKey: "api_order_conflict",
      },
    });

    const conflictResponse = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        teamId: "team_conflict",
        planId,
        amountMinor: "9900",
        currency: "USD",
        idempotencyKey: "api_order_conflict",
      },
    });

    expect(conflictResponse.statusCode).toBe(409);
    expect(conflictResponse.json().error.code).toBe("payment.idempotency_conflict");
  });

  it("records provider events without touching credit ledger", async () => {
    const eventResponse = await app.inject({
      method: "POST",
      url: "/payment-events/record",
      payload: {
        provider: "stripe",
        eventId: "evt_api_1",
        eventType: "invoice.paid",
        payload: {
          subscription: "sub_1",
        },
      },
    });

    expect(eventResponse.statusCode).toBe(200);
    expect(eventResponse.json().data.provider).toBe("stripe");
  });

  it("rejects provider event id reuse with different event data", async () => {
    await app.inject({
      method: "POST",
      url: "/payment-events/record",
      payload: {
        provider: "stripe",
        eventId: "evt_api_conflict",
        eventType: "invoice.paid",
        payload: {
          subscription: "sub_1",
        },
      },
    });

    const conflictResponse = await app.inject({
      method: "POST",
      url: "/payment-events/record",
      payload: {
        provider: "stripe",
        eventId: "evt_api_conflict",
        eventType: "invoice.failed",
        payload: {
          subscription: "sub_1",
        },
      },
    });

    expect(conflictResponse.statusCode).toBe(409);
    expect(conflictResponse.json().error.code).toBe("payment.idempotency_conflict");
  });

  async function seedPendingOrder(opts: {
    planKey: string;
    creditMicros?: string;
    teamId: string;
    idempotencyKey: string;
  }): Promise<string> {
    const planResponse = await app.inject({
      method: "POST",
      url: "/plans/upsert",
      payload: {
        key: opts.planKey,
        name: opts.planKey,
        currency: "USD",
        amountMinor: "4900",
        creditMicros: opts.creditMicros ?? "0",
        billingInterval: "month",
      },
    });
    const orderResponse = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        teamId: opts.teamId,
        planId: planResponse.json().data.id,
        amountMinor: "4900",
        currency: "USD",
        idempotencyKey: opts.idempotencyKey,
      },
    });
    return orderResponse.json().data.id;
  }

  it("confirms a pending order: grants credits and marks paid", async () => {
    const orderId = await seedPendingOrder({
      planKey: "confirm_grant",
      creditMicros: "1000000",
      teamId: "team_confirm",
      idempotencyKey: "confirm_grant_order",
    });

    const response = await app.inject({ method: "POST", url: `/orders/${orderId}/confirm` });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe("paid");
    expect(grant.grants).toEqual([
      {
        ownerKind: "team",
        ownerId: "team_confirm",
        amountMicros: "1000000",
        idempotencyKey: `order:${orderId}`,
        reason: "subscription",
      },
    ]);
  });

  it("re-confirm does not re-grant credits", async () => {
    const orderId = await seedPendingOrder({
      planKey: "confirm_idem",
      creditMicros: "1000000",
      teamId: "team_idem",
      idempotencyKey: "confirm_idem_order",
    });

    await app.inject({ method: "POST", url: `/orders/${orderId}/confirm` });
    const second = await app.inject({ method: "POST", url: `/orders/${orderId}/confirm` });

    expect(second.statusCode).toBe(200);
    expect(second.json().data.status).toBe("paid");
    expect(grant.grants).toHaveLength(1);
  });

  it("confirms a zero-credit plan order without granting", async () => {
    const orderId = await seedPendingOrder({
      planKey: "confirm_zero",
      creditMicros: "0",
      teamId: "team_zero",
      idempotencyKey: "confirm_zero_order",
    });

    const response = await app.inject({ method: "POST", url: `/orders/${orderId}/confirm` });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe("paid");
    expect(grant.grants).toEqual([]);
  });

  it("returns 404 confirming a missing order", async () => {
    const response = await app.inject({ method: "POST", url: "/orders/missing_order/confirm" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("payment.order_not_found");
  });
});
