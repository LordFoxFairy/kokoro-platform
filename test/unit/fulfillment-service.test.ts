import { describe, expect, it } from "vitest";
import { FulfillmentService } from "../../src/modules/commerce/application/services/fulfillment.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";

const outputPlanDigest = "a".repeat(64);
const acquisitionSnapshotDigest = "b".repeat(64);
const outputSetDigest = "c".repeat(64);
const resultDigest = "d".repeat(64);

describe("FulfillmentService", () => {
  it("is the only issuer and commits a frozen output receipt", async () => {
    const calls: string[] = [];
    const service = new FulfillmentService({
      repository: {
        claimFulfillment: async (_transaction, claim) => {
          calls.push(`claim:${claim.source.idempotencyKey}`);
          return { disposition: "execute" as const, fulfillmentId: claim.fulfillmentId };
        },
        recordExpectedOutputPlan: async () => { calls.push("plan"); },
        recordActualOutputs: async () => { calls.push("actual"); },
        completeFulfillment: async () => { calls.push("complete"); },
      },
      issuer: {
        issue: async () => {
          calls.push("issue");
          return {
            outputs: [{
              kind: "credit_grant" as const,
              outputLineId: "credits",
              resourceRef: "grant-1",
              templateRevisionRef: "credits-v1",
            }],
            actual: [{
              outputLineId: "credits",
              occurrence: 1,
              templateRevision: "credits-v1",
              outputKind: "credit_grant" as const,
              outputRef: "grant-1",
            }],
          };
        },
      },
    });
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
    try {
      const receipt = await service.execute(lease.transaction, input({ sourceType: "redemption", pricingSnapshotRef: null }));

      expect(receipt).toMatchObject({ fulfillmentId: "00000000-0000-7000-8000-000000000001" });
      expect(receipt.outputSetDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(calls.map((call) => call.split(":")[0])).toEqual(["claim", "plan", "issue", "actual", "complete"]);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("replays a settled acquisition without issuing any output again", async () => {
    let issueCount = 0;
    const replay = Object.freeze({
      fulfillmentId: "00000000-0000-7000-8000-000000000009",
      outputSetDigest,
      resultDigest,
      outputs: Object.freeze([{ kind: "credit_grant" as const, outputLineId: "credits",
        resourceRef: "grant-9", templateRevisionRef: "credits-v1" }]),
    });
    const service = new FulfillmentService({
      repository: {
        claimFulfillment: async () => ({ disposition: "replay" as const, receipt: replay }),
        recordExpectedOutputPlan: async () => { throw new Error("PLAN_MUST_NOT_REPEAT"); },
        recordActualOutputs: async () => { throw new Error("ACTUAL_MUST_NOT_REPEAT"); },
        completeFulfillment: async () => { throw new Error("COMPLETION_MUST_NOT_REPEAT"); },
      },
      issuer: { issue: async () => { issueCount += 1; throw new Error("ISSUE_MUST_NOT_REPEAT"); } },
    });
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
    try {
      await expect(service.execute(lease.transaction, input({
        sourceType: "payment",
        sourceRef: "settlement-9",
        pricingSnapshotRef: "price-v3",
      }))).resolves.toEqual(replay);
      expect(issueCount).toBe(0);
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});

function input(overrides: Readonly<{
  sourceType: "redemption" | "payment";
  sourceRef?: string;
  pricingSnapshotRef: string | null;
}>) {
  return {
    fulfillmentId: "00000000-0000-7000-8000-000000000001",
    commandId: "0123456789abcdef0123456789abcdef",
    siteId: "site-a",
    billingAccountId: "billing-a",
    sourceType: overrides.sourceType,
    sourceRef: overrides.sourceRef ?? "code-a",
    purpose: "acquisition",
    cycleKey: "once",
    productVersionRef: "product-v1",
    planVersionRef: null,
    offeringVersionRef: "offer-v1",
    fulfillmentProgramVersionRef: "fulfillment-v1",
    outputPlanDigest,
    acquisitionSnapshotDigest,
    pricingSnapshotRef: overrides.pricingSnapshotRef,
    outputPlan: [{ outputLineId: "credits", ordinal: 0, cardinality: 1,
      templateRevision: "credits-v1", outputKind: "credit_grant" as const, disposition: "required" as const }],
    materialization: Object.freeze({ kind: "test" as const }),
  };
}
