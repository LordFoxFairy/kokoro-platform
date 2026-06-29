import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { creditAdminManifest } from "../../src/interfaces/admin/manifest.js";
import { createCreditServer } from "../../src/interfaces/http/server.js";
import { cleanCreditDatabase, createTestPrismaClient } from "./helpers.js";

const prisma = createTestPrismaClient();
const app = createCreditServer({ prisma });

describe("credit admin read API", () => {
  beforeEach(async () => {
    await cleanCreditDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("serves the admin module manifest", async () => {
    const response = await app.inject({ method: "GET", url: "/admin/credits/manifest" });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual(creditAdminManifest);
  });

  it("returns empty arrays for all list endpoints", async () => {
    for (const url of [
      "/admin/credits/accounts",
      "/admin/credits/ledger",
      "/admin/credits/usage",
      "/admin/credits/pricing",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(Array.isArray(response.json().data)).toBe(true);
      expect(response.json().data).toHaveLength(0);
    }
  });

  it("surfaces seeded rows across the list endpoints", async () => {
    const account = await prisma.creditAccount.create({
      data: { ownerKind: "team", ownerId: "team_admin", status: "active", balanceMicros: 5_000_000n },
    });
    await prisma.creditLedgerEntry.create({
      data: {
        accountId: account.id,
        amountMicros: 5_000_000n,
        balanceAfterMicros: 5_000_000n,
        reason: "subscription",
        idempotencyKey: "admin_ledger_seed",
      },
    });
    await prisma.usageRecord.create({
      data: {
        accountId: account.id,
        featureKey: "model.call",
        amountMicros: 1_000_000n,
        status: "settled",
        idempotencyKey: "admin_usage_seed",
      },
    });
    await prisma.pricingRule.create({
      data: { featureKey: "model.call", unit: "token", amountMicros: 10n, status: "active" },
    });

    const accounts = await app.inject({ method: "GET", url: "/admin/credits/accounts" });
    expect(accounts.json().data).toHaveLength(1);
    expect(accounts.json().data[0].balanceMicros).toBe("5000000");

    const ledger = await app.inject({ method: "GET", url: "/admin/credits/ledger" });
    expect(ledger.json().data).toHaveLength(1);
    expect(ledger.json().data[0].idempotencyKey).toBe("admin_ledger_seed");

    const usage = await app.inject({ method: "GET", url: "/admin/credits/usage" });
    expect(usage.json().data).toHaveLength(1);
    expect(usage.json().data[0].featureKey).toBe("model.call");
    expect(usage.json().data[0].amountMicros).toBe("1000000");

    const pricing = await app.inject({ method: "GET", url: "/admin/credits/pricing" });
    expect(pricing.json().data).toHaveLength(1);
    expect(pricing.json().data[0].amountMicros).toBe("10");
  });
});
