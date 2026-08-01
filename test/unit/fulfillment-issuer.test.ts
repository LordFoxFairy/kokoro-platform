import { describe, expect, it } from "vitest";
import {
  PostgresFulfillmentIssuer,
  fulfillmentCreditAccountIdentity,
  type FulfillmentOutputDefinition,
} from "../../src/modules/commerce/infrastructure/postgres/fulfillment-issuer.js";
import { createFrozenFulfillmentSnapshot, createFulfillmentSourceIdentity } from
  "../../src/modules/commerce/domain/fulfillment-source.js";
import { PostgresCreditGrantIssuer } from
  "../../src/modules/credit/infrastructure/postgres/credit-grant-issuer.js";
import type { CreditGrantIssuancePort } from
  "../../src/modules/credit/application/contracts/grant-issuance.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";

describe("PostgresFulfillmentIssuer", () => {
  it("issues a payment acquisition through the same CreditGrant and Journal authority", async () => {
    const executions: Array<{ statement: string; values: readonly unknown[] }> = [];
    const output = creditOutput();
    const identity = fulfillmentCreditAccountIdentity("site-a", "billing-a", output);
    const lease = issuePlatformTransaction({
      query: async (statement) => statement.includes("FROM platform.credit_account") ? [{
        creditAccountId: "00000000-0000-7000-8000-000000000010", state: "active", aggregateVersion: 1n,
      }] as never : [],
      execute: async (statement, values) => {
        executions.push({ statement, values: values ?? [] });
        return 1;
      },
    });
    const creditGrants = new PostgresCreditGrantIssuer({ reference: referenceFactory() });
    try {
      const preparation = await creditGrants.prepareAccounts(lease.transaction, { accounts: [identity] });
      if (preparation.kind !== "ready") throw new Error("test preparation rejected");
      await new PostgresFulfillmentIssuer(creditGrants).issue(lease.transaction, {
        fulfillmentId: "00000000-0000-7000-8000-000000000001",
        commandId: "0123456789abcdef0123456789abcdef",
        billingAccountId: "billing-a",
        source: createFulfillmentSourceIdentity({
          siteId: "site-a", sourceType: "payment", sourceRef: "payment-settlement-1",
          purpose: "acquisition", cycleKey: "once",
        }),
        snapshot: createFrozenFulfillmentSnapshot({
          sourceType: "payment", productVersionRef: "product-v1", planVersionRef: null,
          offeringVersionRef: "offer-v1", fulfillmentProgramVersionRef: "fulfillment-v1",
          outputPlanDigest: "a".repeat(64), acquisitionSnapshotDigest: "b".repeat(64),
          pricingSnapshotRef: "price-v1",
        }),
        materialization: {
          siteId: "site-a",
          effectAt: "2026-07-29T01:00:00.000Z",
          outputs: [output],
          nextRef: referenceFactory(),
          creditGrantPreparation: preparation.preparation,
          subscription: null,
          subscriptionTerm: null,
          stackingScope: null,
          planRef: null,
        },
      });

      const grant = executions.find(({ statement }) => statement.includes("INSERT INTO platform.credit_grant"));
      expect(grant?.values[5]).toBe("payment");
      const journal = executions.find(({ statement }) => statement.includes("INSERT INTO platform.credit_journal_transaction"));
      expect(journal?.values[4]).toMatch(/^fulfillment:[a-f0-9]{64}:credits:1$/u);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects duplicate or extra Credit receipts instead of silently accepting a partial multiset", async () => {
    const output = creditOutput();
    const identity = fulfillmentCreditAccountIdentity("site-a", "billing-a", output);
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 1 });
    const preparationOwner = new PostgresCreditGrantIssuer();
    try {
      const preparation = await preparationOwner.prepareAccounts(lease.transaction, { accounts: [identity] });
      if (preparation.kind !== "ready") throw new Error("test preparation rejected");
      const duplicateReceipt = Object.freeze({
        outputLineId: "credits",
        occurrence: 1,
        creditProgramRevisionRef: "credit-v1",
        creditGrantRef: "00000000-0000-7000-8000-000000000021" as never,
      });
      const creditGrants: CreditGrantIssuancePort = {
        prepareAccounts: async () => preparation,
        issueGrants: async () => [duplicateReceipt, duplicateReceipt],
      };
      await expect(new PostgresFulfillmentIssuer(creditGrants).issue(lease.transaction, {
        fulfillmentId: "00000000-0000-7000-8000-000000000001",
        commandId: "0123456789abcdef0123456789abcdef",
        billingAccountId: "billing-a",
        source: createFulfillmentSourceIdentity({ siteId: "site-a", sourceType: "redemption", sourceRef: "code-1",
          purpose: "acquisition", cycleKey: "once" }),
        snapshot: createFrozenFulfillmentSnapshot({ sourceType: "redemption", productVersionRef: "product-v1",
          planVersionRef: null, offeringVersionRef: "offer-v1", fulfillmentProgramVersionRef: "fulfillment-v1",
          outputPlanDigest: "a".repeat(64), acquisitionSnapshotDigest: "b".repeat(64), pricingSnapshotRef: null }),
        materialization: {
          siteId: "site-a", effectAt: "2026-07-29T01:00:00.000Z", outputs: [output], nextRef: referenceFactory(),
          creditGrantPreparation: preparation.preparation, subscription: null, subscriptionTerm: null,
          stackingScope: null, planRef: null,
        },
      })).rejects.toThrowError("FULFILLMENT_CREDIT_GRANT_RECEIPT_INVALID");
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});

function creditOutput(): FulfillmentOutputDefinition {
  return Object.freeze({
    outputLineId: "credits", outputKind: "credit_grant", ordinal: 0, cardinality: 1,
    planVersionRef: null, creditProgramRevisionRef: "credit-v1", bucketClass: "permanent",
    unit: "credit", amount: "100", creditExpiresAfterSeconds: null,
    liabilityMerchantAccountId: "merchant-a", burnPriority: 100,
    scopePolicy: { version: 1 as const, surfaceRefs: ["general.chat"], capabilityKeys: ["general.chat.message"],
      agentRefs: [], allowUnattributedAgent: true },
    entitlementTemplateRevisionRef: null, capabilityKey: null, safeLabel: null,
    entitlementExpiresAfterSeconds: null,
  });
}

function referenceFactory() {
  let ordinal = 20;
  return () => `00000000-0000-7000-8000-${(++ordinal).toString().padStart(12, "0")}`;
}
