import { describe, expect, it } from "vitest";
import { PostgresRedemptionRepository } from "../../src/modules/commerce/infrastructure/postgres/redemption-repository.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
  type PlatformSqlTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";
import { publishedFulfillmentOutputPlanDigest } from "../../src/modules/commerce/domain/redemption-preview.js";

describe("PostgresRedemptionRepository preview", () => {
  it("uses snake-case HMAC lookup DTOs and expands frozen output cardinality", async () => {
    const calls: { statement: string; values: readonly unknown[] }[] = [];
    const outputRows = [
      { outputLineId: "term", outputKind: "subscription_term" as const, ordinal: 0, cardinality: 1, planVersionRef: "plan-v1", creditProgramRevisionRef: null, bucketClass: null, unit: null, amount: null, creditExpiresAfterSeconds: null, entitlementTemplateRevisionRef: null, capabilityKey: null, safeLabel: null, entitlementExpiresAfterSeconds: null },
      { outputLineId: "credits", outputKind: "credit_grant" as const, ordinal: 1, cardinality: 2, planVersionRef: null, creditProgramRevisionRef: "credit-v1", bucketClass: "period" as const, unit: "credit", amount: "100", creditExpiresAfterSeconds: 86400n, entitlementTemplateRevisionRef: null, capabilityKey: null, safeLabel: null, entitlementExpiresAfterSeconds: null },
    ];
    const outputPlanDigest = publishedFulfillmentOutputPlanDigest({
      siteId: "site-1",
      fulfillmentProgramRevisionRef: "fulfillment-v1",
      lines: outputRows,
    });
    const sql: PlatformSqlTransaction = {
      execute: async () => 0,
      query: async (statement, values = []) => {
        calls.push({ statement, values });
        if (statement.includes("jsonb_to_recordset")) return [{
          codeRef: "00000000-0000-7000-8000-000000000001",
          batchRef: "00000000-0000-7000-8000-000000000002",
          redemptionProgramRevisionRef: "redeem-program-v1",
          fulfillmentProgramRevisionRef: "fulfillment-v1",
          productRevisionDigest: "a".repeat(64),
          programDigest: "b".repeat(64),
          outputPlanDigest,
          safeCodeFingerprint: "CODE-0123456789ABCDEF",
          productRef: "product-1",
          productVersionRef: "product-v1",
          productKind: "bundle",
          safeProductLabel: "Pro bundle",
          planRef: "plan-1",
          planVersionRef: "plan-v1",
          safePlanLabel: "Pro",
          termAction: "extend_from_max",
          termSeconds: 3600n,
          activeTermEndsAt: new Date("2026-07-29T02:00:00.000Z"),
          legalTermRefs: ["terms-v1"],
        }] as never;
        return outputRows as never;
      },
    };
    const lease = issuePlatformTransaction(sql);
    try {
      const result = await new PostgresRedemptionRepository().resolvePreviewCandidate(lease.transaction, {
        siteId: "site-1",
        billingAccountId: "billing-1",
        lookupCandidates: [{ keyRevision: "code-1", lookupDigest: "d".repeat(64) }],
        now: "2026-07-29T01:00:00.000Z",
      });
      expect(JSON.parse(calls[0]!.values[1] as string)).toEqual([
        { key_revision: "code-1", lookup_digest: "d".repeat(64) },
      ]);
      expect(calls[0]!.statement).toContain("commerce_redemption_program_availability");
      expect(calls[0]!.statement).toContain("subscription.billing_account_ref=$4");
      expect(result?.safeTerms.term).toEqual({
        action: "extend_from_max",
        automaticRenewal: false,
        startsAt: "2026-07-29T02:00:00.000Z",
        endsAt: "2026-07-29T03:00:00.000Z",
      });
      expect(result?.safeTerms.credits).toHaveLength(2);
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});
