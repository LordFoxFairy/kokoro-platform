import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { NativeMediaImageCreditSettlementOwner, type CreditMediaFinalizationTransactionHost } from
  "../../src/process/media-image-credit-settlement-owner.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";

describe("NativeMediaImageCreditSettlementOwner", () => {
  it("authorizes typed usage with the exact worker lease and delegates only Credit-owned facts", async () => {
    const typedUsage = { loadCertified: vi.fn(async () => ({ kind: "available" as const,
      attemptRef: "attempt:one", attemptAuthorizationRef: "00000000-0000-7000-8000-000000000801",
      attemptAuthorizationFenceEpoch: 1n, attemptAuthorizationDigest: "a".repeat(64),
      authorizationSegmentRef: "00000000-0000-7000-8000-000000000013",
      executionManifestRef: "manifest:one", producerKind: "model_gateway" as const,
      producerContext: "model-gateway:image", producerGeneration: 1n, logicalEffectRef: "logical:one",
      fact: { evidenceKind: "measured" as const,
        dimensions: [{ dimensionKey: "image", sourceUnit: "output", quantity: 1n }],
        attemptOutcome: "succeeded" as const, occurredAt: "2026-07-31T12:00:00.000Z",
        sourceDigest: "c".repeat(64) } })) };
    const finalizer = { finalize: vi.fn(async () => ({ kind: "settled" as const,
      financialReceiptRef: "financial:one", allocationClosureReceiptRef: "allocation:one",
      usageSettlementReceiptRef: "usage-settlement:one", actualCost: "40", refundedCredit: "60",
      unit: "credit" })) };
    const transactionHost = host();
    const leaseAuthority = { assertOwned: vi.fn(async () => undefined) };
    const owner = new NativeMediaImageCreditSettlementOwner({ typedUsage, finalizer, leaseAuthority,
      transactionHost: transactionHost as unknown as CreditMediaFinalizationTransactionHost });

    await expect(owner.finalizeBudget(command())).resolves.toMatchObject({ kind: "settled" });
    expect(typedUsage.loadCertified).toHaveBeenCalledWith({ taskRef: "task:one", operationRef: "media:one",
      leaseEpoch: 3n, leaseTokenHash: createHash("sha256").update("lease:secret").digest("hex"),
      modelInvocationCommandRef: "model-command:one", logicalInvocationRef: "logical:one",
      usageEvidenceRef: "usage:one", usageEvidenceDigest: "b".repeat(64) });
    expect(transactionHost.execute).toHaveBeenCalledWith({ siteId: "site:one",
      operation: "credit.media-image.finalize" }, expect.any(Function));
    expect(finalizer.finalize).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      siteId: "site:one", operationRef: "media:one", attempt: expect.objectContaining({
        attemptAuthorizationRef: "00000000-0000-7000-8000-000000000801",
        usageEvidenceRef: "usage:one", logicalEffectRef: "logical:one",
      }),
    }));
  });

  it("returns reconciliation when the definer lookup cannot prove one exact fact", async () => {
    const typedUsage = { loadCertified: vi.fn(async () => ({ kind: "reconciliation_required" as const,
      code: "TYPED_USAGE_FACT_AMBIGUOUS" as const })) };
    const finalizer = { finalize: vi.fn() };
    const transactionHost = host();
    const owner = new NativeMediaImageCreditSettlementOwner({ typedUsage, finalizer,
      leaseAuthority: { assertOwned: vi.fn(async () => undefined) },
      transactionHost: transactionHost as unknown as CreditMediaFinalizationTransactionHost });
    await expect(owner.finalizeBudget(command())).resolves.toEqual({ kind: "reconciliation_required",
      reconciliationReceiptRef: "usage-receipt:one", code: "TYPED_USAGE_FACT_AMBIGUOUS" });
    expect(transactionHost.execute).not.toHaveBeenCalled();
    expect(finalizer.finalize).not.toHaveBeenCalled();
  });
});

function host() {
  return { execute: vi.fn(async (_fence: unknown, work: (transaction: unknown) => Promise<unknown>) => {
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 1 });
    try { return await work(lease.transaction); } finally { revokePlatformTransaction(lease); }
  }) };
}

function command() {
  return { siteId: "site:one", taskRef: "task:one", leaseEpoch: 3n, leaseToken: "lease:secret",
    operationRef: "media:one", modelInvocationCommandRef: "model-command:one",
    logicalInvocationRef: "logical:one", effectClosureReceiptRef: "effect-closure:one",
    outcome: "completed" as const,
    budget: { kind: "agent_child" as const,
      executionBudgetRootRef: "00000000-0000-7000-8000-000000000010",
      executionManifestRef: "manifest:one", parentAllocationRef: "00000000-0000-7000-8000-000000000011",
      childAllocationRef: "00000000-0000-7000-8000-000000000012",
      allocationReservationReceiptRef: "00000000-0000-7000-8000-000000000014",
      authorizationSegmentRef: "00000000-0000-7000-8000-000000000013",
      authorizationSegmentVersion: 2n, reservedCeiling: 100n, unit: "credit" },
    usage: { attemptUsageEvidenceReceiptRef: "usage-receipt:one",
      canonicalOutcomeEvidence: { ref: "outcome:one", digest: "d".repeat(64) },
      usageEvidence: { ref: "usage:one", digest: "b".repeat(64) },
      effectBudgetCommitRef: "budget-commit:one" },
  };
}
