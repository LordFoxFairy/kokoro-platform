import { describe, expect, it } from "vitest";
import { PostgresCommerceRepository } from
  "../../src/modules/commerce/infrastructure/postgres/repository.js";
import { createFrozenFulfillmentSnapshot, createFulfillmentSourceIdentity } from
  "../../src/modules/commerce/domain/fulfillment-source.js";
import { issuePlatformTransaction, revokePlatformTransaction, type PlatformSqlTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";

describe("PostgresCommerceRepository fulfillment claim", () => {
  it("claims a source identity once with its immutable acquisition snapshot", async () => {
    const executions: Array<{ statement: string; values: readonly unknown[] }> = [];
    const lease = issuePlatformTransaction({
      query: async (statement, values) => {
        executions.push({ statement, values: values ?? [] });
        return statement.includes("INSERT INTO platform.commerce_fulfillment_transaction")
          ? [{ fulfillmentId: "00000000-0000-7000-8000-000000000001" }] as never
          : [];
      },
      execute: async () => 0,
    });
    try {
      await expect(new PostgresCommerceRepository().claimFulfillment(lease.transaction, claimInput()))
        .resolves.toEqual({ disposition: "execute", fulfillmentId: "00000000-0000-7000-8000-000000000001" });
      expect(executions[0]!.statement).toContain("ON CONFLICT (idempotency_key) DO NOTHING");
      expect(executions[0]!.values).toContain(claimInput().source.idempotencyKey);
      expect(executions[0]!.values).toContain(claimInput().snapshot.acquisitionSnapshotDigest);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("returns the settled receipt when the same payment source is delivered again", async () => {
    const claim = claimInput({ sourceType: "payment", sourceRef: "settlement-7", pricingSnapshotRef: "price-v7" });
    const sql: PlatformSqlTransaction = {
      query: async (statement) => {
        if (statement.includes("INSERT INTO platform.commerce_fulfillment_transaction")) return [];
        if (statement.includes("FROM platform.commerce_fulfillment_transaction")) return [{
          fulfillmentId: "00000000-0000-7000-8000-000000000007",
          siteId: claim.source.siteId,
          sourceType: claim.source.sourceType,
          sourceRef: claim.source.sourceRef,
          purpose: claim.source.purpose,
          cycleKey: claim.source.cycleKey,
          idempotencyKey: claim.source.idempotencyKey,
          billingAccountId: claim.billingAccountId,
          productVersionRef: claim.snapshot.productVersionRef,
          planVersionRef: claim.snapshot.planVersionRef,
          offeringVersionRef: claim.snapshot.offeringVersionRef,
          fulfillmentProgramVersionRef: claim.snapshot.fulfillmentProgramVersionRef,
          outputPlanDigest: claim.snapshot.outputPlanDigest,
          acquisitionSnapshotDigest: claim.snapshot.acquisitionSnapshotDigest,
          pricingSnapshotRef: claim.snapshot.pricingSnapshotRef,
          outputSetDigest: "c".repeat(64), resultDigest: "d".repeat(64), status: "succeeded",
        }] as never;
        if (statement.includes("FROM platform.commerce_fulfillment_actual_output")) return [{
          kind: "credit_grant", outputLineId: "credits", resourceRef: "grant-7", templateRevisionRef: "credits-v1",
        }] as never;
        return [];
      },
      execute: async () => 0,
    };
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresCommerceRepository().claimFulfillment(lease.transaction, claim)).resolves.toEqual({
        disposition: "replay",
        receipt: {
          fulfillmentId: "00000000-0000-7000-8000-000000000007",
          outputSetDigest: "c".repeat(64), resultDigest: "d".repeat(64),
          outputs: [{ kind: "credit_grant", outputLineId: "credits", resourceRef: "grant-7",
            templateRevisionRef: "credits-v1" }],
        },
      });
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects source replay when any frozen snapshot field differs", async () => {
    const claim = claimInput();
    const lease = issuePlatformTransaction({
      query: async (statement) => statement.includes("INSERT INTO platform.commerce_fulfillment_transaction") ? [] : [{
        fulfillmentId: claim.fulfillmentId,
        siteId: claim.source.siteId,
        sourceType: claim.source.sourceType,
        sourceRef: claim.source.sourceRef,
        purpose: claim.source.purpose,
        cycleKey: claim.source.cycleKey,
        idempotencyKey: claim.source.idempotencyKey,
        billingAccountId: claim.billingAccountId,
        productVersionRef: "different-product-version",
        planVersionRef: claim.snapshot.planVersionRef,
        offeringVersionRef: claim.snapshot.offeringVersionRef,
        fulfillmentProgramVersionRef: claim.snapshot.fulfillmentProgramVersionRef,
        outputPlanDigest: claim.snapshot.outputPlanDigest,
        acquisitionSnapshotDigest: claim.snapshot.acquisitionSnapshotDigest,
        pricingSnapshotRef: claim.snapshot.pricingSnapshotRef,
        outputSetDigest: "c".repeat(64), resultDigest: "d".repeat(64), status: "succeeded",
      }] as never,
      execute: async () => 0,
    });
    try {
      await expect(new PostgresCommerceRepository().claimFulfillment(lease.transaction, claim))
        .rejects.toThrow("FULFILLMENT_SOURCE_CONFLICT");
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});

function claimInput(overrides: Readonly<{
  sourceType?: "redemption" | "payment";
  sourceRef?: string;
  pricingSnapshotRef?: string | null;
}> = {}) {
  const sourceType = overrides.sourceType ?? "redemption";
  return {
    fulfillmentId: "00000000-0000-7000-8000-000000000001",
    commandId: "0123456789abcdef0123456789abcdef",
    billingAccountId: "billing-a",
    source: createFulfillmentSourceIdentity({
      siteId: "site-a", sourceType, sourceRef: overrides.sourceRef ?? "code-a", purpose: "acquisition", cycleKey: "once",
    }),
    snapshot: createFrozenFulfillmentSnapshot({
      sourceType, productVersionRef: "product-v1", planVersionRef: null, offeringVersionRef: "offer-v1",
      fulfillmentProgramVersionRef: "fulfillment-v1", outputPlanDigest: "a".repeat(64),
      acquisitionSnapshotDigest: "b".repeat(64), pricingSnapshotRef: overrides.pricingSnapshotRef ?? null,
    }),
  };
}
