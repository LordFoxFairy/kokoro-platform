import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPaymentServer } from "../../src/interfaces/http/server.js";
import { cleanPaymentDatabase, createTestPrismaClient } from "./helpers.js";

const prisma = createTestPrismaClient();
const app = createPaymentServer({ prisma });

describe("payment HTTP API", () => {
  beforeEach(async () => {
    await cleanPaymentDatabase(prisma);
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
});
