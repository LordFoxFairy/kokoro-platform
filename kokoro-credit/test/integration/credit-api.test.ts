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
});
