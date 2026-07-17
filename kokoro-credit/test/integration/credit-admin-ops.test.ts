import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createCreditServer } from "../../src/interfaces/http/server.js";
import { cleanCreditDatabase, createTestPrismaClient } from "./helpers.js";

const prisma = createTestPrismaClient();
const app = createCreditServer({ prisma });

describe("credit admin operations API", () => {
  beforeEach(async () => {
    await cleanCreditDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("grants credits to an owner and increases balance + appends ledger", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/admin/credits/grant",
      headers: { "x-kokoro-site-id": "site-default" },
      payload: { ownerKind: "user", ownerId: "u_grant", amountMicros: "2500000", reason: "manual_adjustment" },
    });

    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.account.balanceMicros).toBe("2500000");
    expect(data.entry.amountMicros).toBe("2500000");
    expect(data.entry.reason).toBe("manual_adjustment");

    const accounts = await app.inject({ method: "GET", url: "/admin/credits/accounts" });
    expect(accounts.json().data).toHaveLength(1);
    expect(accounts.json().data[0].balanceMicros).toBe("2500000");

    const ledger = await app.inject({ method: "GET", url: "/admin/credits/ledger" });
    expect(ledger.json().data).toHaveLength(1);
    expect(ledger.json().data[0].accountId).toBe(data.account.id);
  });

  it("resets balance to a target (set-to-value) with a signed adjustment entry", async () => {
    // 先发放到 2,500,000，再重置到 1,000,000 → 落一条 -1,500,000 调整分录。
    await app.inject({
      method: "POST",
      url: "/admin/credits/grant",
      headers: { "x-kokoro-site-id": "site-default" },
      payload: { ownerKind: "team", ownerId: "t_reset", amountMicros: "2500000", reason: "manual_adjustment" },
    });
    const reset = await app.inject({
      method: "POST",
      url: "/admin/credits/reset",
      headers: { "x-kokoro-site-id": "site-default" },
      payload: { ownerKind: "team", ownerId: "t_reset", targetMicros: "1000000", reason: "manual_adjustment" },
    });
    expect(reset.statusCode).toBe(200);
    const data = reset.json().data;
    expect(data.account.balanceMicros).toBe("1000000");
    expect(data.entry.amountMicros).toBe("-1500000"); // 带符号调整额 = target - before
    expect(data.entry.balanceAfterMicros).toBe("1000000");

    // 再重置到 0（清零，向下也可）。
    const zero = await app.inject({
      method: "POST",
      url: "/admin/credits/reset",
      headers: { "x-kokoro-site-id": "site-default" },
      payload: { ownerKind: "team", ownerId: "t_reset", targetMicros: "0", reason: "manual_adjustment" },
    });
    expect(zero.statusCode).toBe(200);
    expect(zero.json().data.account.balanceMicros).toBe("0");
    expect(zero.json().data.entry.amountMicros).toBe("-1000000");
  });

  it("grants a refund (退积分) which also adds positive balance", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/admin/credits/grant",
      headers: { "x-kokoro-site-id": "site-default" },
      payload: { ownerKind: "team", ownerId: "t_refund", amountMicros: "1000000", reason: "refund" },
    });

    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.account.balanceMicros).toBe("1000000");
    expect(data.entry.reason).toBe("refund");
  });

  it("returns an audit with account, ledger, holds and usage for an account", async () => {
    const account = await prisma.creditAccount.create({
      data: { siteId: "site-default", ownerKind: "user", ownerId: "u_audit", status: "active", balanceMicros: 5_000_000n },
    });
    await prisma.creditLedgerEntry.create({
      data: {
        accountId: account.id,
        amountMicros: 5_000_000n,
        balanceAfterMicros: 5_000_000n,
        reason: "subscription",
        idempotencyKey: "audit_ledger_seed",
      },
    });
    await prisma.creditHold.create({
      data: {
        accountId: account.id,
        amountMicros: 1_000_000n,
        status: "active",
        idempotencyKey: "audit_hold_seed",
      },
    });
    await prisma.usageRecord.create({
      data: {
        accountId: account.id,
        featureKey: "model.call",
        amountMicros: 500_000n,
        status: "settled",
        idempotencyKey: "audit_usage_seed",
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/admin/credits/accounts/${account.id}/audit`,
    });

    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.account.id).toBe(account.id);
    expect(data.ledgerEntries).toHaveLength(1);
    expect(data.ledgerEntries[0].idempotencyKey).toBe("audit_ledger_seed");
    expect(data.holds).toHaveLength(1);
    expect(data.holds[0].idempotencyKey).toBe("audit_hold_seed");
    expect(data.usageRecords).toHaveLength(1);
    expect(data.usageRecords[0].featureKey).toBe("model.call");
  });

  it("returns audit for a freshly granted account", async () => {
    const grant = await app.inject({
      method: "POST",
      url: "/admin/credits/grant",
      headers: { "x-kokoro-site-id": "site-default" },
      payload: { ownerKind: "user", ownerId: "u_chain", amountMicros: "300", reason: "manual_adjustment" },
    });
    const accountId = grant.json().data.account.id;

    const audit = await app.inject({
      method: "GET",
      url: `/admin/credits/accounts/${accountId}/audit`,
    });

    expect(audit.statusCode).toBe(200);
    expect(audit.json().data.account.balanceMicros).toBe("300");
    expect(audit.json().data.ledgerEntries).toHaveLength(1);
    expect(audit.json().data.holds).toHaveLength(0);
    expect(audit.json().data.usageRecords).toHaveLength(0);
  });

  it("returns 404 when auditing a missing account", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/admin/credits/accounts/missing_account_id/audit",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("credit.account_not_found");
  });

  it("rejects a grant with unknown fields", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/admin/credits/grant",
      headers: { "x-kokoro-site-id": "site-default" },
      payload: { ownerKind: "user", ownerId: "u1", amountMicros: "1", reason: "refund", accountId: "a1" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("request.invalid");
  });
});
