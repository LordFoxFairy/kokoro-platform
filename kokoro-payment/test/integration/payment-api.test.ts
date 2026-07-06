import { afterAll, beforeEach, describe, expect, it } from "vitest";
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
      headers: siteHeaders,
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
      headers: siteHeaders,
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

  it("rejects plan upsert without a site header (400 site_required)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/plans/upsert",
      payload: {
        key: "no_site_plan",
        name: "No Site Plan",
        currency: "USD",
        amountMinor: "4900",
        billingInterval: "month",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("payment.site_required");
  });

  it("rejects order create without a site header (400 site_required)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        teamId: "team_no_site",
        planId: "plan_x",
        amountMinor: "4900",
        currency: "USD",
        idempotencyKey: "no_site_order",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("payment.site_required");
  });

  it("rejects order idempotency key reuse with different request data", async () => {
    const planResponse = await app.inject({
      method: "POST",
      url: "/plans/upsert",
      headers: siteHeaders,
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
      headers: siteHeaders,
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
      headers: siteHeaders,
      payload: {
        teamId: "team_conflict_other",
        planId,
        amountMinor: "4900",
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
      headers: siteHeaders,
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
      headers: siteHeaders,
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

    const response = await app.inject({
      method: "POST",
      url: `/orders/${orderId}/confirm`,
      headers: { "x-kokoro-request-id": "req_confirm" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe("paid");
    // WHY: grant 须带 order.siteId 与请求 id，credit 端据此落到正确站点账户。
    expect(grant.grants).toEqual([
      {
        siteId: TEST_SITE_ID,
        requestId: "req_confirm",
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

  it("deletes a plan and rejects future order creation from it", async () => {
    const planResponse = await app.inject({
      method: "POST",
      url: "/plans/upsert",
      headers: siteHeaders,
      payload: {
        key: "delete_plan_api",
        name: "Delete Plan API",
        currency: "USD",
        amountMinor: "4900",
        billingInterval: "month",
      },
    });
    const planId = planResponse.json().data.id;

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/plans/${planId}`,
      payload: { deletedBy: "operator-1", reason: "retired" },
    });

    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json().data.deletedBy).toBe("operator-1");
    expect(deleteResponse.json().data.deletedAt).toBeTypeOf("string");

    const orderResponse = await app.inject({
      method: "POST",
      url: "/orders",
      headers: siteHeaders,
      payload: {
        teamId: "team_deleted_plan_api",
        planId,
        amountMinor: "4900",
        currency: "USD",
        idempotencyKey: "api_deleted_plan_order",
      },
    });

    expect(orderResponse.statusCode).toBe(409);
    expect(orderResponse.json().error.code).toBe("payment.plan.deleted");
  });

  it("restores a deleted plan and allows order creation again", async () => {
    const planResponse = await app.inject({
      method: "POST",
      url: "/plans/upsert",
      headers: siteHeaders,
      payload: {
        key: "restore_plan_api",
        name: "Restore Plan API",
        currency: "USD",
        amountMinor: "4900",
        billingInterval: "month",
      },
    });
    const planId = planResponse.json().data.id;

    await app.inject({
      method: "DELETE",
      url: `/plans/${planId}`,
      payload: { deletedBy: "operator-1", reason: "restore test" },
    });

    const restoreResponse = await app.inject({
      method: "POST",
      url: `/plans/${planId}/restore`,
    });

    expect(restoreResponse.statusCode).toBe(200);
    expect(restoreResponse.json().data.deletedAt).toBeNull();

    const orderResponse = await app.inject({
      method: "POST",
      url: "/orders",
      headers: siteHeaders,
      payload: {
        teamId: "team_restored_plan_api",
        planId,
        amountMinor: "4900",
        currency: "USD",
        idempotencyKey: "api_restored_plan_order",
      },
    });

    expect(orderResponse.statusCode).toBe(200);
    expect(orderResponse.json().data.status).toBe("pending");
  });
});
