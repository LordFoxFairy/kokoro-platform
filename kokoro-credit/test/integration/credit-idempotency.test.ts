import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createCreditServer } from "../../src/interfaces/http/server.js";
import { cleanCreditDatabase, createTestPrismaClient } from "./helpers.js";

const prisma = createTestPrismaClient();
const app = createCreditServer({ prisma });

async function ensureAccount(ownerId: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/credit/accounts/ensure",
    payload: { ownerKind: "team", ownerId },
  });
  return res.json().data.id;
}

describe("credit idempotency & strict boundary", () => {
  beforeEach(async () => {
    await cleanCreditDatabase(prisma);
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("does not double-credit on repeated grant with same idempotencyKey", async () => {
    const accountId = await ensureAccount("team_idem_grant");
    const payload = {
      accountId,
      amountMicros: "5000000",
      idempotencyKey: "grant_dup",
      reason: "subscription",
    };

    const first = await app.inject({ method: "POST", url: "/credit/grant", payload });
    const second = await app.inject({ method: "POST", url: "/credit/grant", payload });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().data.account.balanceMicros).toBe("5000000");
    expect(second.json().data.account.balanceMicros).toBe("5000000");
  });

  it("does not double-spend on repeated spend with same idempotencyKey", async () => {
    const accountId = await ensureAccount("team_idem_spend");
    await app.inject({
      method: "POST",
      url: "/credit/grant",
      payload: {
        accountId,
        amountMicros: "5000000",
        idempotencyKey: "seed_grant",
        reason: "subscription",
      },
    });
    const spend = {
      accountId,
      amountMicros: "2000000",
      idempotencyKey: "spend_dup",
      reason: "model_call",
    };

    const first = await app.inject({ method: "POST", url: "/credit/spend", payload: spend });
    const second = await app.inject({ method: "POST", url: "/credit/spend", payload: spend });

    expect(first.json().data.account.balanceMicros).toBe("3000000");
    expect(second.json().data.account.balanceMicros).toBe("3000000");
  });

  it("rejects unknown fields at HTTP boundary with 400", async () => {
    const accountId = await ensureAccount("team_strict");
    const res = await app.inject({
      method: "POST",
      url: "/credit/grant",
      payload: {
        accountId,
        amountMicros: "1",
        idempotencyKey: "k",
        reason: "subscription",
        bogus: 1,
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
