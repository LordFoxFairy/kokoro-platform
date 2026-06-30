import { afterAll, beforeEach, describe, expect, it } from "vitest";
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
      payload: { holdId: "missing_hold", idempotencyKey: "api_release_missing" },
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
});
