import { describe, expect, it, vi } from "vitest";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import { PostgresAdminCreditReader } from
  "../../src/modules/credit/infrastructure/postgres/admin-credit-reader.js";
import type { AdminQueryPermit } from
  "../../src/modules/admin/interfaces/connect/admin-query-service.js";

describe("PostgresAdminCreditReader", () => {
  it("derives Site summary from authority facts inside an exact Site RLS transaction", async () => {
    const statements: string[] = [];
    const lease = issuePlatformTransaction({ execute: async () => 0, query: async (statement) => {
      statements.push(statement);
      return [{ siteId: "site-1", creditAccountCount: "2", activeCreditAccountCount: "1",
        openHoldCount: "3", reconciliationRequiredHoldCount: "1",
        balances: [{ unit: "credit", availableAmount: "100", reservedAmount: "20",
          consumedAmount: "30", expiredAmount: "0", revokedAmount: "0",
          recoveryExposureAmount: "0" }], asOf: "2026-07-30T00:00:00.000Z" }] as never;
    } });
    const adminSiteQueryTransaction = vi.fn(async (_permit, siteRef, work) => {
      expect(siteRef).toBe("site-1"); return work(lease.transaction);
    });
    const reader = new PostgresAdminCreditReader({ adminSiteQueryTransaction });
    try {
      await expect(reader.getSiteCreditSummary(permit("credit.summary.read"), "site-1"))
        .resolves.toMatchObject({ creditAccountCount: 2n, balances: [{ availableAmount: "100" }] });
      expect(adminSiteQueryTransaction).toHaveBeenCalledOnce();
      expect(statements.join("\n")).toContain("platform.credit_account");
      expect(statements.join("\n")).toContain("platform.credit_journal_entry");
      expect(statements.join("\n")).toContain("platform.credit_hold");
      expect(statements.join("\n")).not.toMatch(/snapshot|evidence_payload|provider_payload/u);
    } finally { revokePlatformTransaction(lease); }
  });

  it("returns Journal entry source and execution refs without raw evidence", async () => {
    const statements: string[] = [];
    const lease = issuePlatformTransaction({ execute: async () => 0, query: async (statement) => {
      statements.push(statement);
      if (statement.includes("transaction_timestamp()")) {
        return [{ observedAt: "2026-07-30T00:00:00.000Z" }] as never;
      }
      return [{ siteId: "site-1", journalTransactionRef: "22222222-2222-4222-8222-222222222222",
        entryOrdinal: 0, creditAccountRef: "11111111-1111-4111-8111-111111111111", unit: "credit",
        entrySide: "debit", accountType: "customer_available", amount: "10",
        creditGrantId: "33333333-3333-4333-8333-333333333333",
        creditHoldRef: "44444444-4444-4444-8444-444444444444", sourceType: "redemption",
        sourceRef: "redeem:1", executionRootRef: "execution:1",
        createdAt: "2026-07-30T00:00:00.000Z" }] as never;
    } });
    const reader = new PostgresAdminCreditReader({ adminSiteQueryTransaction:
      async (_permit, _siteRef, work) => work(lease.transaction) });
    try {
      await expect(reader.listCreditJournalEntries(permit("credit.journal.read"), {
        siteId: "site-1", journalTransactionRef: "22222222-2222-4222-8222-222222222222",
        afterOrdinal: null, membershipWatermark: null, limit: 10,
      })).resolves.toMatchObject({
        items: [{ sourceRef: "redeem:1", executionRootRef: "execution:1" }],
        membershipWatermark: "2026-07-30T00:00:00.000Z",
        observedAt: "2026-07-30T00:00:00.000Z",
      });
      expect(statements[1]).toMatch(/credit_journal_entry[\s\S]+credit_grant[\s\S]+credit_hold/u);
      expect(statements[1]).not.toMatch(/evidence|snapshot|line_items/u);
    } finally { revokePlatformTransaction(lease); }
  });

  it("captures the first-page membership watermark from the same PostgreSQL transaction timestamp", async () => {
    const calls: { statement: string; values: readonly unknown[] }[] = [];
    const lease = issuePlatformTransaction({ execute: async () => 0, query: async (statement, values = []) => {
      calls.push({ statement, values });
      if (statement.includes("transaction_timestamp()")) {
        return [{ observedAt: "2026-07-30T01:00:00.000Z" }] as never;
      }
      return [] as never;
    } });
    const reader = new PostgresAdminCreditReader({ adminSiteQueryTransaction:
      async (_permit, _siteRef, work) => work(lease.transaction) });
    try {
      await expect(reader.listCreditGrants(permit("credit.grant.read"), {
        siteId: "site-1", creditGrantId: null, creditAccountRef: null, sourceType: null,
        sourceRef: null, executionRootRef: null, afterRef: null, membershipWatermark: null, limit: 10,
      })).resolves.toMatchObject({ items: [], membershipWatermark: "2026-07-30T01:00:00.000Z",
        observedAt: "2026-07-30T01:00:00.000Z" });
      expect(calls[0]?.statement).toContain("transaction_timestamp()");
      expect(calls[1]?.values).toContain("2026-07-30T01:00:00.000Z");
    } finally { revokePlatformTransaction(lease); }
  });

  it("preserves the membership watermark while reporting a later page's independent observedAt", async () => {
    const lease = issuePlatformTransaction({ execute: async () => 0, query: async (statement) =>
      statement.includes("transaction_timestamp()")
        ? [{ observedAt: "2026-07-30T00:59:59.000Z" }] as never
        : [] as never });
    const reader = new PostgresAdminCreditReader({ adminSiteQueryTransaction:
      async (_permit, _siteRef, work) => work(lease.transaction) });
    try {
      await expect(reader.listCreditGrants(permit("credit.grant.read"), {
        siteId: "site-1", creditGrantId: null, creditAccountRef: null, sourceType: null,
        sourceRef: null, executionRootRef: null, afterRef: null,
        membershipWatermark: "2026-07-30T01:00:00.000Z", limit: 10,
      })).resolves.toMatchObject({ membershipWatermark: "2026-07-30T01:00:00.000Z",
        observedAt: "2026-07-30T00:59:59.000Z" });
    } finally { revokePlatformTransaction(lease); }
  });

  it("filters Holds through EXISTS so matching one source never truncates complete multi-Grant counts", async () => {
    const calls: { statement: string; values: readonly unknown[] }[] = [];
    const lease = issuePlatformTransaction({ execute: async () => 0, query: async (statement, values = []) => {
      calls.push({ statement, values });
      if (statement.includes("transaction_timestamp()")) {
        return [{ observedAt: "2026-07-30T00:00:00.000Z" }] as never;
      }
      return [{ siteId: "site-1", creditHoldRef: "44444444-4444-4444-8444-444444444444",
        creditAccountRef: "11111111-1111-4111-8111-111111111111", executionRootRef: "execution:1",
        unit: "credit", requestedAmount: "100", reservedAmount: "100", capturedAmount: "0",
        releasedAmount: "0", state: "open", resolutionKind: null, resolutionRef: null,
        fenceEpoch: "1", expiresAt: "2026-07-30T02:00:00.000Z", settledAt: null, releasedAt: null,
        createdAt: "2026-07-30T00:00:00.000Z", updatedAt: "2026-07-30T00:00:00.000Z",
        grantCount: "2", sourceCount: "2" }] as never;
    } });
    const reader = new PostgresAdminCreditReader({ adminSiteQueryTransaction:
      async (_permit, _siteRef, work) => work(lease.transaction) });
    try {
      await expect(reader.listCreditHolds(permit("credit.hold.read"), {
        siteId: "site-1", creditGrantId: null, creditAccountRef: null, sourceType: "payment",
        sourceRef: "shared-ref", executionRootRef: null, afterRef: null,
        membershipWatermark: null, limit: 10,
      })).resolves.toMatchObject({ items: [{ grantCount: 2n, sourceCount: 2n }] });
      const sql = calls[1]!.statement;
      expect(sql).toMatch(/count\(DISTINCT allocation\.credit_grant_id\)[\s\S]+WHERE[\s\S]+EXISTS/u);
      expect(sql).toMatch(/source_grant\.source_type=\$[0-9]+[\s\S]+source_grant\.source_ref=\$[0-9]+/u);
      expect(calls[1]!.values).toEqual(expect.arrayContaining(["payment", "shared-ref"]));
    } finally { revokePlatformTransaction(lease); }
  });

  it("lists Hold allocations bidirectionally by Hold or Grant", async () => {
    const values: (readonly unknown[])[] = [];
    const lease = issuePlatformTransaction({ execute: async () => 0, query: async (statement, parameters = []) => {
      if (statement.includes("transaction_timestamp()")) {
        return [{ observedAt: "2026-07-30T00:00:00.000Z" }] as never;
      }
      values.push(parameters);
      return [] as never;
    } });
    const reader = new PostgresAdminCreditReader({ adminSiteQueryTransaction:
      async (_permit, _siteRef, work) => work(lease.transaction) });
    try {
      await reader.listCreditHoldAllocations(permit("credit.hold.read"), {
        siteId: "site-1", creditHoldRef: "44444444-4444-4444-8444-444444444444",
        creditGrantId: null, afterHoldRef: null, afterAllocationOrdinal: null,
        membershipWatermark: null, limit: 10,
      });
      await reader.listCreditHoldAllocations(permit("credit.hold.read"), {
        siteId: "site-1", creditHoldRef: null,
        creditGrantId: "33333333-3333-4333-8333-333333333333",
        afterHoldRef: null, afterAllocationOrdinal: null,
        membershipWatermark: null, limit: 10,
      });
      expect(values[0]).toContain("44444444-4444-4444-8444-444444444444");
      expect(values[1]).toContain("33333333-3333-4333-8333-333333333333");
    } finally { revokePlatformTransaction(lease); }
  });

  it("reads RatedUsage source allocations from the durable settlement-to-Grant link", async () => {
    const statements: string[] = [];
    const lease = issuePlatformTransaction({ execute: async () => 0, query: async (statement) => {
      statements.push(statement);
      if (statement.includes("transaction_timestamp()")) {
        return [{ observedAt: "2026-07-30T00:00:01.000Z" }] as never;
      }
      return [{ siteId: "site-1", ratedUsageRef: "55555555-5555-4555-8555-555555555555",
        settlementRef: "66666666-6666-4666-8666-666666666666",
        creditGrantId: "33333333-3333-4333-8333-333333333333", direction: "decrease",
        amount: "7", allocationOrdinal: 1, sourceOrdinal: 2 }] as never;
    } });
    const reader = new PostgresAdminCreditReader({ adminSiteQueryTransaction:
      async (_permit, _siteRef, work) => work(lease.transaction) });
    try {
      await expect(reader.listRatedUsageSourceAllocations(permit("credit.rated-usage.read"), {
        siteId: "site-1", ratedUsageRef: "55555555-5555-4555-8555-555555555555",
        settlementRef: null, afterRatedUsageRef: null, afterSourceOrdinal: null,
        membershipWatermark: null, limit: 10,
      })).resolves.toMatchObject({ items: [{
        ratedUsageRef: "55555555-5555-4555-8555-555555555555",
        settlementRef: "66666666-6666-4666-8666-666666666666",
        creditGrantId: "33333333-3333-4333-8333-333333333333",
        direction: "decrease", amount: "7", allocationOrdinal: 1, sourceOrdinal: 2,
      }] });
      expect(statements[1]).toMatch(/credit_rated_usage[\s\S]+credit_usage_settlement_source/u);
    } finally { revokePlatformTransaction(lease); }
  });
});

function permit(operation: string): AdminQueryPermit {
  return { operatorRef: "operator:1", environment: "production", region: "us-east-1",
    operation, authorityBindingDigest: "a".repeat(64),
    scope: { kind: "site", siteRefs: ["site-1"] } } as AdminQueryPermit;
}
