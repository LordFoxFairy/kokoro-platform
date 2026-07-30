import { describe, expect, it } from "vitest";
import { UsageSettlementService } from "../../src/modules/credit/application/usage-settlement-service.js";
import type {
  StoredAttemptUsageEvidence,
  StoredUsageSettlementContext,
} from "../../src/modules/credit/application/contracts/usage-settlement-repository.js";
import { issuePlatformTransaction, revokePlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";

describe("UsageSettlementService", () => {
  it("owns the Attempt before Provider I/O and preserves an unknown outcome", async () => {
    const repository = new RecordingUsageRepository();
    const lease = transactionLease();
    try {
      const service = usageService(repository);
      const prepared = await service.prepareAttempt(lease.transaction, {
        siteId: "site-1", authorizationSegmentRef: "segment-1", executionManifestRef: "manifest-1",
        producerKind: "model_gateway", producerContext: "gateway:us-east-1", producerGeneration: 1n,
        attemptRef: "attempt-1", logicalEffectRef: "effect-1",
        maximumDimensions: [
          { dimensionKey: "input_tokens", sourceUnit: "token", quantity: 1_000n },
          { dimensionKey: "output_tokens", sourceUnit: "token", quantity: 4_000n },
        ],
        businessOperationKey: "prepare-attempt:1", requestDigest: "8".repeat(64),
      });
      expect(prepared).toMatchObject({ kind: "accepted", value: { state: "effect_committed", fenceEpoch: 1n } });
      expect(repository.savedAttemptIntent).toMatchObject({ maximumAmount: 22n });
      repository.attemptIntent = repository.savedAttemptIntent;
      await expect(service.markAttemptOutcomeUnknown(lease.transaction, {
        siteId: "site-1", attemptAuthorizationRef: "attempt-authorization-1", expectedFenceEpoch: 1n,
        businessOperationKey: "unknown-attempt:1", requestDigest: "7".repeat(64),
        ownerEvidenceRef: "provider-response:unknown",
      })).resolves.toMatchObject({ kind: "accepted", value: { state: "outcome_unknown", fenceEpoch: 2n } });
    } finally { revokePlatformTransaction(lease); }
  });

  it("ingests immutable canonical evidence with a linear correction chain", async () => {
    const repository = new RecordingUsageRepository();
    const lease = transactionLease();
    try {
      const service = usageService(repository);
      await expect(service.finalizeAttempt(lease.transaction, ingestCommand()))
        .resolves.toMatchObject({ kind: "accepted", value: { evidenceRef: "evidence-1", revision: 1n } });
      repository.latestEvidence = repository.savedEvidence;
      await expect(service.finalizeAttempt(lease.transaction, {
        ...ingestCommand(),
        expectedFenceEpoch: 2n,
        evidenceRef: "evidence-2",
        businessOperationKey: "usage:attempt-1:2",
        requestDigest: "c".repeat(64),
        evidence: {
          ...ingestCommand().evidence,
          revision: 2n,
          correctionOfEvidenceRef: "evidence-1",
          sourceDigest: "d".repeat(64),
        },
      })).resolves.toMatchObject({ kind: "accepted", value: { evidenceRef: "evidence-2", revision: 2n } });
      expect(repository.savedEvidence?.evidence.correctionOfEvidenceRef).toBe("evidence-1");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects a forked or skipped evidence correction before persistence", async () => {
    const repository = new RecordingUsageRepository();
    repository.attemptIntent = { ...attemptIntent(), state: "finalized", fenceEpoch: 3n,
      ownerEvidenceRef: "evidence-existing" };
    repository.latestEvidence = {
      ...persistedEvidence(),
      evidenceRef: "evidence-existing",
      evidence: { ...persistedEvidence().evidence, revision: 2n },
    };
    const lease = transactionLease();
    try {
      await expect(usageService(repository).finalizeAttempt(lease.transaction, {
        ...ingestCommand(),
        expectedFenceEpoch: 3n,
        evidenceRef: "evidence-fork",
        evidence: { ...ingestCommand().evidence, revision: 3n, correctionOfEvidenceRef: "evidence-wrong" },
      })).resolves.toEqual({ kind: "invalid_state", code: "CREDIT_USAGE_CORRECTION_CHAIN_INVALID" });
      expect(repository.savedEvidence).toBeNull();
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rates the exact closed evidence set and captures original HoldAllocation sources once", async () => {
    const repository = new RecordingUsageRepository();
    repository.evidenceSet = [persistedEvidence(), {
      ...persistedEvidence(), evidenceRef: "evidence-2",
      evidence: { ...persistedEvidence().evidence, attemptRef: "attempt-2", sourceDigest: "b".repeat(64) },
    }];
    const lease = transactionLease();
    try {
      const result = await usageService(repository).settleUsageSegment(lease.transaction, settleCommand());
      expect(result).toMatchObject({
        kind: "accepted",
        value: { state: "settled", customerAmount: 14n, platformExposureAmount: 0n, closureRevision: 1n },
      });
      expect(repository.savedSettlement?.sourceMutations).toEqual([
        { creditGrantId: "grant-a", amount: 14n, ordinal: 0, direction: "capture" },
      ]);
      expect(repository.savedSettlement?.allocation).toMatchObject({
        unassignedStock: 86n, committedStock: 0n, capturedCumulative: 14n,
      });
      expect(repository.savedSettlement?.segment).toMatchObject({ state: "settled", aggregateVersion: 4n });
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("keeps unavailable Usage committed under reconciliation instead of settling zero", async () => {
    const repository = new RecordingUsageRepository();
    repository.evidenceSet = [{
      ...persistedEvidence(),
      evidence: {
        ...persistedEvidence().evidence,
        evidenceKind: "unavailable",
        unavailableReason: "provider_usage_missing",
        dimensions: [],
      },
    }];
    const lease = transactionLease();
    try {
      await expect(usageService(repository).settleUsageSegment(lease.transaction, {
        ...settleCommand(), evidenceRefs: ["evidence-1"],
      }))
        .resolves.toMatchObject({ kind: "reconciliation_required" });
      expect(repository.savedReconciliation?.code).toBe("CREDIT_USAGE_UNAVAILABLE");
      expect(repository.savedReconciliation?.segment).toMatchObject({
        state: "reconciliation_required",
        resolutionKind: "outcome_unknown",
      });
      expect(repository.savedSettlement).toBeNull();
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("resolves a reconciliation closure with a later exact evidence revision", async () => {
    const repository = new RecordingUsageRepository();
    repository.evidenceSet = [{
      ...persistedEvidence(),
      evidence: {
        ...persistedEvidence().evidence,
        evidenceKind: "unavailable",
        unavailableReason: "provider_usage_missing",
        dimensions: [],
      },
    }];
    const lease = transactionLease();
    try {
      await expect(usageService(repository).settleUsageSegment(lease.transaction, {
        ...settleCommand(), evidenceRefs: ["evidence-1"],
      })).resolves.toMatchObject({ kind: "reconciliation_required" });

      repository.evidenceSet = [persistedEvidence()];
      await expect(usageService(repository).settleUsageSegment(lease.transaction, {
        ...settleCommand(), closureRef: "closure-2", closureRevision: 2n,
        correctionOfClosureRef: "closure-1", evidenceRefs: ["evidence-1"],
        businessOperationKey: "settle:segment-1:2", requestDigest: "1".repeat(64),
      })).resolves.toMatchObject({
        kind: "accepted",
        value: { closureRevision: 2n, state: "settled", customerAmount: 7n },
      });
      expect(repository.savedSettlement?.segment).toMatchObject({
        state: "settled",
        resolutionKind: "reconciled",
      });
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("refuses closure while any prepared Attempt remains unfinalized", async () => {
    const repository = new RecordingUsageRepository();
    repository.openAttemptCount = 1n;
    const lease = transactionLease();
    try {
      await expect(usageService(repository).settleUsageSegment(lease.transaction, settleCommand()))
        .resolves.toEqual({ kind: "invalid_state", code: "CREDIT_USAGE_ATTEMPTS_NOT_FINALIZED" });
      expect(repository.savedSettlement).toBeNull();
    } finally { revokePlatformTransaction(lease); }
  });

  it("records a correction as a new settlement revision and never overwrites the prior charge", async () => {
    const repository = new RecordingUsageRepository();
    repository.priorSettlement = {
      settlementRef: "settlement-1", closureRef: "closure-1", closureRevision: 1n,
      customerAmount: 20n, platformExposureAmount: 0n,
    };
    repository.priorClosure = { closureRef: "closure-1", closureRevision: 1n };
    repository.holdAllocations = [
      { creditGrantId: "grant-a", ordinal: 0, allocatedAmount: 30n, netCustomerAmount: 20n },
      { creditGrantId: "grant-b", ordinal: 1, allocatedAmount: 70n, netCustomerAmount: 0n },
    ];
    repository.context = { ...usageContext(),
      allocation: { ...usageContext().allocation, revision: 3n, unassignedStock: 80n,
        committedStock: 0n, capturedCumulative: 20n },
      segment: { ...usageContext().segment, state: "settled" } };
    repository.evidenceSet = [persistedEvidence()];
    const lease = transactionLease();
    try {
      const result = await usageService(repository).settleUsageSegment(lease.transaction, {
        ...settleCommand(), closureRef: "closure-2", closureRevision: 2n,
        correctionOfClosureRef: "closure-1", businessOperationKey: "settle:segment-1:2",
        evidenceRefs: ["evidence-1"],
      });
      expect(result).toMatchObject({ kind: "accepted", value: { customerAmount: 7n, closureRevision: 2n } });
      expect(repository.savedSettlement?.priorSettlementRef).toBe("settlement-1");
      expect(repository.savedSettlement?.sourceMutations).toEqual([
        { creditGrantId: "grant-a", amount: 13n, ordinal: 0, direction: "decrease" },
      ]);
      expect(repository.savedSettlement?.allocation).toMatchObject({
        revision: 4n, unassignedStock: 93n, capturedCumulative: 7n,
      });
      expect(repository.savedSettlement?.segment).toBeUndefined();
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});

class RecordingUsageRepository {
  context = usageContext();
  latestEvidence: ReturnType<typeof persistedEvidence> | null = null;
  evidenceSet: ReturnType<typeof persistedEvidence>[] = [persistedEvidence()];
  priorSettlement: { settlementRef: string; closureRef: string; closureRevision: bigint;
    customerAmount: bigint; platformExposureAmount: bigint } | null = null;
  priorClosure: { closureRef: string; closureRevision: bigint } | null = null;
  holdAllocations = [
    { creditGrantId: "grant-a", ordinal: 0, allocatedAmount: 30n, netCustomerAmount: 0n },
    { creditGrantId: "grant-b", ordinal: 1, allocatedAmount: 70n, netCustomerAmount: 0n },
  ];
  savedEvidence: ReturnType<typeof persistedEvidence> | null = null;
  savedSettlement: Record<string, unknown> | null = null;
  savedReconciliation: {
    code: string;
    segment?: StoredUsageSettlementContext["segment"];
  } | null = null;
  receipt: { kind: "none" } = { kind: "none" };
  attemptIntent: Record<string, unknown> | null = attemptIntent();
  savedAttemptIntent: Record<string, unknown> | null = null;
  openAttemptCount = 0n;

  async findCommandReceipt() { return this.receipt; }
  async lockUsageContext() { return this.context; }
  async loadCommittedAttemptMaximum() { return 0n; }
  async lockLatestAttemptEvidence() { return this.latestEvidence; }
  async persistAttemptUsage(_transaction: unknown,
    record: ReturnType<typeof persistedEvidence> & { nextFenceEpoch: bigint }) {
    this.savedEvidence = record;
    this.attemptIntent = { ...this.attemptIntent, state: "finalized", fenceEpoch: record.nextFenceEpoch,
      ownerEvidenceRef: record.evidenceRef };
    return { kind: "accepted" as const, value: { evidenceRef: record.evidenceRef, revision: record.evidence.revision } };
  }
  async persistAttemptIntent(_transaction: unknown, record: Record<string, unknown>) {
    this.savedAttemptIntent = record;
    return { kind: "accepted" as const, value: record.receipt };
  }
  async lockAttemptIntent() { return this.attemptIntent; }
  async updateAttemptIntent(_transaction: unknown, record: Record<string, unknown>) {
    this.savedAttemptIntent = record;
    this.attemptIntent = record;
    return { kind: "accepted" as const, value: record.receipt };
  }
  async loadClosureEvidence() { return this.evidenceSet; }
  async loadOpenAttemptCount() { return this.openAttemptCount; }
  async loadPriorSettlement() { return this.priorSettlement; }
  async loadPriorClosure() { return this.priorClosure; }
  async lockHoldAllocations() { return this.holdAllocations; }
  async persistSettlement(_transaction: unknown, record: Record<string, unknown>) {
    this.savedSettlement = record;
    return { kind: "accepted" as const, value: record.receipt };
  }
  async persistReconciliationRequired(_transaction: unknown, record: {
    code: string;
    closureRef: string;
    closureRevision: bigint;
    segment?: StoredUsageSettlementContext["segment"];
  }) {
    this.savedReconciliation = record;
    this.priorClosure = { closureRef: record.closureRef, closureRevision: record.closureRevision };
    if (record.segment !== undefined) this.context = { ...this.context, segment: record.segment,
      executionBudgetRootState: "reconciliation_required", creditHoldState: "reconciliation_required" };
    return { kind: "reconciliation_required" as const, value: { authorizationSegmentRef: "segment-1", code: record.code } };
  }
}

function usageService(repository: RecordingUsageRepository) {
  let counter = 0;
  return new UsageSettlementService({
    repository: repository as never,
    clock: () => new Date("2026-07-29T00:10:00.000Z"),
    reference: (kind: string) => `${kind}-${++counter}`,
  });
}

function ingestCommand() {
  return {
    attemptAuthorizationRef: "attempt-authorization-1", expectedFenceEpoch: 1n,
    siteId: "site-1", executionBudgetRootRef: "root-1", budgetAllocationRef: "allocation-1",
    creditHoldRef: "hold-1", creditAccountId: "account-1", unit: "credit_micros",
    evidenceRef: "evidence-1", businessOperationKey: "usage:attempt-1:1", requestDigest: "a".repeat(64),
    evidence: {
      producerKind: "model_gateway" as const, producerContext: "gateway:us-east-1", producerGeneration: 1n,
      attemptRef: "attempt-1", logicalEffectRef: "effect-1", authorizationSegmentRef: "segment-1",
      executionManifestRef: "manifest-1", revision: 1n, correctionOfEvidenceRef: null,
      attemptOutcome: "succeeded" as const, occurredAt: "2026-07-29T00:05:00.000Z",
      sourceDigest: "a".repeat(64), evidenceKind: "measured" as const,
      dimensions: [
        { dimensionKey: "input_tokens", sourceUnit: "token", quantity: 1_000n },
        { dimensionKey: "output_tokens", sourceUnit: "token", quantity: 1_000n },
      ],
    },
  } as const;
}

function attemptIntent() {
  return {
    siteId: "site-1", executionBudgetRootRef: "root-1", budgetAllocationRef: "allocation-1",
    authorizationSegmentRef: "segment-1", creditHoldRef: "hold-1", creditAccountId: "account-1",
    unit: "credit_micros", executionManifestRef: "manifest-1",
    attemptAuthorizationRef: "attempt-authorization-1", producerKind: "model_gateway",
    producerContext: "gateway:us-east-1", producerGeneration: 1n, attemptRef: "attempt-1",
    logicalEffectRef: "effect-1", maximumDimensions: [
      { dimensionKey: "input_tokens", sourceUnit: "token", quantity: 1_000n },
      { dimensionKey: "output_tokens", sourceUnit: "token", quantity: 4_000n },
    ], maximumDimensionsDigest: "6".repeat(64), maximumAmount: 25n, provisionalCustomerAmount: null,
    state: "effect_committed", fenceEpoch: 1n, ownerEvidenceRef: null,
  };
}

function settleCommand() {
  return {
    siteId: "site-1", authorizationSegmentRef: "segment-1", executionManifestRef: "manifest-1",
    closureRef: "closure-1", closureRevision: 1n, correctionOfClosureRef: null,
    evidenceRefs: ["evidence-1", "evidence-2"], businessOperationKey: "settle:segment-1:1",
    requestDigest: "f".repeat(64), closureDigest: "e".repeat(64), closedAt: "2026-07-29T00:09:00.000Z",
  } as const;
}

function persistedEvidence(): StoredAttemptUsageEvidence {
  return { ...ingestCommand(), observedAt: "2026-07-29T00:06:00.000Z", evidenceDigest: "9".repeat(64) };
}

function usageContext(): StoredUsageSettlementContext {
  return {
    siteId: "site-1", billingAccountId: "billing-1", creditAccountId: "account-1", unit: "credit_micros",
    liabilityMerchantAccountId: "merchant-1", ratingPolicyRevisionRef: "rating-1",
    executionBudgetRootRef: "root-1", executionBudgetRootState: "open" as const, executionBudgetRootVersion: 1n,
    creditHoldRef: "hold-1", creditHoldState: "open" as const, creditHoldFenceEpoch: 1n,
    budgetAllocationRef: "allocation-1", authorizationSegmentRef: "segment-1",
    executionManifestRef: "manifest-1", expiresAt: "2026-07-29T00:05:00.000Z",
    consumptionScope: { surfaceRef: "chat", capabilityKey: "chat.general", agentRef: null },
    ratingSnapshotRef: null,
    allocation: { revision: 2n, allocationEpoch: 1n, creditCeiling: 100n, unassignedStock: 75n,
      activeChildReservedStock: 0n, committedStock: 25n, capturedCumulative: 0n,
      returnedToParentCumulative: 0n, state: "active" as const },
    segment: { state: "committed" as const, maximumAmount: 25n, allocationEpoch: 1n,
      preparedAgainstAllocationRevision: 1n, committedFromAllocationRevision: 1n,
      committedToAllocationRevision: 2n, aggregateVersion: 2n, fenceEpoch: 2n,
      resolutionKind: null, resolutionRef: null, committedAt: "2026-07-29T00:00:00.000Z",
      settledAt: null, releasedAt: null },
    ratingPolicy: { ratingPolicyRevisionRef: "rating-1", customerUnit: "credit_micros",
      chargeableAttemptOutcomes: ["succeeded" as const], minimumAmount: 0n,
      rules: [
        { dimensionKey: "input_tokens", sourceUnit: "token", quantum: 1_000n, amountPerQuantum: 2n, required: true },
        { dimensionKey: "output_tokens", sourceUnit: "token", quantum: 1_000n, amountPerQuantum: 5n, required: true },
      ] },
  };
}

function transactionLease() { return issuePlatformTransaction({ query: async () => [], execute: async () => 0 }); }
