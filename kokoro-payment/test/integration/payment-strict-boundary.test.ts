import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPaymentServer } from "../../src/interfaces/http/server.js";
import {
  cleanPaymentDatabase,
  createTestPrismaClient,
  recordingGrant,
  recordingReverse,
  siteHeaders,
} from "./helpers.js";

const prisma = createTestPrismaClient();
const app = createPaymentServer({
  prisma,
  grantPurchaseCredits: recordingGrant().grantPurchaseCredits,
  reverseCredits: recordingReverse().reverseCredits,
});

describe("payment HTTP strict boundary & payload wash", () => {
  beforeEach(async () => {
    await cleanPaymentDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("rejects unknown fields on plan upsert with 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/plans/upsert",
      headers: siteHeaders,
      payload: {
        key: "strict_plan",
        name: "Strict Plan",
        currency: "USD",
        amountMinor: "4900",
        billingInterval: "month",
        bogus: 1,
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects unknown fields on order create with 400", async () => {
    const planResponse = await app.inject({
      method: "POST",
      url: "/plans/upsert",
      headers: siteHeaders,
      payload: {
        key: "strict_order_plan",
        name: "Strict Order Plan",
        currency: "USD",
        amountMinor: "4900",
        billingInterval: "month",
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/orders",
      headers: siteHeaders,
      payload: {
        teamId: "team_strict",
        planId: planResponse.json().data.id,
        amountMinor: "4900",
        currency: "USD",
        idempotencyKey: "strict_order",
        bogus: 1,
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects unknown fields on payment event record with 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/payment-events/record",
      payload: {
        provider: "stripe",
        eventId: "evt_strict",
        eventType: "invoice.paid",
        payload: { subscription: "sub_1" },
        bogus: 1,
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("stores nested JSON payload faithfully after wash", async () => {
    const payload = { nested: { list: [1, 2, 3], flag: true, label: "x" } };
    const response = await app.inject({
      method: "POST",
      url: "/payment-events/record",
      payload: { provider: "stripe", eventId: "evt_wash", eventType: "invoice.paid", payload },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.payload).toEqual(payload);
  });

  it("records event with omitted payload as empty object", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/payment-events/record",
      payload: { provider: "stripe", eventId: "evt_no_payload", eventType: "invoice.paid" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.payload).toEqual({});
  });
});
