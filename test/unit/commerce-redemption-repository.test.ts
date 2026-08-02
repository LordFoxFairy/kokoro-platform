import { describe, expect, it } from "vitest";
import { PostgresRedemptionRepository } from "../../src/modules/commerce/infrastructure/postgres/redemption-repository.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
  type PlatformSqlTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";
import { publishedFulfillmentOutputPlanDigest } from "../../src/modules/commerce/domain/redemption-preview.js";
import { RedemptionPolicyError } from "../../src/modules/commerce/domain/redemption-preview.js";
import type { CreditGrantProgramPort } from
  "../../src/modules/credit/application/contracts/grant-program.js";

describe("PostgresRedemptionRepository preview", () => {
  it("uses snake-case HMAC lookup DTOs and expands frozen output cardinality", async () => {
    const calls: { statement: string; values: readonly unknown[] }[] = [];
    const outputRows = [
      { outputLineId: "term", outputKind: "subscription_term" as const, ordinal: 1, cardinality: 1, ownerRevision: 1n, ownerRevisionDigest: "d".repeat(64), planVersionRef: "plan-v1", creditProgramRevisionRef: null, creditProgramRevisionVersion: null, creditProgramRevisionDigest: null, bucketClass: null, unit: null, amount: null, creditExpiresAfterSeconds: null, entitlementTemplateRevisionRef: null, capabilityKey: null, safeLabel: null, entitlementExpiresAfterSeconds: null },
      { outputLineId: "credits", outputKind: "credit_grant" as const, ordinal: 2, cardinality: 2, ownerRevision: 1n, ownerRevisionDigest: "c".repeat(64), planVersionRef: null, creditProgramRevisionRef: "credit-v1", creditProgramRevisionVersion: 1n, creditProgramRevisionDigest: "c".repeat(64), bucketClass: "permanent" as const, unit: "credit", amount: "100", creditExpiresAfterSeconds: null, entitlementTemplateRevisionRef: null, capabilityKey: null, safeLabel: null, entitlementExpiresAfterSeconds: null },
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
          observedAt: new Date("2026-07-29T01:00:30.000Z"),
          legalTermRefs: ["terms-v1"],
        }] as never;
        return outputRows as never;
      },
    };
    const lease = issuePlatformTransaction(sql);
    try {
      const result = await new PostgresRedemptionRepository(creditPrograms()).resolvePreviewCandidate(lease.transaction, {
        siteId: "site-1",
        billingAccountId: "billing-1",
        lookupCandidates: [{ keyRevision: "code-1", batchSelector: "0123456789", lookupDigest: "d".repeat(64) }],
      });
      expect(JSON.parse(calls[0]!.values[1] as string)).toEqual([
        { key_revision: "code-1", batch_selector: "0123456789", lookup_digest: "d".repeat(64) },
      ]);
      expect(calls[0]!.statement).toContain("commerce_redemption_program_availability");
      expect(calls[0]!.statement).toContain("clock_timestamp()");
      expect(calls[0]!.statement).toContain("subscription.billing_account_ref=$3");
      expect(calls[0]!.statement).toContain("plan.plan_ref IS NOT NULL");
      expect(result?.observedAt).toBe("2026-07-29T01:00:30.000Z");
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

  it.each(["daily", "period"] as const)(
    "fails closed for %s credit outputs until calendar-window acquisition is an authority",
    async (bucketClass) => {
      const outputRows = [{
        outputLineId: "credits", outputKind: "credit_grant" as const, ordinal: 1, cardinality: 1,
        ownerRevision: 1n, ownerRevisionDigest: "c".repeat(64),
        planVersionRef: null, creditProgramRevisionRef: "credit-v1", creditProgramRevisionVersion: 1n,
        creditProgramRevisionDigest: "c".repeat(64), bucketClass, unit: "credit",
        amount: "100", creditExpiresAfterSeconds: 86400n, entitlementTemplateRevisionRef: null,
        capabilityKey: null, safeLabel: null, entitlementExpiresAfterSeconds: null,
      }];
      const outputPlanDigest = publishedFulfillmentOutputPlanDigest({
        siteId: "site-1", fulfillmentProgramRevisionRef: "fulfillment-v1", lines: outputRows,
      });
      const lease = issuePlatformTransaction({
        execute: async () => 0,
        query: async (statement) => statement.includes("jsonb_to_recordset") ? [{
          codeRef: "00000000-0000-7000-8000-000000000001",
          batchRef: "00000000-0000-7000-8000-000000000002",
          redemptionProgramRevisionRef: "redeem-program-v1", fulfillmentProgramRevisionRef: "fulfillment-v1",
          productRevisionDigest: "a".repeat(64), programDigest: "b".repeat(64), outputPlanDigest,
          safeCodeFingerprint: "CODE-0123456789ABCDEF", productRef: "product-1",
          productVersionRef: "product-v1", productKind: "credit_pack", safeProductLabel: "Credits",
          planRef: null, planVersionRef: null, safePlanLabel: null, termAction: null, termSeconds: null,
          activeTermEndsAt: null, observedAt: new Date("2026-07-29T01:00:30.000Z"), legalTermRefs: [],
        }] as never : outputRows as never,
      });
      try {
        await expect(new PostgresRedemptionRepository(creditPrograms(bucketClass)).resolvePreviewCandidate(lease.transaction, {
          siteId: "site-1", billingAccountId: "billing-1",
          lookupCandidates: [{ keyRevision: "code-1", batchSelector: "0123456789", lookupDigest: "d".repeat(64) }],
        })).rejects.toBeInstanceOf(RedemptionPolicyError);
      } finally {
        revokePlatformTransaction(lease);
      }
    },
  );
});

function creditPrograms(bucketClass: "daily" | "period" | "permanent" = "permanent"): CreditGrantProgramPort {
  const resolve = (targets: readonly Readonly<{ revisionRef: string; revision: bigint; revisionDigest: string }>[]) =>
    targets.map((target) => Object.freeze({
      ...target,
      bucketClass,
      unit: "credit",
      amount: "100",
      expiresAfterSeconds: bucketClass === "permanent" ? null : 86400n,
      windowKind: bucketClass === "permanent" ? "none" as const : bucketClass,
      calendarZone: bucketClass === "permanent" ? null : "America/New_York",
      windowAnchor: bucketClass === "permanent" ? null :
        bucketClass === "daily" ? "daily@00:00:00" : "subscription-term-start",
      liabilityMerchantAccountId: "merchant-1",
      burnPriority: 100,
      scopePolicy: Object.freeze({ version: 1 as const, surfaceRefs: ["general.chat"],
        capabilityKeys: ["general.chat.message"], agentRefs: [], allowUnattributedAgent: true }),
    }));
  return {
    resolveTargets: async (_transaction, input) => resolve(input.targets),
    resolveRefs: async (_transaction, input) => resolve(input.revisionRefs.map((revisionRef) => ({
      revisionRef, revision: 1n, revisionDigest: "c".repeat(64),
    }))),
    publishRevision: async () => undefined,
  };
}
