import { describe, expect, it, vi } from "vitest";
import { CreditMediaBudgetFinalizationService } from
  "../../src/modules/credit/application/media-budget-finalization-service.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import type { PlatformTransaction } from "../../src/shared/unit-of-work/index.js";

const NOW = "2026-07-31T12:00:00.000Z";

describe("CreditMediaBudgetFinalizationService", () => {
  it("finalizes the exact pre-authorized attempt, settles its child segment, then returns the child", async () => {
    const usage = usageOwner();
    const repository = { lockMediaChildAllocation: vi.fn(async () => childHead()) };
    const runBudget = { returnChildAllocation: vi.fn(async () => ({ kind: "accepted" as const, value: {
      allocationReturnReceiptRef: "allocation-return:one", returnedAmount: 60n, capturedAmount: 40n,
    } })) };
    const service = new CreditMediaBudgetFinalizationService({ usage, repository: repository as never,
      runBudget: runBudget as never,
      directRoot: directCloser(), clock: () => new Date(NOW), reference: references() });
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 1 });
    try {
      await expect(service.finalize(lease.transaction, childCommand())).resolves.toEqual({
        kind: "settled", financialReceiptRef: "allocation-return:one",
        allocationClosureReceiptRef: "allocation-return:one",
        usageSettlementReceiptRef: "00000000-0000-7000-8000-000000000902",
        actualCost: "40", releasedCredit: "60", unit: "credit",
      });
      expect(usage.finalizeAttempt).toHaveBeenCalledWith(lease.transaction, expect.objectContaining({
        siteId: "site:one", attemptAuthorizationRef: "00000000-0000-7000-8000-000000000801",
        expectedFenceEpoch: 1n, evidence: expect.objectContaining({
          authorizationSegmentRef: "00000000-0000-7000-8000-000000000013",
          executionManifestRef: "manifest:one", producerKind: "model_gateway",
          attemptRef: "attempt:one", logicalEffectRef: "logical:one", revision: 1n,
        }),
      }));
      expect(usage.settleUsageSegment).toHaveBeenCalledWith(lease.transaction, expect.objectContaining({
        evidenceRefs: ["00000000-0000-7000-8000-000000000901"], closureRevision: 1n,
      }));
      expect(repository.lockMediaChildAllocation).toHaveBeenCalledWith(lease.transaction, {
        siteId: "site:one", executionBudgetRootRef: "00000000-0000-7000-8000-000000000010",
        parentAllocationRef: "00000000-0000-7000-8000-000000000011",
        childAllocationRef: "00000000-0000-7000-8000-000000000012",
      });
      expect(runBudget.returnChildAllocation).toHaveBeenCalledWith(lease.transaction, expect.objectContaining({
        expectedParentRevision: 4n, expectedParentAllocationEpoch: 1n,
        expectedChildRevision: 3n, expectedChildAllocationEpoch: 1n,
        ownerClosureEvidence: { kind: "media_operation_terminal", mediaOperationRef: "media:one",
          terminalReceiptRef: "effect-closure:one", outcome: "completed" },
      }));
    } finally { revokePlatformTransaction(lease); }
  });

  it("keeps unavailable typed usage under reconciliation and never closes an allocation as zero", async () => {
    const usage = usageOwner();
    usage.settleUsageSegment.mockResolvedValueOnce({ kind: "reconciliation_required" as const,
      value: { authorizationSegmentRef: "00000000-0000-7000-8000-000000000013",
        code: "CREDIT_USAGE_UNAVAILABLE" } } as never);
    const repository = { lockMediaChildAllocation: vi.fn(async () => childHead()) };
    const runBudget = { returnChildAllocation: vi.fn() };
    const service = new CreditMediaBudgetFinalizationService({ usage, repository: repository as never,
      runBudget: runBudget as never,
      directRoot: directCloser(), clock: () => new Date(NOW), reference: references() });
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 1 });
    try {
      await expect(service.finalize(lease.transaction, childCommand({ evidenceKind: "unavailable",
        dimensions: [], unavailableReason: "provider_usage_missing" }))).resolves.toEqual({
        kind: "reconciliation_required", reconciliationReceiptRef: "00000000-0000-7000-8000-000000000903",
        code: "CREDIT_USAGE_UNAVAILABLE",
      });
      expect(repository.lockMediaChildAllocation).not.toHaveBeenCalled();
      expect(runBudget.returnChildAllocation).not.toHaveBeenCalled();
    } finally { revokePlatformTransaction(lease); }
  });

  it("settles a canceled-before-effect segment with an empty evidence set and delegates root closure", async () => {
    const usage = usageOwner();
    usage.settleUsageSegment.mockImplementationOnce(async (_transaction,
      input: Readonly<Record<string, unknown>>) => ({ kind: "accepted" as const, value: {
      settlementRef: "00000000-0000-7000-8000-000000000902",
      authorizationSegmentRef: "00000000-0000-7000-8000-000000000013",
      closureRef: String(input.closureRef), closureRevision: 1n, state: "settled" as const,
      customerAmount: 0n, platformExposureAmount: 0n,
    } }));
    const directRoot = directCloser();
    const service = new CreditMediaBudgetFinalizationService({ usage,
      repository: { lockMediaChildAllocation: vi.fn() } as never,
      runBudget: { returnChildAllocation: vi.fn() } as never,
      directRoot, clock: () => new Date(NOW), reference: references() });
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 1 });
    try {
      const command = childCommand();
      await expect(service.finalize(lease.transaction, { ...command, budget: {
        kind: "direct_root", executionBudgetRootRef: command.budget.executionBudgetRootRef,
        executionManifestRef: command.budget.executionManifestRef,
        rootHoldRef: "00000000-0000-7000-8000-000000000020",
        rootAllocationRef: "00000000-0000-7000-8000-000000000021", rootAllocationRevision: 1n,
        rootAllocationEpoch: 1n, authorizationSegmentRef: command.budget.authorizationSegmentRef,
        authorizationSegmentVersion: 2n, reservedCeiling: 100n, unit: "credit",
      }, outcome: "canceled", attempt: undefined })).resolves.toMatchObject({
        kind: "settled", actualCost: "0", releasedCredit: "100",
      });
      expect(usage.finalizeAttempt).not.toHaveBeenCalled();
      expect(usage.settleUsageSegment).toHaveBeenCalledWith(lease.transaction,
        expect.objectContaining({ evidenceRefs: [] }));
      expect(directRoot.close).toHaveBeenCalledOnce();
    } finally { revokePlatformTransaction(lease); }
  });

  it("derives stable evidence and closure identities so a crash retry replays the same Credit commands", async () => {
    const usage = {
      finalizeAttempt: vi.fn(async (_transaction: PlatformTransaction,
        input: Readonly<{ evidenceRef: string; requestDigest: string }>) => ({ kind: "replayed" as const,
        value: { evidenceRef: input.evidenceRef, revision: 1n } })),
      settleUsageSegment: vi.fn(async (_transaction: PlatformTransaction,
        input: Readonly<{ closureRef: string; requestDigest: string; evidenceRefs: readonly string[] }>) => ({
        kind: "replayed" as const, value: {
        settlementRef: "00000000-0000-7000-8000-000000000902",
        authorizationSegmentRef: "00000000-0000-7000-8000-000000000013",
        closureRef: input.closureRef, closureRevision: 1n, state: "settled" as const,
        customerAmount: 40n, platformExposureAmount: 0n,
      } })),
    };
    const repository = { lockMediaChildAllocation: vi.fn(async () => childHead()) };
    const runBudget = { returnChildAllocation: vi.fn(async () => ({ kind: "replayed" as const, value: {
      allocationReturnReceiptRef: "allocation-return:one", returnedAmount: 60n, capturedAmount: 40n,
    } })) };
    const service = new CreditMediaBudgetFinalizationService({ usage: usage as never, repository: repository as never,
      runBudget: runBudget as never, directRoot: directCloser(), clock: () => new Date(NOW) });
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 1 });
    try {
      await service.finalize(lease.transaction, childCommand());
      await service.finalize(lease.transaction, childCommand());
      const attempts = usage.finalizeAttempt.mock.calls.map((call) => call[1]);
      const closures = usage.settleUsageSegment.mock.calls.map((call) => call[1]);
      expect(attempts[0]?.evidenceRef).toMatch(/^[a-f0-9-]{36}$/u);
      expect(attempts[1]?.evidenceRef).toBe(attempts[0]?.evidenceRef);
      expect(attempts[1]?.requestDigest).toBe(attempts[0]?.requestDigest);
      expect(closures[1]?.closureRef).toBe(closures[0]?.closureRef);
      expect(closures[1]?.requestDigest).toBe(closures[0]?.requestDigest);
      expect(closures[1]?.evidenceRefs).toEqual(closures[0]?.evidenceRefs);
    } finally { revokePlatformTransaction(lease); }
  });
});

