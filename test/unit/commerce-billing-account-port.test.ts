import { describe, expect, it } from "vitest";
import { PostgresCommerceBillingAccountPort } from "../../src/modules/commerce/infrastructure/postgres/subscription-port.js";
import { CommerceLockSequence } from "../../src/workflows/commerce/lock-order.js";
import { issuePlatformTransaction, revokePlatformTransaction, type PlatformSqlTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";

describe("Commerce BillingAccount authority", () => {
  it("resolves the active Site membership at the BillingAccount lock node", async () => {
    const statements: string[] = [];
    const sql: PlatformSqlTransaction = {
      query: async (statement, values) => {
        statements.push(`${statement}\n${JSON.stringify(values)}`);
        return [{ billingAccountId: "billing-1", accountState: "active", aggregateVersion: 9n, membershipState: "active", membershipEpoch: 4n, subjectGeneration: 3n }] as never;
      },
      execute: async () => 0,
    };
    const lease = issuePlatformTransaction(sql);
    const locks = new CommerceLockSequence();
    locks.enter("program_availability");
    try {
      await expect(new PostgresCommerceBillingAccountPort().resolveBillingAccount(lease.transaction, locks, { siteId: "site-1", subjectId: "user-1", subjectGeneration: "3" })).resolves.toEqual({ billingAccountId: "billing-1", membershipEpoch: "4", aggregateVersion: "9" });
      expect(statements[0]).toContain("membership.site_ref=$1 AND membership.subject_ref=$2");
      expect(statements[0]).toContain("FOR UPDATE OF account,membership");
      expect(() => locks.enter("batch_availability")).toThrow("COMMERCE_LOCK_ORDER_VIOLATION");
    } finally { revokePlatformTransaction(lease); }
  });
});
