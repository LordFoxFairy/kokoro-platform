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
        afterOrdinal: null, limit: 10,
      })).resolves.toMatchObject([{ sourceRef: "redeem:1", executionRootRef: "execution:1" }]);
      expect(statements[0]).toMatch(/credit_journal_entry[\s\S]+credit_grant[\s\S]+credit_hold/u);
      expect(statements[0]).not.toMatch(/evidence|snapshot|line_items/u);
    } finally { revokePlatformTransaction(lease); }
  });
});

function permit(operation: string): AdminQueryPermit {
  return { operatorRef: "operator:1", environment: "production", region: "us-east-1",
    operation, scope: { kind: "site", siteRefs: ["site-1"] } } as AdminQueryPermit;
}
