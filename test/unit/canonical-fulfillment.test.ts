import { describe, expect, it } from "vitest";
import {
  canonicalFulfillmentTransaction,
  fulfillmentOutputDigest,
} from "../../src/modules/commerce/domain/canonical-fulfillment.js";

describe("canonical fulfillment transaction", () => {
  it("sorts committed outputs and binds every owner field into one canonical digest", () => {
    const outputA = output("line-a", 1, 1, "grant-a");
    const outputB = output("line-b", 2, 1, "grant-b");
    const committed = canonicalFulfillmentTransaction({
      platformTransactionRef: "transaction-1",
      siteRef: "site-1",
      acquisition: {
        sourceKind: "redemption",
        sourceRef: "redemption-1",
        sourceVersion: 1n,
        sourceDigest: "a".repeat(64),
        acquiredAt: "2026-07-30T02:00:00.000Z",
      },
      program: {
        fulfillmentProgramRevisionRef: "program-v1",
        fulfillmentProgramRevision: 1n,
        fulfillmentProgramDigest: "b".repeat(64),
      },
      outputs: [outputB, outputA],
      committedAt: "2026-07-30T02:00:01.000Z",
    });
    expect(committed.outputs.map((item) => item.outputRef)).toEqual(["grant-a", "grant-b"]);
    expect(committed.transactionVersion).toBe(1);
    expect(committed.transactionDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(committed.transactionDigest).toBe(
      "a7b182d18a85a0a7bd4ae8678157a547a462dafa4a898ec935908e8d56e56f79",
    );
    expect(canonicalFulfillmentTransaction({
      ...committed,
      acquisition: { ...committed.acquisition, sourceDigest: "c".repeat(64) },
    }).transactionDigest).not.toBe(committed.transactionDigest);
  });

  it("rejects owner output digest drift before a fulfillment can be committed", () => {
    const actual = output("credits", 1, 1, "grant-1");
    expect(fulfillmentOutputDigest(actual)).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => canonicalFulfillmentTransaction({
      platformTransactionRef: "transaction-1",
      siteRef: "site-1",
      acquisition: { sourceKind: "redemption", sourceRef: "redemption-1", sourceVersion: 1n,
        sourceDigest: "a".repeat(64), acquiredAt: "2026-07-30T02:00:00.000Z" },
      program: { fulfillmentProgramRevisionRef: "program-v1", fulfillmentProgramRevision: 1n,
        fulfillmentProgramDigest: "b".repeat(64) },
      outputs: [{ ...actual, outputDigest: "f".repeat(64) }],
      committedAt: "2026-07-30T02:00:01.000Z",
    })).toThrow("FULFILLMENT_OUTPUT_DIGEST_MISMATCH");
  });
});

function output(outputLineId: string, outputOrdinal: number, occurrence: number, outputRef: string) {
  const base = { kind: "credit_grant" as const, outputLineId, outputOrdinal, occurrence, outputRef,
    templateRevisionRef: "credit-program-v1", outputVersion: 1 as const };
  return Object.freeze({ ...base, outputDigest: fulfillmentOutputDigest(base) });
}
