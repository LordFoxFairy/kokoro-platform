import { describe, expect, it } from "vitest";
import { PostgresCommerceRepository } from
  "../../src/modules/commerce/infrastructure/postgres/repository.js";
import { canonicalFulfillmentTransaction, fulfillmentOutputDigest } from
  "../../src/modules/commerce/domain/canonical-fulfillment.js";
import { createFrozenFulfillmentSnapshot, createFulfillmentSourceIdentity } from
  "../../src/modules/commerce/domain/fulfillment-source.js";
import { issuePlatformTransaction, revokePlatformTransaction, type PlatformSqlTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";

describe("PostgresCommerceRepository fulfillment facts", () => {
  it("serializes by idempotency key without persisting a pending transaction", async () => {
    const statements: string[] = [];
    const lease = issuePlatformTransaction({
      query: async (statement) => { statements.push(statement); return []; },
      execute: async () => { throw new Error("CLAIM_MUST_NOT_WRITE"); },
    });
    try {
      await expect(new PostgresCommerceRepository().claimFulfillment(lease.transaction, claimInput()))
        .resolves.toEqual({ disposition: "execute", fulfillmentId: claimInput().fulfillmentId });
      expect(statements[0]).toContain("pg_advisory_xact_lock");
      expect(statements[1]).toContain("FROM platform.commerce_fulfillment_transaction");
      expect(statements.join("\n")).not.toContain("INSERT INTO platform.commerce_fulfillment_transaction");
      expect(statements.join("\n")).not.toMatch(/running|succeeded|failed/u);
    } finally { revokePlatformTransaction(lease); }
  });

  it("recomputes owner and transaction digests before atomically inserting one committed fact", async () => {
    const executions: Array<{ statement: string; values: readonly unknown[] }> = [];
    const lease = issuePlatformTransaction({
      query: async (statement) => statement.includes("clock_timestamp")
        ? [{ committedAt: "2026-07-30T02:00:01.000Z" }] as never : [],
      execute: async (statement, values) => { executions.push({ statement, values: values ?? [] }); return 1; },
    });
    const claim = claimInput();
    const outputBase = { kind: "credit_grant" as const, outputLineId: "credits", outputOrdinal: 1,
      occurrence: 1, outputRef: "grant-1", templateRevisionRef: "credit-v1", outputVersion: 1 as const };
    try {
      const receipt = await new PostgresCommerceRepository().commitFulfillment(lease.transaction, {
        claim,
        plan: [{ outputLineId: "credits", ordinal: 1, cardinality: 1, templateRevision: "credit-v1",
          outputKind: "credit_grant", disposition: "required" }],
        outputs: [{ outputLineId: "credits", outputOrdinal: 1, occurrence: 1,
          outputRef: "grant-1", templateRevision: "credit-v1", outputKind: "credit_grant", outputVersion: 1,
          outputDigest: fulfillmentOutputDigest(outputBase) }],
      });
      expect(receipt).toMatchObject({ fulfillmentId: claim.fulfillmentId, transactionVersion: 1 });
      expect(receipt.transactionDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(executions.map(({ statement }) => statement)).toEqual([
        expect.stringContaining("INSERT INTO platform.commerce_fulfillment_transaction"),
        expect.stringContaining("INSERT INTO platform.commerce_fulfillment_output_plan"),
        expect.stringContaining("INSERT INTO platform.commerce_fulfillment_actual_output"),
      ]);
      expect(executions[0]!.statement).toContain("'committed'");
      expect(executions.map(({ statement }) => statement).join("\n")).not.toMatch(/UPDATE platform\.commerce_fulfillment_transaction|running|succeeded|failed/u);
    } finally { revokePlatformTransaction(lease); }
  });

  it.each([1n, "1", 1] as const)(
    "normalizes a PostgreSQL output version %s before canonical replay",
    async (rawOutputVersion) => {
      const claim = claimInput({ sourceType: "payment", sourceRef: "settlement-7", pricingSnapshotRef: "price-v7" });
      const outputBase = { kind: "credit_grant" as const, outputLineId: "credits", outputOrdinal: 1,
        occurrence: 1, outputRef: "grant-7", templateRevisionRef: "credit-v1", outputVersion: 1 as const };
      const output = { ...outputBase, outputDigest: fulfillmentOutputDigest(outputBase) };
      const fact = canonicalFulfillmentTransaction({
        platformTransactionRef: claim.fulfillmentId, siteRef: claim.source.siteId,
        acquisition: { sourceKind: claim.source.sourceType, sourceRef: claim.source.sourceRef,
          sourceVersion: claim.snapshot.sourceVersion, sourceDigest: claim.snapshot.sourceDigest,
          acquiredAt: claim.snapshot.acquiredAt },
        program: { fulfillmentProgramRevisionRef: claim.snapshot.fulfillmentProgramRevisionRef,
          fulfillmentProgramRevision: claim.snapshot.fulfillmentProgramRevision,
          fulfillmentProgramDigest: claim.snapshot.fulfillmentProgramDigest },
        outputs: [output], committedAt: "2026-07-30T02:00:01.000Z",
      });
      let storedTransactionDigest = fact.transactionDigest;
      let storedOutputVersion: unknown = rawOutputVersion;
      const sql: PlatformSqlTransaction = {
        query: async (statement) => {
          if (statement.includes("pg_advisory_xact_lock")) return [{}] as never;
          if (statement.includes("FROM platform.commerce_fulfillment_transaction")) return [{
            fulfillmentId: claim.fulfillmentId, siteId: claim.source.siteId, billingAccountId: claim.billingAccountId,
            sourceType: claim.source.sourceType, sourceRef: claim.source.sourceRef, purpose: claim.source.purpose,
            cycleKey: claim.source.cycleKey, idempotencyKey: claim.source.idempotencyKey,
            productVersionRef: claim.snapshot.productVersionRef, planVersionRef: claim.snapshot.planVersionRef,
            offeringVersionRef: claim.snapshot.offeringVersionRef, sourceVersion: claim.snapshot.sourceVersion,
            sourceDigest: claim.snapshot.sourceDigest, acquiredAt: claim.snapshot.acquiredAt,
            fulfillmentProgramRevisionRef: claim.snapshot.fulfillmentProgramRevisionRef,
            fulfillmentProgramRevision: claim.snapshot.fulfillmentProgramRevision,
            fulfillmentProgramDigest: claim.snapshot.fulfillmentProgramDigest,
            pricingSnapshotRef: claim.snapshot.pricingSnapshotRef, outputSetDigest: fact.outputSetDigest,
            transactionVersion: 1n, transactionDigest: storedTransactionDigest, committedAt: fact.committedAt,
          }] as never;
          if (statement.includes("FROM platform.commerce_fulfillment_actual_output")) return [{
            kind: output.kind, outputLineId: output.outputLineId, outputOrdinal: output.outputOrdinal,
            occurrence: output.occurrence, resourceRef: output.outputRef,
            templateRevisionRef: output.templateRevisionRef, outputVersion: storedOutputVersion,
            outputDigest: output.outputDigest,
          }] as never;
          return [];
        },
        execute: async () => 0,
      };
      const lease = issuePlatformTransaction(sql);
      try {
        const repository = new PostgresCommerceRepository();
        await expect(repository.claimFulfillment(lease.transaction, claim)).resolves.toEqual({
          disposition: "replay",
          receipt: { fulfillmentId: claim.fulfillmentId, transactionVersion: 1,
            transactionDigest: fact.transactionDigest, outputSetDigest: fact.outputSetDigest,
            outputs: [{ kind: output.kind, outputLineId: output.outputLineId,
              outputOrdinal: output.outputOrdinal, occurrence: output.occurrence, resourceRef: output.outputRef,
              templateRevisionRef: output.templateRevisionRef, outputVersion: output.outputVersion,
              outputDigest: output.outputDigest }] },
        });
        storedTransactionDigest = "f".repeat(64);
        await expect(repository.claimFulfillment(lease.transaction, claim))
          .rejects.toThrow("FULFILLMENT_TRANSACTION_DIGEST_MISMATCH");
        storedTransactionDigest = fact.transactionDigest;
        for (const invalid of [
          0n, 2n, "0", "2", "01", "1.0", 0, 2, 1.5, Number.NaN,
          Number.POSITIVE_INFINITY, null, undefined, {},
        ]) {
          storedOutputVersion = invalid;
          await expect(repository.claimFulfillment(lease.transaction, claim))
            .rejects.toThrow("FULFILLMENT_OUTPUT_VERSION_INVALID");
        }
      } finally { revokePlatformTransaction(lease); }
    },
  );
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
      sourceType, sourceVersion: 1n, sourceDigest: "b".repeat(64), acquiredAt: "2026-07-30T02:00:00.000Z",
      productVersionRef: "product-v1", planVersionRef: null, offeringVersionRef: "offer-v1",
      fulfillmentProgramRevisionRef: "fulfillment-v1", fulfillmentProgramRevision: 1n,
      fulfillmentProgramDigest: "a".repeat(64), pricingSnapshotRef: overrides.pricingSnapshotRef ?? null,
    }),
  };
}