function usageOwner() {
  return {
    finalizeAttempt: vi.fn(async () => ({ kind: "accepted" as const,
      value: { evidenceRef: "00000000-0000-7000-8000-000000000901", revision: 1n } })),
    settleUsageSegment: vi.fn(async (_transaction, input: Readonly<Record<string, unknown>>) => ({
      kind: "accepted" as const, value: {
      settlementRef: "00000000-0000-7000-8000-000000000902",
      authorizationSegmentRef: "00000000-0000-7000-8000-000000000013",
      closureRef: String(input.closureRef), closureRevision: 1n,
      state: "settled" as const, customerAmount: 40n, platformExposureAmount: 0n,
    } })),
  };
}

function directCloser() {
  return { close: vi.fn(async (_transaction, input: Readonly<{ settlement: { customerAmount: bigint } }>) => ({
    kind: "accepted" as const, value: { allocationClosureReceiptRef: "direct-close:one",
      capturedAmount: input.settlement.customerAmount, releasedAmount: 100n - input.settlement.customerAmount },
  })) };
}

function references() {
  const values = [
    "00000000-0000-7000-8000-000000000901", "00000000-0000-7000-8000-000000000903",
    "00000000-0000-7000-8000-000000000904", "00000000-0000-7000-8000-000000000905",
  ];
  return () => values.shift() ?? "00000000-0000-7000-8000-000000000999";
}

