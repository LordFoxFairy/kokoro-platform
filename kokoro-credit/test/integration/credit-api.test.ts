import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@kokoro/platform-kit";
import { createCreditServer } from "../../src/interfaces/http/server.js";
import { cleanCreditDatabase, createTestPrismaClient } from "./helpers.js";

const prisma = createTestPrismaClient();
const app = createCreditServer({ prisma });

describe("credit HTTP API", () => {
  beforeEach(async () => {
    await cleanCreditDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("grants and spends credits through runtime APIs", async () => {
    const accountResponse = await app.inject({
      method: "POST",
      url: "/credit/accounts/ensure",
      headers: { "x-kokoro-site-id": "site-default" },
      payload: {
        ownerKind: "team",
        ownerId: "team_api",
      },
    });

    expect(accountResponse.statusCode).toBe(200);
    const accountId = accountResponse.json().data.id;

    const grantResponse = await app.inject({
      method: "POST",
      url: "/credit/grant",
      payload: {
        accountId,
        amountMicros: "7000000",
        idempotencyKey: "api_grant_1",
        reason: "subscription",
      },
    });

    expect(grantResponse.statusCode).toBe(200);
    expect(grantResponse.json().data.account.balanceMicros).toBe("7000000");

    const spendResponse = await app.inject({
      method: "POST",
      url: "/credit/spend",
      payload: {
        accountId,
        amountMicros: "2000000",
        idempotencyKey: "api_spend_1",
        reason: "model_call",
      },
    });

    expect(spendResponse.statusCode).toBe(200);
    expect(spendResponse.json().data.account.balanceMicros).toBe("5000000");
  });

  it("returns a typed error when balance is insufficient", async () => {
    const accountResponse = await app.inject({
      method: "POST",
      url: "/credit/accounts/ensure",
      headers: { "x-kokoro-site-id": "site-default" },
      payload: {
        ownerKind: "team",
        ownerId: "team_overdraft",
      },
    });

    const spendResponse = await app.inject({
      method: "POST",
      url: "/credit/spend",
      payload: {
        accountId: accountResponse.json().data.id,
        amountMicros: "1",
        idempotencyKey: "api_spend_overdraft",
        reason: "model_call",
      },
    });

    expect(spendResponse.statusCode).toBe(402);
    expect(spendResponse.json().error.code).toBe("credit.insufficient");
  });

  it("runs the hold/capture cycle through runtime APIs", async () => {
    const accountResponse = await app.inject({
      method: "POST",
      url: "/credit/accounts/ensure",
      headers: { "x-kokoro-site-id": "site-default" },
      payload: { ownerKind: "team", ownerId: "team_hold_api" },
    });
    const accountId = accountResponse.json().data.id;

    await app.inject({
      method: "POST",
      url: "/credit/grant",
      payload: {
        accountId,
        amountMicros: "9000000",
        idempotencyKey: "api_hold_grant",
        reason: "subscription",
      },
    });

    const holdResponse = await app.inject({
      method: "POST",
      url: "/credit/hold",
      payload: { accountId, amountMicros: "4000000", idempotencyKey: "api_hold" },
    });
    expect(holdResponse.statusCode).toBe(200);
    const holdId = holdResponse.json().data.id;
    expect(holdResponse.json().data.status).toBe("active");

    const captureResponse = await app.inject({
      method: "POST",
      url: "/credit/capture",
      payload: {
        holdId,
        actualAmountMicros: "3000000",
        idempotencyKey: "api_capture",
        reason: "model_call",
        featureKey: "model.call",
      },
    });
    expect(captureResponse.statusCode).toBe(200);
    expect(captureResponse.json().data.account.balanceMicros).toBe("6000000");
    expect(captureResponse.json().data.account.heldMicros).toBe("0");
  });

  it("maps insufficient hold to 402", async () => {
    const accountResponse = await app.inject({
      method: "POST",
      url: "/credit/accounts/ensure",
      headers: { "x-kokoro-site-id": "site-default" },
      payload: { ownerKind: "team", ownerId: "team_hold_overdraft_api" },
    });

    const holdResponse = await app.inject({
      method: "POST",
      url: "/credit/hold",
      payload: {
        accountId: accountResponse.json().data.id,
        amountMicros: "1",
        idempotencyKey: "api_hold_overdraft",
      },
    });

    expect(holdResponse.statusCode).toBe(402);
    expect(holdResponse.json().error.code).toBe("credit.insufficient");
  });

  it("maps unknown hold to 404 on release", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/credit/release",
      // siteId 由请求体承载（权威来源），与 hold/settle 同规。
      payload: { siteId: "site-default", holdId: "missing_hold", idempotencyKey: "api_release_missing" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("credit.hold_not_found");
  });

  it("maps over-capture to 400", async () => {
    const accountResponse = await app.inject({
      method: "POST",
      url: "/credit/accounts/ensure",
      headers: { "x-kokoro-site-id": "site-default" },
      payload: { ownerKind: "team", ownerId: "team_capture_exceeds_api" },
    });
    const accountId = accountResponse.json().data.id;

    await app.inject({
      method: "POST",
      url: "/credit/grant",
      payload: {
        accountId,
        amountMicros: "9000000",
        idempotencyKey: "api_exceed_grant",
        reason: "subscription",
      },
    });
    const holdResponse = await app.inject({
      method: "POST",
      url: "/credit/hold",
      payload: { accountId, amountMicros: "2000000", idempotencyKey: "api_exceed_hold" },
    });

    const captureResponse = await app.inject({
      method: "POST",
      url: "/credit/capture",
      payload: {
        holdId: holdResponse.json().data.id,
        actualAmountMicros: "2000001",
        idempotencyKey: "api_exceed_capture",
        reason: "model_call",
        featureKey: "model.call",
      },
    });

    expect(captureResponse.statusCode).toBe(400);
    expect(captureResponse.json().error.code).toBe("credit.capture_exceeds_hold");
  });

  it("maps owner/site checker rejections to typed HTTP errors", async () => {
    const guardedApp = createCreditServer({
      prisma,
      activeChecker: {
        async ensureAccountActive() {
          throw new AppError("owner.inactive", 409, "owner disabled");
        },
      },
    });

    try {
      const response = await guardedApp.inject({
        method: "POST",
        url: "/credit/accounts/ensure",
        headers: { "x-kokoro-site-id": "site-default" },
        payload: { ownerKind: "team", ownerId: "team_inactive_api" },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("owner.inactive");
    } finally {
      await guardedApp.close();
    }
  });

  it("deletes an account and rejects later grant, spend, and hold mutations", async () => {
    const accountResponse = await app.inject({
      method: "POST",
      url: "/credit/accounts/ensure",
      headers: { "x-kokoro-site-id": "site-default" },
      payload: { ownerKind: "team", ownerId: "team_delete_api" },
    });
    const accountId = accountResponse.json().data.id;

    await app.inject({
      method: "POST",
      url: "/credit/grant",
      payload: {
        accountId,
        amountMicros: "5000000",
        idempotencyKey: "api_delete_grant_before",
        reason: "subscription",
      },
    });

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/credit/accounts/${accountId}`,
      payload: { deletedBy: "operator-1", reason: "closed" },
    });

    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json().data.deletedBy).toBe("operator-1");
    expect(deleteResponse.json().data.deleteReason).toBe("closed");
    expect(deleteResponse.json().data.deletedAt).toBeTypeOf("string");

    for (const request of [
      {
        method: "POST" as const,
        url: "/credit/grant",
        payload: {
          accountId,
          amountMicros: "1000000",
          idempotencyKey: "api_delete_grant_after",
          reason: "subscription",
        },
      },
      {
        method: "POST" as const,
        url: "/credit/spend",
        payload: {
          accountId,
          amountMicros: "1000000",
          idempotencyKey: "api_delete_spend_after",
          reason: "model_call",
        },
      },
      {
        method: "POST" as const,
        url: "/credit/hold",
        payload: {
          accountId,
          amountMicros: "1000000",
          idempotencyKey: "api_delete_hold_after",
        },
      },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("credit.account.deleted");
    }
  });

  it("restores a deleted account and allows mutations again", async () => {
    const accountResponse = await app.inject({
      method: "POST",
      url: "/credit/accounts/ensure",
      headers: { "x-kokoro-site-id": "site-default" },
      payload: { ownerKind: "team", ownerId: "team_restore_api" },
    });
    const accountId = accountResponse.json().data.id;

    await app.inject({
      method: "DELETE",
      url: `/credit/accounts/${accountId}`,
      payload: { deletedBy: "operator-1", reason: "restore test" },
    });

    const restoreResponse = await app.inject({
      method: "POST",
      url: `/credit/accounts/${accountId}/restore`,
    });

    expect(restoreResponse.statusCode).toBe(200);
    expect(restoreResponse.json().data.deletedAt).toBeNull();

    const grantResponse = await app.inject({
      method: "POST",
      url: "/credit/grant",
      payload: {
        accountId,
        amountMicros: "1000000",
        idempotencyKey: "api_restore_grant_after",
        reason: "subscription",
      },
    });
    expect(grantResponse.statusCode).toBe(200);
    expect(grantResponse.json().data.account.balanceMicros).toBe("1000000");
  });

  it("creates a pricing rule and uses it for quote", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/credit/pricing-rules",
      payload: {
        featureKey: "api.pricing.create",
        labelKey: "premium",
        unit: "token",
        amountMicros: "42",
      },
    });

    expect(createResponse.statusCode).toBe(200);
    expect(createResponse.json().data.featureKey).toBe("api.pricing.create");

    const quoteResponse = await app.inject({
      method: "POST",
      url: "/credit/quote",
      payload: { featureKey: "api.pricing.create", labelKey: "premium", quantity: "2" },
    });

    expect(quoteResponse.statusCode).toBe(200);
    expect(quoteResponse.json().data.amountMicros).toBe("84");
  });

  it("deletes a pricing rule and quote falls back to the generic rule", async () => {
    await app.inject({
      method: "POST",
      url: "/credit/pricing-rules",
      payload: {
        featureKey: "api.pricing.delete",
        unit: "token",
        amountMicros: "100",
      },
    });
    const specificResponse = await app.inject({
      method: "POST",
      url: "/credit/pricing-rules",
      payload: {
        featureKey: "api.pricing.delete",
        labelKey: "premium",
        unit: "token",
        amountMicros: "900",
      },
    });
    const pricingRuleId = specificResponse.json().data.id;

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/credit/pricing-rules/${pricingRuleId}`,
      payload: { deletedBy: "operator-1", reason: "retired" },
    });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json().data.deletedBy).toBe("operator-1");

    const quoteResponse = await app.inject({
      method: "POST",
      url: "/credit/quote",
      payload: { featureKey: "api.pricing.delete", labelKey: "premium", quantity: "2" },
    });

    expect(quoteResponse.statusCode).toBe(200);
    expect(quoteResponse.json().data.unitAmountMicros).toBe("100");
    expect(quoteResponse.json().data.amountMicros).toBe("200");
  });

  it("restores a deleted pricing rule and makes it quoteable again", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/credit/pricing-rules",
      payload: {
        featureKey: "api.pricing.restore",
        unit: "token",
        amountMicros: "321",
      },
    });
    const pricingRuleId = createResponse.json().data.id;

    await app.inject({
      method: "DELETE",
      url: `/credit/pricing-rules/${pricingRuleId}`,
      payload: { deletedBy: "operator-1", reason: "restore test" },
    });

    const missingQuoteResponse = await app.inject({
      method: "POST",
      url: "/credit/quote",
      payload: { featureKey: "api.pricing.restore" },
    });
    expect(missingQuoteResponse.statusCode).toBe(404);

    const restoreResponse = await app.inject({
      method: "POST",
      url: `/credit/pricing-rules/${pricingRuleId}/restore`,
    });
    expect(restoreResponse.statusCode).toBe(200);
    expect(restoreResponse.json().data.deletedAt).toBeNull();

    const quoteResponse = await app.inject({
      method: "POST",
      url: "/credit/quote",
      payload: { featureKey: "api.pricing.restore", quantity: "3" },
    });
    expect(quoteResponse.statusCode).toBe(200);
    expect(quoteResponse.json().data.amountMicros).toBe("963");
  });
});
