import { describe, expect, it } from "vitest";
import {
  buildDerivedMediaChildReceipt,
  buildReturnedMediaChildReceipt,
  derivedMediaChildReceiptPayload,
  parseDerivedMediaChildReceipt,
  parseReturnedMediaChildReceipt,
  returnedMediaChildReceiptPayload,
} from "../../src/modules/credit/application/media-child-receipt-codec.js";

describe("Media child receipt codec", () => {
  it("round-trips derive and return receipts through persisted JSON with one canonical digest builder", () => {
    const deriveOperation = { siteId: "site-1", operationKind: "derive_media_child" as const,
      businessOperationKey: "derive:media-1", requestDigest: "b".repeat(64) };
    const derived = buildDerivedMediaChildReceipt({
      allocationReservationReceiptRef: "reservation-1", executionBudgetRootRef: UUID_ROOT,
      parentAllocationRef: UUID_PARENT, parentRevisionBefore: 3n, parentRevisionAfter: 4n,
      parentAllocationEpoch: 2n, childAllocationRef: UUID_CHILD, childRevisionBefore: 0n,
      childRevisionAfter: 1n, childAllocationEpoch: 1n, mediaOperationRef: "media-1",
      reservedCeiling: 30n, audience: "media", purpose: "media_operation",
      consumptionScope: { surfaceRef: "media.image", capabilityKey: "image.text_to_image", agentRef: null },
      expiresAt: "2026-07-29T00:04:00.000Z", state: "active", observedAt: NOW,
    }, deriveOperation);
    expect(parseDerivedMediaChildReceipt(persistedJson(derived), deriveOperation)).toEqual(derived);

    const returnOperation = { siteId: "site-1", operationKind: "return_media_child" as const,
      businessOperationKey: "return:media-1", requestDigest: "d".repeat(64) };
    const returned = buildReturnedMediaChildReceipt({
      allocationReturnReceiptRef: "return-1", executionBudgetRootRef: UUID_ROOT,
      parentAllocationRef: UUID_PARENT, childAllocationRef: UUID_CHILD,
      parentRevisionBefore: 4n, parentRevisionAfter: 5n, parentAllocationEpoch: 2n,
      childRevisionBefore: 2n, childRevisionAfter: 3n, childAllocationEpochBefore: 1n,
      childAllocationEpochAfter: 2n, mediaOperationRef: "media-1", returnedAmount: 20n,
      capturedAmount: 10n, reason: "completed", rootStateAtReturn: "open",
      ownerClosureEvidence: { kind: "media_operation_terminal", mediaOperationRef: "media-1",
        terminalReceiptRef: "terminal-1", outcome: "completed" }, state: "terminal", observedAt: NOW,
    }, returnOperation);
    expect(parseReturnedMediaChildReceipt(persistedJson(returned), returnOperation)).toEqual(returned);
  });

  it("binds internal command identity without leaking it into returned public fields", () => {
    const operation = { siteId: "site-1", operationKind: "derive_media_child" as const,
      businessOperationKey: "derive:media-1", requestDigest: "b".repeat(64) };
    const core = {
      allocationReservationReceiptRef: "reservation-1", executionBudgetRootRef: UUID_ROOT,
      parentAllocationRef: UUID_PARENT, parentRevisionBefore: 3n, parentRevisionAfter: 4n,
      parentAllocationEpoch: 2n, childAllocationRef: UUID_CHILD, childRevisionBefore: 0n as const,
      childRevisionAfter: 1n as const, childAllocationEpoch: 1n as const, mediaOperationRef: "media-1",
      reservedCeiling: 30n, audience: "media" as const, purpose: "media_operation" as const,
      consumptionScope: { surfaceRef: "media.image", capabilityKey: "image.text_to_image", agentRef: null },
      expiresAt: "2026-07-29T00:04:00.000Z", state: "active" as const, observedAt: NOW,
    };
    const receipt = buildDerivedMediaChildReceipt(core, operation);
    expect(receipt).not.toHaveProperty("siteId");
    expect(receipt).not.toHaveProperty("businessOperationKey");
    expect(derivedMediaChildReceiptPayload(core, operation)).toMatchObject({ operation });
    expect(returnedMediaChildReceiptPayload).toBeTypeOf("function");
    expect(() => parseDerivedMediaChildReceipt(persistedJson(receipt), {
      ...operation, businessOperationKey: "derive:other",
    })).toThrow("CREDIT_OPERATION_RECEIPT_CORRUPT");
  });
});

function persistedJson<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_key, entry: unknown) => typeof entry === "bigint" ? entry.toString() : entry));
}

const NOW = "2026-07-29T00:00:00.000Z";
const UUID_ROOT = "00000000-0000-7000-8000-000000000202";
const UUID_PARENT = "00000000-0000-7000-8000-000000000203";
const UUID_CHILD = "00000000-0000-7000-8000-000000000301";