function childCommand(fact: Record<string, unknown> = {}) {
  return {
    siteId: "site:one", operationRef: "media:one", effectClosureReceiptRef: "effect-closure:one",
    outcome: "completed" as const,
    budget: { kind: "agent_child" as const,
      executionBudgetRootRef: "00000000-0000-7000-8000-000000000010",
      executionManifestRef: "manifest:one", parentAllocationRef: "00000000-0000-7000-8000-000000000011",
      childAllocationRef: "00000000-0000-7000-8000-000000000012",
      allocationReservationReceiptRef: "00000000-0000-7000-8000-000000000014",
      authorizationSegmentRef: "00000000-0000-7000-8000-000000000013",
      authorizationSegmentVersion: 2n, reservedCeiling: 100n, unit: "credit" },
    attempt: { attemptAuthorizationRef: "00000000-0000-7000-8000-000000000801",
      attemptAuthorizationFenceEpoch: 1n, attemptAuthorizationDigest: "a".repeat(64),
      usageEvidenceRef: "gateway-usage:one", usageEvidenceDigest: "b".repeat(64),
      producerKind: "model_gateway" as const, producerContext: "model-gateway:image",
      producerGeneration: 1n, attemptRef: "attempt:one", logicalEffectRef: "logical:one",
      fact: { evidenceKind: "measured" as const,
        dimensions: [{ dimensionKey: "image", sourceUnit: "output", quantity: 1n }],
        attemptOutcome: "succeeded" as const, occurredAt: NOW, sourceDigest: "c".repeat(64), ...fact } },
  };
}

function childHead() {
  return { parentAllocation: { revision: 4n, allocationEpoch: 1n },
    childAllocation: { revision: 3n, allocationEpoch: 1n } };
}
