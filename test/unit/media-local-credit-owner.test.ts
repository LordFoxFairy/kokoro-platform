import { describe, expect, it, vi } from "vitest";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import { NativeMediaImageCreditOwner } from
  "../../src/process/media-image-local-credit-owner.js";
import type { DerivedMediaChildAllocation } from
  "../../src/modules/credit/application/contracts/run-budget-authority.js";

describe("Media local Credit owner", () => {
  it("maps only owner-frozen facts into the native transactional Credit authority", async () => {
    const deriveChildAllocation = vi.fn(async () =>
      ({ kind: "accepted" as const, value: allocationReceipt() }));
    const owner = new NativeMediaImageCreditOwner({ deriveChildAllocation });
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 1 });
    try {
      await expect(owner.deriveChild(lease.transaction, {
        ownerBinding: { siteRef: "site:one", subjectRef: "subject:one", subjectGeneration: 1n,
          projectRef: "project:one", workloadRef: "workload:one", source: "agent_runtime",
          definitionRevisionRef: "definition:one", modelOptionRevisionRef: "model:one" },
        executionBudgetRootRef: "11111111-1111-4111-8111-111111111111",
        parentAllocationRef: "22222222-2222-4222-8222-222222222222",
        expectedParentRevision: 4n, expectedParentAllocationEpoch: 3n,
        consumptionScope: { surfaceRef: "surface:image", capabilityKey: "image.create", agentRef: "agent:one" },
        expiresAt: "2026-07-31T13:00:00.000Z", mediaOperationRef: "media-operation:one",
        commandRef: "command:one", ownerRequestDigest: "a".repeat(64), exactCeiling: 9n,
      })).resolves.toEqual({ childAllocationRef: "child:one",
        allocationReservationReceiptRef: "receipt:one" });
      expect(deriveChildAllocation).toHaveBeenCalledWith(lease.transaction, expect.objectContaining({
        siteId: "site:one", expectedParentRevision: 4n, expectedParentAllocationEpoch: 3n,
        audience: "media", purpose: "media_operation", businessOperationKey: "command:one",
        requestDigest: "a".repeat(64), exactCeiling: 9n,
      }));
    } finally { revokePlatformTransaction(lease); }
  });

  it("fails closed when the native Credit receipt is not bound to the frozen expiry", async () => {
    const deriveChildAllocation = vi.fn(async () => ({ kind: "accepted" as const,
      value: Object.freeze({ ...allocationReceipt(), expiresAt: "2026-07-31T13:00:01.000Z" }) }));
    const owner = new NativeMediaImageCreditOwner({ deriveChildAllocation });
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 1 });
    try {
      await expect(owner.deriveChild(lease.transaction, childCommand()))
        .rejects.toThrow("MEDIA_CREDIT_CHILD_RECEIPT_INVALID");
    } finally { revokePlatformTransaction(lease); }
  });
});

function childCommand() {
  return Object.freeze({
    ownerBinding: Object.freeze({ siteRef: "site:one", subjectRef: "subject:one", subjectGeneration: 1n,
      projectRef: "project:one", workloadRef: "workload:one", source: "agent_runtime" as const,
      definitionRevisionRef: "definition:one", modelOptionRevisionRef: "model:one" }),
    executionBudgetRootRef: "11111111-1111-4111-8111-111111111111",
    parentAllocationRef: "22222222-2222-4222-8222-222222222222",
    expectedParentRevision: 4n, expectedParentAllocationEpoch: 3n,
    consumptionScope: Object.freeze({ surfaceRef: "surface:image", capabilityKey: "image.create",
      agentRef: "agent:one" }),
    expiresAt: "2026-07-31T13:00:00.000Z", mediaOperationRef: "media-operation:one",
    commandRef: "command:one", ownerRequestDigest: "a".repeat(64), exactCeiling: 9n,
  });
}

function allocationReceipt(): DerivedMediaChildAllocation {
  return Object.freeze({
    allocationReservationReceiptRef: "receipt:one", childAllocationRef: "child:one",
    executionBudgetRootRef: "11111111-1111-4111-8111-111111111111",
    parentAllocationRef: "22222222-2222-4222-8222-222222222222",
    receiptDigest: "b".repeat(64), parentRevisionBefore: 4n, parentRevisionAfter: 5n,
    parentAllocationEpoch: 3n,
    mediaOperationRef: "media-operation:one", reservedCeiling: 9n,
    childRevisionBefore: 0n, childRevisionAfter: 1n, childAllocationEpoch: 1n,
    audience: "media", purpose: "media_operation",
    consumptionScope: Object.freeze({ surfaceRef: "surface:image", capabilityKey: "image.create",
      agentRef: "agent:one" }),
    expiresAt: "2026-07-31T13:00:00.000Z",
    state: "active", observedAt: "2026-07-31T12:00:00.000Z",
  });
}
