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
      data: { siteId: "site-default", ownerKind: "team", ownerId: "team_admin", status: "active", balanceMicros: 5_000_000n },
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

  it("includes deleted accounts and pricing rules for restore workflows", async () => {
    await prisma.creditAccount.create({
      data: {
        siteId: "site-default",
        ownerKind: "team",
        ownerId: "team_deleted_admin",
        status: "active",
        deletedAt: new Date(),
        deletedBy: "operator-1",
        deleteReason: "closed",
      },
    });
    await prisma.pricingRule.create({
      data: {
        featureKey: "admin.deleted.pricing",
        unit: "token",
        amountMicros: 10n,
        status: "active",
        deletedAt: new Date(),
        deletedBy: "operator-1",
        deleteReason: "retired",
      },
    });

    const accounts = await app.inject({ method: "GET", url: "/admin/credits/accounts" });
    expect(accounts.statusCode).toBe(200);
    expect(accounts.json().data).toHaveLength(1);
    expect(accounts.json().data[0].deletedBy).toBe("operator-1");

    const pricing = await app.inject({ method: "GET", url: "/admin/credits/pricing" });
    expect(pricing.statusCode).toBe(200);
    expect(pricing.json().data).toHaveLength(1);
    expect(pricing.json().data[0].deletedBy).toBe("operator-1");
  });

  it("runs admin account lifecycle action routes", async () => {
    const accountResponse = await app.inject({
      method: "POST",
      url: "/credit/accounts/ensure",
      headers: { "x-kokoro-site-id": "site-default" },
      payload: { ownerKind: "team", ownerId: "team_admin_lifecycle" },
    });
    const accountId = accountResponse.json().data.id;

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/admin/credits/accounts/${accountId}`,
      payload: { deletedBy: "operator-1", reason: "closed" },
    });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json().data.deletedBy).toBe("operator-1");

    const restoreResponse = await app.inject({
      method: "POST",
      url: `/admin/credits/accounts/${accountId}/restore`,
    });
    expect(restoreResponse.statusCode).toBe(200);
    expect(restoreResponse.json().data.deletedAt).toBeNull();
  });

  it("runs admin pricing rule lifecycle action routes", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/admin/credits/pricing-rules",
      payload: {
        featureKey: "admin.pricing.lifecycle",
        unit: "token",
        amountMicros: "55",
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const pricingRuleId = createResponse.json().data.id;

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/admin/credits/pricing-rules/${pricingRuleId}`,
      payload: { deletedBy: "operator-1", reason: "retired" },
    });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json().data.deletedBy).toBe("operator-1");

    const restoreResponse = await app.inject({
      method: "POST",
      url: `/admin/credits/pricing-rules/${pricingRuleId}/restore`,
    });
    expect(restoreResponse.statusCode).toBe(200);
    expect(restoreResponse.json().data.deletedAt).toBeNull();
  });
});
