import { describe, expect, it } from "vitest";
import { PostgresAccountReadRepository } from
  "../../src/modules/credit/infrastructure/postgres/commerce-account-read-repository.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";

describe("PostgresAccountReadRepository", () => {
  it("projects product ownership only through committed fulfillment output facts", async () => {
    const statements: string[] = [];
    const lease = issuePlatformTransaction({
      execute: async () => 0,
      query: async (statement) => {
        statements.push(statement);
        if (statement.includes("commerce_fulfillment_transaction")) return [];
        return [{ asOf: "2026-07-30T02:00:00.000Z", revision: "41" }] as never;
      },
    });
    const repository = new PostgresAccountReadRepository();
    try {
      await repository.listAccountProducts(lease.transaction, {
        siteId: "site-1", subjectId: "subject-1", subjectGeneration: "2",
      });
      const query = statements[0] ?? "";
      expect(query).toMatch(/commerce_fulfillment_actual_output actual[\s\S]+actual\.fulfillment_id=fulfillment\.fulfillment_id/u);
      expect(query).toMatch(/actual\.output_kind='credit_grant'[\s\S]+grant_fact\.credit_grant_id::text=actual\.output_ref/u);
      expect(query).toMatch(/actual\.output_kind='entitlement_grant'[\s\S]+entitlement\.entitlement_grant_ref::text=actual\.output_ref/u);
      expect(query).toMatch(/actual\.output_kind='subscription_term'[\s\S]+term\.subscription_term_ref::text=actual\.output_ref/u);
      expect(query).not.toMatch(/\bgrant\./u);
      expect(query).not.toMatch(/grant_fact\.source_ref=fulfillment\.source_id/u);
      expect(query).not.toMatch(/entitlement\.source_ref=fulfillment\.source_id/u);
      expect(query).not.toMatch(/term\.source_ref=fulfillment\.source_id/u);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("uses a non-reserved table alias for every Credit Grant account read", async () => {
    const statements: string[] = [];
    const lease = issuePlatformTransaction({
      execute: async () => 0,
      query: async (statement) => {
        statements.push(statement);
        if (statement.includes('AS "activeHoldCount"')) {
          return [{
            activeHoldCount: 0,
            asOf: "2026-07-30T02:00:00.000Z",
            revision: "41",
          }] as never;
        }
        return [];
      },
    });
    const repository = new PostgresAccountReadRepository();
    const identity = { siteId: "site-1", subjectId: "subject-1", subjectGeneration: "2" };
    try {
      await repository.getCreditGrant(lease.transaction, { ...identity, grantId: crypto.randomUUID() });
      await repository.getCreditSummary(lease.transaction, identity);

      const grantQueries = statements.filter((statement) =>
        statement.includes("FROM platform.credit_grant"));
      expect(grantQueries).toHaveLength(2);
      for (const query of grantQueries) {
        expect(query).toMatch(/FROM platform\.credit_grant grant_fact\b/u);
        expect(query).not.toMatch(/\bgrant\./u);
      }
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});
