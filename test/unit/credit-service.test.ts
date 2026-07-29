import { describe, expect, it } from "vitest";
import { CreditService } from "../../src/modules/credit/application/credit-service.js";
import type {
  CreditAuthorityRepository,
  RootBudgetReservationRecord,
  StoredSegmentAllocation,
} from "../../src/modules/credit/application/contracts/credit-authority-repository.js";
import { issuePlatformTransaction, revokePlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";

describe("CreditService", () => {
  it("plans an exact root reservation before asking the repository to persist authority facts", async () => {
    const repository = new RecordingCreditRepository();
    repository.grants = [
      { creditGrantId: "grant-late", availableAmount: 70n, expiresAt: null, burnPriority: 10, issuedAt: "2026-01-01T00:00:00.000Z" },
      { creditGrantId: "grant-first", availableAmount: 40n, expiresAt: "2026-08-01T00:00:00.000Z", burnPriority: 10, issuedAt: "2026-01-01T00:00:00.000Z" },
    ];
    const service = creditService(repository);
    const lease = transactionLease();
    try {
      const result = await service.reserveRootBudget(lease.transaction, reserveInput());

      expect(result).toMatchObject({ kind: "accepted", value: { state: "reserved" } });
      expect(repository.reservation?.allocations).toEqual([
        { creditGrantId: "grant-first", amount: 40n, ordinal: 0 },
        { creditGrantId: "grant-late", amount: 20n, ordinal: 1 },
      ]);
      expect(repository.reservation?.rootCeiling).toBe(60n);
      expect(repository.reservation?.segmentMaximum).toBe(25n);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("does not persist a partial Hold when full reservation is unavailable", async () => {
    const repository = new RecordingCreditRepository();
    repository.grants = [
      { creditGrantId: "grant", availableAmount: 59n, expiresAt: null, burnPriority: 10, issuedAt: "2026-01-01T00:00:00.000Z" },
    ];
    const lease = transactionLease();
    try {
      await expect(creditService(repository).reserveRootBudget(lease.transaction, reserveInput()))
        .resolves.toEqual({ kind: "insufficient_credit" });
      expect(repository.reservation).toBeNull();
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("commits a reserved Segment with exact stock movement and expected-version fencing", async () => {
    const repository = new RecordingCreditRepository();
    repository.loaded = storedSegment();
    const lease = transactionLease();
    try {
      const result = await creditService(repository).finalizeAuthorizationSegment(lease.transaction, {
        siteId: "site-1",
        authorizationSegmentRef: "segment-1",
        executionManifestRef: "manifest-1",
        expectedSegmentVersion: 1n,
        businessOperationKey: "finalize:segment-1",
        requestDigest: "b".repeat(64),
      });

      expect(result).toMatchObject({ kind: "accepted", value: { state: "committed", segmentVersion: 2n } });
      expect(repository.saved?.allocation).toMatchObject({ revision: 2n, unassignedStock: 75n, committedStock: 25n });
      expect(repository.saved?.segment).toMatchObject({ state: "committed", aggregateVersion: 2n });
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("marks a committed unknown outcome for reconciliation and never releases it", async () => {
    const repository = new RecordingCreditRepository();
    repository.loaded = storedSegment("committed");
    const lease = transactionLease();
    try {
      const service = creditService(repository);
      await expect(service.releaseAuthorizationSegment(lease.transaction, {
        siteId: "site-1",
        authorizationSegmentRef: "segment-1",
        executionManifestRef: "manifest-1",
        expectedSegmentVersion: 2n,
        businessOperationKey: "release:segment-1",
        requestDigest: "c".repeat(64),
        noDispatchEvidenceRef: "evidence:no-dispatch",
      })).resolves.toMatchObject({ kind: "invalid_state", code: "CREDIT_SEGMENT_NOT_RELEASABLE" });

      const result = await service.reconcileAuthorizationSegment(lease.transaction, {
        siteId: "site-1",
        authorizationSegmentRef: "segment-1",
        executionManifestRef: "manifest-1",
        expectedSegmentVersion: 2n,
        businessOperationKey: "reconcile:segment-1",
        requestDigest: "d".repeat(64),
        ownerEvidence: { kind: "outcome_unknown", evidenceRef: "evidence:unknown" },
      });
      expect(result).toMatchObject({ kind: "reconciliation_required", value: { state: "reconciliation_required", segmentVersion: 3n } });
      expect(repository.saved?.segment.state).toBe("reconciliation_required");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("replays the same operation before locking mutable balance facts", async () => {
    const repository = new RecordingCreditRepository();
    repository.operation = {
      kind: "replayed",
      value: { executionBudgetRootRef: "root-existing", creditHoldRef: "hold-existing",
        authorizationSegmentRef: "segment-existing", segmentVersion: 1n, state: "reserved",
        expiresAt: "2026-07-29T00:05:00.000Z" },
    };
    const lease = transactionLease();
    try {
      const result = await creditService(repository).reserveRootBudget(lease.transaction, reserveInput());
      expect(result).toEqual(repository.operation);
      expect(repository.grantLockCount).toBe(0);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("types an idempotency-key digest mismatch as conflict", async () => {
    const repository = new RecordingCreditRepository();
    repository.operation = { kind: "conflict", code: "REQUEST_DIGEST_CONFLICT" };
    const lease = transactionLease();
    try {
      await expect(creditService(repository).reserveRootBudget(lease.transaction, reserveInput()))
        .resolves.toEqual({ kind: "conflict", code: "REQUEST_DIGEST_CONFLICT" });
      expect(repository.grantLockCount).toBe(0);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("replays a Segment mutation before taking its aggregate lock", async () => {
    const repository = new RecordingCreditRepository();
    repository.operation = { kind: "replayed", value: {
      authorizationSegmentRef: "segment-1", segmentVersion: 2n, state: "committed",
      observedAt: "2026-07-29T00:00:00.000Z",
    } };
    const lease = transactionLease();
    try {
      await expect(creditService(repository).finalizeAuthorizationSegment(lease.transaction, segmentCommand()))
        .resolves.toEqual(repository.operation);
      expect(repository.segmentLockCount).toBe(0);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("types missing and stale Segments without attempting a write", async () => {
    const repository = new RecordingCreditRepository();
    const lease = transactionLease();
    try {
      await expect(creditService(repository).finalizeAuthorizationSegment(lease.transaction, segmentCommand()))
        .resolves.toEqual({ kind: "not_found" });
      repository.loaded = storedSegment();
      await expect(creditService(repository).finalizeAuthorizationSegment(lease.transaction, {
        ...segmentCommand(), businessOperationKey: "finalize:stale", expectedSegmentVersion: 9n,
      })).resolves.toEqual({ kind: "conflict", code: "VERSION_CONFLICT" });
      expect(repository.saved).toBeNull();
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("refuses new commitment after the Root or Hold has been fenced", async () => {
    const repository = new RecordingCreditRepository();
    repository.loaded = { ...storedSegment(), executionBudgetRootState: "reconciliation_required" };
    const lease = transactionLease();
    try {
      await expect(creditService(repository).finalizeAuthorizationSegment(lease.transaction, segmentCommand()))
        .resolves.toEqual({ kind: "invalid_state", code: "CREDIT_AUTHORIZATION_ROOT_NOT_OPEN" });
      expect(repository.saved).toBeNull();
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("uses CSPRNG UUID references by default", async () => {
    const repository = new RecordingCreditRepository();
    repository.grants = [{ creditGrantId: "grant", availableAmount: 60n, expiresAt: null,
      burnPriority: 10, issuedAt: "2026-01-01T00:00:00.000Z" }];
    const lease = transactionLease();
    try {
      await new CreditService({ repository, clock: () => new Date("2026-07-29T00:00:00.000Z") })
        .reserveRootBudget(lease.transaction, reserveInput());
      expect(repository.reservation?.creditHoldRef).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
      expect(new Set([
        repository.reservation?.creditHoldRef, repository.reservation?.executionBudgetRootRef,
        repository.reservation?.rootAllocationRef, repository.reservation?.initialAllocationRevisionRef,
        repository.reservation?.authorizationSegmentRef, repository.reservation?.reserveJournalTransactionRef,
        repository.reservation?.operationReceiptRef, repository.reservation?.outboxEventRef,
      ]).size).toBe(8);
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});

class RecordingCreditRepository implements CreditAuthorityRepository {
  grants: Awaited<ReturnType<CreditAuthorityRepository["lockGrantAvailability"]>> = [];
  reservation: RootBudgetReservationRecord | null = null;
  loaded: StoredSegmentAllocation | null = null;
  saved: StoredSegmentAllocation | null = null;
  operation: Awaited<ReturnType<CreditAuthorityRepository["findOperationReceipt"]>> = { kind: "none" };
  grantLockCount = 0;
  segmentLockCount = 0;

  async findOperationReceipt(): Promise<typeof this.operation> { return this.operation; }
  async lockGrantAvailability(): Promise<typeof this.grants> { this.grantLockCount += 1; return this.grants; }
  async createRootBudgetReservation(_transaction: never, record: RootBudgetReservationRecord) {
    this.reservation = record;
    return { kind: "accepted" as const, value: { executionBudgetRootRef: record.executionBudgetRootRef, creditHoldRef: record.creditHoldRef,
      authorizationSegmentRef: record.authorizationSegmentRef, segmentVersion: 1n, state: "reserved" as const,
      expiresAt: record.expiresAt } };
  }
  async lockSegmentAllocation(): Promise<StoredSegmentAllocation | null> { this.segmentLockCount += 1; return this.loaded; }
  async commitAuthorizationSegment(_transaction: never, record: StoredSegmentAllocation) {
    this.saved = record;
    this.loaded = record;
    return { kind: "accepted" as const, value: segmentResult(record) };
  }
  async releaseAuthorizationSegment(_transaction: never, record: StoredSegmentAllocation) {
    this.saved = record;
    this.loaded = record;
    return { kind: "accepted" as const, value: segmentResult(record) };
  }
  async markAuthorizationSegmentReconciliationRequired(_transaction: never, record: StoredSegmentAllocation) {
    this.saved = record;
    this.loaded = record;
    return { kind: "reconciliation_required" as const, value: segmentResult(record) };
  }
}

function segmentResult(record: StoredSegmentAllocation) {
  return { authorizationSegmentRef: record.authorizationSegmentRef,
    segmentVersion: record.segment.aggregateVersion, state: record.segment.state as "committed" | "released" | "reconciliation_required",
    observedAt: "2026-07-29T00:00:00.000Z" };
}

function creditService(repository: CreditAuthorityRepository): CreditService {
  let counter = 0;
  return new CreditService({
    repository,
    clock: () => new Date("2026-07-29T00:00:00.000Z"),
    reference: (kind) => `${kind}-${++counter}`,
  });
}

function reserveInput() {
  return {
    siteId: "site-1", billingAccountId: "billing-1", creditAccountId: "00000000-0000-7000-8000-000000000001",
    unit: "credit_micros", liabilityMerchantAccountId: "merchant-1", executionRootId: "run-1",
    authorizationBudgetRef: "budget-policy-1", ratingPolicyRevisionRef: "rating-1",
    executionManifestRef: "manifest-1", businessOperationKey: "prepare:launch-1", requestDigest: "a".repeat(64),
    rootCeiling: 60n, segmentMaximum: 25n, expiresAt: "2026-07-29T00:05:00.000Z",
  } as const;
}

function segmentCommand() {
  return { siteId: "site-1", authorizationSegmentRef: "segment-1", executionManifestRef: "manifest-1",
    expectedSegmentVersion: 1n, businessOperationKey: "finalize:segment-1",
    requestDigest: "b".repeat(64) } as const;
}

function storedSegment(state: "reserved" | "committed" = "reserved"): StoredSegmentAllocation {
  const committed = state === "committed";
  return {
    siteId: "site-1", billingAccountId: "billing-1", creditAccountId: "00000000-0000-7000-8000-000000000001",
    unit: "credit_micros", liabilityMerchantAccountId: "merchant-1", ratingPolicyRevisionRef: "rating-1",
    executionBudgetRootRef: "root-1", executionBudgetRootState: "open", executionBudgetRootVersion: 1n,
    creditHoldRef: "hold-1", creditHoldState: "open", creditHoldFenceEpoch: 1n,
    budgetAllocationRef: "allocation-1", authorizationSegmentRef: "segment-1",
    executionManifestRef: "manifest-1",
    allocation: { revision: committed ? 2n : 1n, allocationEpoch: 1n, creditCeiling: 100n,
      unassignedStock: committed ? 75n : 100n, activeChildReservedStock: 0n,
      committedStock: committed ? 25n : 0n, capturedCumulative: 0n,
      returnedToParentCumulative: 0n, state: "active" },
    segment: { state, maximumAmount: 25n, allocationEpoch: 1n, preparedAgainstAllocationRevision: 1n,
      committedFromAllocationRevision: committed ? 1n : null, committedToAllocationRevision: committed ? 2n : null,
      aggregateVersion: committed ? 2n : 1n, fenceEpoch: committed ? 2n : 1n,
      resolutionKind: null, resolutionRef: null, committedAt: committed ? "2026-07-29T00:00:00.000Z" : null,
      settledAt: null, releasedAt: null },
  };
}

function transactionLease() {
  return issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
}
