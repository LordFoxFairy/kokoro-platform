import { describe, expect, it } from "vitest";
import { CreditService } from "../../src/modules/credit/application/credit-service.js";
import {
  buildDerivedMediaChildReceipt,
  buildReturnedMediaChildReceipt,
} from "../../src/modules/credit/application/media-child-receipt-codec.js";
import type {
  CreditAuthorityRepository,
  MediaChildAllocationReservationRecord,
  MediaChildAllocationReturnRecord,
  RootBudgetReservationRecord,
  StoredMediaChildAllocation,
  StoredParentAllocation,
  StoredSegmentAllocation,
} from "../../src/modules/credit/application/contracts/credit-authority-repository.js";
import { issuePlatformTransaction, revokePlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";

const EXECUTION_ROOT_REF = "00000000-0000-7000-8000-000000000202";
const PARENT_ALLOCATION_REF = "00000000-0000-7000-8000-000000000203";
const CHILD_ALLOCATION_REF = "00000000-0000-7000-8000-000000000301";

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
      expect(result).toMatchObject({ value: {
        rootAllocationRef: repository.reservation?.rootAllocationRef,
        rootAllocationRevision: 1n,
        rootAllocationEpoch: 1n,
      } });
      expect(repository.reservation?.allocations).toEqual([
        { creditGrantId: "grant-first", amount: 40n, ordinal: 0 },
        { creditGrantId: "grant-late", amount: 20n, ordinal: 1 },
      ]);
      expect(repository.reservation?.rootCeiling).toBe(60n);
      expect(repository.reservation?.segmentMaximum).toBe(25n);
      expect(repository.grantLockInput?.consumptionScope).toEqual({
        surfaceRef: "general.chat", capabilityKey: "general.chat.message", agentRef: null,
      });
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
        rootAllocationRef: "allocation-existing", rootAllocationRevision: 1n, rootAllocationEpoch: 1n,
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

  it("rejects a past or unbounded new Hold against the authority clock", async () => {
    const repository = new RecordingCreditRepository();
    const lease = transactionLease();
    try {
      const service = creditService(repository);
      await expect(service.reserveRootBudget(lease.transaction, {
        ...reserveInput(), expiresAt: "2026-07-29T00:00:00.000Z",
      })).resolves.toEqual({ kind: "invalid_state", code: "CREDIT_RESERVATION_EXPIRY_INVALID" });
      await expect(service.reserveRootBudget(lease.transaction, {
        ...reserveInput(), businessOperationKey: "prepare:too-long",
        expiresAt: "2026-07-29T00:15:00.001Z",
      })).resolves.toEqual({ kind: "invalid_state", code: "CREDIT_RESERVATION_EXPIRY_INVALID" });
      expect(repository.grantLockCount).toBe(0);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("fails closed on an incomplete or malformed consumption scope before locking grants", async () => {
    const repository = new RecordingCreditRepository();
    const lease = transactionLease();
    try {
      await expect(creditService(repository).reserveRootBudget(lease.transaction, {
        ...reserveInput(), consumptionScope: {
          surfaceRef: "general.chat", capabilityKey: "general.chat.message", agentRef: "",
        },
      })).resolves.toEqual({ kind: "invalid_state", code: "CREDIT_CONSUMPTION_SCOPE_INVALID" });
      expect(repository.grantLockCount).toBe(0);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects Finalize at or after Segment expiry", async () => {
    const repository = new RecordingCreditRepository();
    repository.loaded = { ...storedSegment(), expiresAt: "2026-07-29T00:00:00.000Z" };
    const lease = transactionLease();
    try {
      await expect(creditService(repository).finalizeAuthorizationSegment(lease.transaction, segmentCommand()))
        .resolves.toEqual({ kind: "invalid_state", code: "CREDIT_SEGMENT_EXPIRED" });
      expect(repository.saved).toBeNull();
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("derives a Media child from the exact locked root allocation and records conserved revisions", async () => {
    const repository = new RecordingCreditRepository();
    repository.parentLoaded = storedParentAllocation();
    const lease = transactionLease();
    try {
      const result = await creditService(repository).deriveChildAllocation(
        lease.transaction,
        deriveChildInput(),
      );

      expect(result).toMatchObject({ kind: "accepted", value: {
        state: "active", audience: "media", purpose: "media_operation",
        parentRevisionBefore: 3n, parentRevisionAfter: 4n,
        childRevisionBefore: 0n, childRevisionAfter: 1n,
        reservedCeiling: 30n, mediaOperationRef: "media-operation-1",
      } });
      expect(repository.derived?.parentAllocation).toMatchObject({
        revision: 4n, unassignedStock: 70n, activeChildReservedStock: 30n,
      });
      expect(repository.derived?.childAllocation).toMatchObject({
        revision: 1n, creditCeiling: 30n, unassignedStock: 30n,
      });
      expect(repository.derived?.consumptionScope).toEqual({
        surfaceRef: "media.image", capabilityKey: "image.text_to_image", agentRef: null,
      });
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("recovers a Media child derivation receipt before locking and conflicts on changed digest", async () => {
    const repository = new RecordingCreditRepository();
    repository.operation = { kind: "replayed", value: derivedChildReceipt() };
    const lease = transactionLease();
    try {
      await expect(creditService(repository).deriveChildAllocation(lease.transaction, deriveChildInput()))
        .resolves.toEqual(repository.operation);
      expect(repository.parentLockCount).toBe(0);

      repository.operation = { kind: "conflict", code: "REQUEST_DIGEST_CONFLICT" };
      await expect(creditService(repository).deriveChildAllocation(lease.transaction, {
        ...deriveChildInput(), requestDigest: "c".repeat(64),
      })).resolves.toEqual({ kind: "conflict", code: "REQUEST_DIGEST_CONFLICT" });
      expect(repository.parentLockCount).toBe(0);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("replays derivation only when every persisted command dimension matches", async () => {
    const repository = new RecordingCreditRepository();
    repository.operation = { kind: "replayed", value: derivedChildReceipt() };
    const lease = transactionLease();
    try {
      for (const changed of [
        { mediaOperationRef: "media-operation-other" },
        { parentAllocationRef: "00000000-0000-7000-8000-000000000399" },
        { exactCeiling: 31n },
        { expiresAt: "2026-07-29T00:03:00.000Z" },
        { consumptionScope: { ...deriveChildInput().consumptionScope, surfaceRef: "media.video" } },
        { consumptionScope: { ...deriveChildInput().consumptionScope, capabilityKey: "video.text_to_video" } },
        { consumptionScope: { ...deriveChildInput().consumptionScope, agentRef: "agent-1" } },
      ] as const) {
        await expect(creditService(repository).deriveChildAllocation(lease.transaction, {
          ...deriveChildInput(), ...changed,
        })).resolves.toEqual({ kind: "invalid_state", code: "CREDIT_OPERATION_RECEIPT_SCOPE_MISMATCH" });
      }
      await expect(creditService(repository).deriveChildAllocation(lease.transaction, {
        ...deriveChildInput(), expectedParentRevision: 2n,
      })).resolves.toEqual({ kind: "conflict", code: "PARENT_REVISION_CONFLICT" });
      await expect(creditService(repository).deriveChildAllocation(lease.transaction, {
        ...deriveChildInput(), expectedParentAllocationEpoch: 1n,
      })).resolves.toEqual({ kind: "conflict", code: "PARENT_EPOCH_CONFLICT" });
      expect(repository.parentLockCount).toBe(0);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects malformed UTF-16 and PostgreSQL int8-overflow fences before persistence", async () => {
    const repository = new RecordingCreditRepository();
    const lease = transactionLease();
    try {
      await expect(creditService(repository).deriveChildAllocation(lease.transaction, {
        ...deriveChildInput(), mediaOperationRef: `media-${String.fromCharCode(0xd800)}`,
      })).resolves.toEqual({ kind: "invalid_state", code: "CREDIT_REFERENCE_INVALID" });
      await expect(creditService(repository).deriveChildAllocation(lease.transaction, {
        ...deriveChildInput(), expectedParentRevision: 9_223_372_036_854_775_808n,
      })).resolves.toEqual({ kind: "invalid_state", code: "CREDIT_CHILD_PARENT_FENCE_INVALID" });
      await expect(creditService(repository).returnChildAllocation(lease.transaction, {
        ...returnChildInput(), expectedChildAllocationEpoch: 9_223_372_036_854_775_808n,
      })).resolves.toEqual({ kind: "invalid_state", code: "CREDIT_CHILD_RETURN_FENCE_INVALID" });
      expect(repository.parentLockCount).toBe(0);
      expect(repository.childLockCount).toBe(0);

      repository.parentLoaded = { ...storedParentAllocation(), allocation: {
        ...storedParentAllocation().allocation, revision: 9_223_372_036_854_775_807n,
      } };
      await expect(creditService(repository).deriveChildAllocation(lease.transaction, {
        ...deriveChildInput(), expectedParentRevision: 9_223_372_036_854_775_807n,
      })).resolves.toEqual({ kind: "invalid_state", code: "CREDIT_CHILD_FENCE_EXHAUSTED" });
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("never downgrades an unexpected programmer failure to invalid_state", async () => {
    const repository = new RecordingCreditRepository();
    const allocation = { ...storedParentAllocation().allocation };
    Object.defineProperty(allocation, "state", { enumerable: true, get: () => {
      throw new Error("programmer-bug");
    } });
    repository.parentLoaded = { ...storedParentAllocation(), allocation } as StoredParentAllocation;
    const lease = transactionLease();
    try {
      await expect(creditService(repository).deriveChildAllocation(lease.transaction, deriveChildInput()))
        .rejects.toThrow("programmer-bug");
      expect(repository.derived).toBeNull();
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("fails closed on the wrong root lineage and precisely fences stale parent revision or epoch", async () => {
    const repository = new RecordingCreditRepository();
    const lease = transactionLease();
    try {
      repository.parentLoaded = { ...storedParentAllocation(), executionBudgetRootRef: "wrong-root" };
      await expect(creditService(repository).deriveChildAllocation(lease.transaction, deriveChildInput()))
        .resolves.toEqual({ kind: "not_found" });

      repository.parentLoaded = storedParentAllocation();
      await expect(creditService(repository).deriveChildAllocation(lease.transaction, {
        ...deriveChildInput(), businessOperationKey: "derive:stale-revision", expectedParentRevision: 2n,
      })).resolves.toEqual({ kind: "conflict", code: "PARENT_REVISION_CONFLICT" });
      await expect(creditService(repository).deriveChildAllocation(lease.transaction, {
        ...deriveChildInput(), businessOperationKey: "derive:stale-epoch", expectedParentAllocationEpoch: 1n,
      })).resolves.toEqual({ kind: "conflict", code: "PARENT_EPOCH_CONFLICT" });

      repository.parentLoaded = { ...storedParentAllocation(), allocation: {
        ...storedParentAllocation().allocation, revision: 4n, unassignedStock: 70n,
        activeChildReservedStock: 30n,
      } };
      await expect(creditService(repository).deriveChildAllocation(lease.transaction, {
        ...deriveChildInput(), businessOperationKey: "derive:winner-refreshed-head",
      })).resolves.toEqual({ kind: "conflict", code: "PARENT_REVISION_CONFLICT" });
      expect(repository.derived).toBeNull();
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("returns only a closed Media child and atomically rolls captured and unspent stock upward", async () => {
    const repository = new RecordingCreditRepository();
    repository.childLoaded = storedMediaChildAllocation();
    const lease = transactionLease();
    try {
      const result = await creditService(repository).returnChildAllocation(
        lease.transaction,
        returnChildInput(),
      );

      expect(result).toMatchObject({ kind: "accepted", value: {
        state: "terminal", returnedAmount: 20n, capturedAmount: 10n,
        parentRevisionBefore: 4n, parentRevisionAfter: 5n,
        childRevisionBefore: 2n, childRevisionAfter: 3n,
        childAllocationEpochBefore: 1n, childAllocationEpochAfter: 2n,
      } });
      expect(repository.returned?.parentAllocation).toMatchObject({
        revision: 5n, unassignedStock: 90n, activeChildReservedStock: 0n,
        capturedCumulative: 10n,
      });
      expect(repository.returned?.childAllocation).toMatchObject({
        revision: 3n, state: "terminal", unassignedStock: 0n,
        returnedToParentCumulative: 20n, parentAppliedRevision: 5n,
      });
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("recovers a Media child return receipt before locking after response loss", async () => {
    const repository = new RecordingCreditRepository();
    repository.operation = { kind: "replayed", value: returnedChildReceipt() };
    const lease = transactionLease();
    try {
      await expect(creditService(repository).returnChildAllocation(lease.transaction, returnChildInput()))
        .resolves.toEqual(repository.operation);
      expect(repository.childLockCount).toBe(0);

      await expect(creditService(repository).returnChildAllocation(lease.transaction, {
        ...returnChildInput(), expectedChildRevision: 1n,
      })).resolves.toEqual({ kind: "conflict", code: "CHILD_REVISION_CONFLICT" });
      await expect(creditService(repository).returnChildAllocation(lease.transaction, {
        ...returnChildInput(), childAllocationRef: "00000000-0000-7000-8000-000000000399",
      })).resolves.toEqual({ kind: "invalid_state", code: "CREDIT_OPERATION_RECEIPT_SCOPE_MISMATCH" });
      expect(repository.childLockCount).toBe(0);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("returns precise closed outcomes for double return and unresolved child effects", async () => {
    const repository = new RecordingCreditRepository();
    const lease = transactionLease();
    try {
      repository.childLoaded = { ...storedMediaChildAllocation(),
        parentAllocation: { ...storedMediaChildAllocation().parentAllocation,
          revision: 5n, unassignedStock: 90n, activeChildReservedStock: 0n,
          capturedCumulative: 10n },
        childAllocation: { ...storedMediaChildAllocation().childAllocation,
          state: "terminal", revision: 3n, allocationEpoch: 2n, unassignedStock: 0n,
          returnedToParentCumulative: 20n, terminalReceiptDigest: returnedChildReceipt().receiptDigest,
          parentAppliedRevision: 5n },
        priorReturn: {
          operation: { siteId: "site-1", operationKind: "return_media_child",
            businessOperationKey: "return:media-operation-1", requestDigest: "d".repeat(64) },
          value: returnedChildReceipt(),
        } };
      const terminalFences = { expectedParentRevision: 5n, expectedChildRevision: 3n,
        expectedChildAllocationEpoch: 2n };
      await expect(creditService(repository).returnChildAllocation(lease.transaction, {
        ...returnChildInput(), ...terminalFences,
      })).resolves.toEqual({ kind: "replayed", value: returnedChildReceipt() });

      await expect(creditService(repository).returnChildAllocation(lease.transaction, {
        ...returnChildInput(), ...terminalFences, requestDigest: "f".repeat(64),
      })).resolves.toEqual({ kind: "closed", code: "ALREADY_RETURNED" });

      await expect(creditService(repository).returnChildAllocation(lease.transaction, {
        ...returnChildInput(), businessOperationKey: "return:different-command",
        requestDigest: "f".repeat(64), ...terminalFences,
      })).resolves.toEqual({ kind: "closed", code: "ALREADY_RETURNED" });

      await expect(creditService(repository).returnChildAllocation(lease.transaction, {
        ...returnChildInput(), businessOperationKey: "return:stale-terminal",
        expectedParentRevision: 5n, expectedChildRevision: 2n, expectedChildAllocationEpoch: 2n,
      })).resolves.toEqual({ kind: "conflict", code: "CHILD_REVISION_CONFLICT" });

      for (const [authorizationClosure, code] of [
        [{ reserved: 0n, committed: 1n, ratingPending: 0n, reconciliationRequired: 0n }, "COMMITTED_STOCK_PENDING"],
        [{ reserved: 0n, committed: 0n, ratingPending: 1n, reconciliationRequired: 0n }, "RATING_PENDING"],
        [{ reserved: 0n, committed: 0n, ratingPending: 0n, reconciliationRequired: 1n }, "RECONCILIATION_REQUIRED"],
      ] as const) {
        repository.childLoaded = { ...storedMediaChildAllocation(), authorizationClosure };
        repository.operation = { kind: "none" };
        await expect(creditService(repository).returnChildAllocation(lease.transaction, {
          ...returnChildInput(), businessOperationKey: `return:${code}`,
        })).resolves.toEqual({ kind: "closed", code });
      }
      expect(repository.returned).toBeNull();
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("precisely fences stale child revisions and rejects closure evidence from another Media operation", async () => {
    const repository = new RecordingCreditRepository();
    repository.childLoaded = storedMediaChildAllocation();
    const lease = transactionLease();
    try {
      await expect(creditService(repository).returnChildAllocation(lease.transaction, {
        ...returnChildInput(), expectedChildRevision: 1n,
      })).resolves.toEqual({ kind: "conflict", code: "CHILD_REVISION_CONFLICT" });
      await expect(creditService(repository).returnChildAllocation(lease.transaction, {
        ...returnChildInput(), businessOperationKey: "return:stale-epoch", expectedChildAllocationEpoch: 2n,
      })).resolves.toEqual({ kind: "conflict", code: "CHILD_EPOCH_CONFLICT" });
      await expect(creditService(repository).returnChildAllocation(lease.transaction, {
        ...returnChildInput(), businessOperationKey: "return:wrong-owner",
        ownerClosureEvidence: { ...returnChildInput().ownerClosureEvidence,
          mediaOperationRef: "media-operation-other" },
      })).resolves.toEqual({ kind: "invalid_state", code: "CREDIT_CHILD_OWNER_EVIDENCE_MISMATCH" });
      expect(repository.returned).toBeNull();
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects malformed UUID-backed allocation references before repository SQL", async () => {
    const repository = new RecordingCreditRepository();
    repository.parentLoaded = storedParentAllocation();
    const lease = transactionLease();
    try {
      await expect(creditService(repository).deriveChildAllocation(lease.transaction, {
        ...deriveChildInput(), executionBudgetRootRef: "not-a-uuid",
      })).resolves.toEqual({ kind: "invalid_state", code: "CREDIT_UUID_REFERENCE_INVALID" });
      expect(repository.parentLockCount).toBe(0);

      await expect(creditService(repository).returnChildAllocation(lease.transaction, {
        ...returnChildInput(), childAllocationRef: "NOT-A-CANONICAL-UUID",
      })).resolves.toEqual({ kind: "invalid_state", code: "CREDIT_UUID_REFERENCE_INVALID" });
      expect(repository.childLockCount).toBe(0);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects nested extra keys, custom prototypes, and accessors without invoking them", async () => {
    const repository = new RecordingCreditRepository();
    repository.parentLoaded = storedParentAllocation();
    repository.childLoaded = storedMediaChildAllocation();
    const lease = transactionLease();
    try {
      const extraScope = { ...deriveChildInput().consumptionScope, invented: true };
      await expect(creditService(repository).deriveChildAllocation(lease.transaction, {
        ...deriveChildInput(), consumptionScope: extraScope,
      })).resolves.toEqual({ kind: "invalid_state", code: "CREDIT_CONSUMPTION_SCOPE_INVALID" });

      const prototypeEvidence = Object.assign(Object.create({ inherited: true }) as
        { kind: "media_operation_terminal"; mediaOperationRef: string; terminalReceiptRef: string;
          outcome: "completed" }, returnChildInput().ownerClosureEvidence);
      await expect(creditService(repository).returnChildAllocation(lease.transaction, {
        ...returnChildInput(), ownerClosureEvidence: prototypeEvidence,
      })).resolves.toEqual({ kind: "invalid_state", code: "CREDIT_CHILD_OWNER_EVIDENCE_INVALID" });

      await expect(creditService(repository).returnChildAllocation(lease.transaction, {
        ...returnChildInput(), ownerClosureEvidence: [] as never,
      })).resolves.toEqual({ kind: "invalid_state", code: "CREDIT_CHILD_OWNER_EVIDENCE_INVALID" });

      let accessorReads = 0;
      const accessorScope = { surfaceRef: "media.image", capabilityKey: "image.text_to_image",
        agentRef: null as string | null };
      Object.defineProperty(accessorScope, "agentRef", { enumerable: true, get: () => {
        accessorReads += 1;
        return null;
      } });
      await expect(creditService(repository).deriveChildAllocation(lease.transaction, {
        ...deriveChildInput(), consumptionScope: accessorScope,
      })).resolves.toEqual({ kind: "invalid_state", code: "CREDIT_CONSUMPTION_SCOPE_INVALID" });
      expect(accessorReads).toBe(0);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("snapshots nested scope before the first await and derives a safe partial-return reason", async () => {
    const repository = new RecordingCreditRepository();
    repository.parentLoaded = storedParentAllocation();
    const derivation = { ...deriveChildInput(), consumptionScope: {
      ...deriveChildInput().consumptionScope, surfaceRef: "media.image" as string,
    } };
    const lease = transactionLease();
    try {
      const pending = creditService(repository).deriveChildAllocation(lease.transaction, derivation);
      derivation.consumptionScope.surfaceRef = "mutated.after.call";
      await pending;
      expect(repository.derived?.consumptionScope.surfaceRef).toBe("media.image");

      repository.operation = { kind: "none" };
      repository.childLoaded = storedMediaChildAllocation();
      await expect(creditService(repository).returnChildAllocation(lease.transaction, {
        ...returnChildInput(), businessOperationKey: "return:partial",
        ownerClosureEvidence: { ...returnChildInput().ownerClosureEvidence, outcome: "partial" },
      })).resolves.toMatchObject({ kind: "accepted", value: {
        capturedAmount: 10n, reason: "fenced_recovery",
        ownerClosureEvidence: { outcome: "partial" },
      } });
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
  parentLoaded: StoredParentAllocation | null = null;
  childLoaded: StoredMediaChildAllocation | null = null;
  derived: MediaChildAllocationReservationRecord | null = null;
  returned: MediaChildAllocationReturnRecord | null = null;
  operation: Awaited<ReturnType<CreditAuthorityRepository["findOperationReceipt"]>> = { kind: "none" };
  grantLockCount = 0;
  segmentLockCount = 0;
  parentLockCount = 0;
  childLockCount = 0;
  grantLockInput: Parameters<CreditAuthorityRepository["lockGrantAvailability"]>[1] | null = null;

  async findOperationReceipt(): Promise<typeof this.operation> { return this.operation; }
  async lockGrantAvailability(
    _transaction: Parameters<CreditAuthorityRepository["lockGrantAvailability"]>[0],
    input: Parameters<CreditAuthorityRepository["lockGrantAvailability"]>[1],
  ): Promise<typeof this.grants> {
    this.grantLockCount += 1;
    this.grantLockInput = input;
    return this.grants;
  }
  async createRootBudgetReservation(_transaction: never, record: RootBudgetReservationRecord) {
    this.reservation = record;
    return { kind: "accepted" as const, value: { executionBudgetRootRef: record.executionBudgetRootRef, creditHoldRef: record.creditHoldRef,
      rootAllocationRef: record.rootAllocationRef, rootAllocationRevision: 1n, rootAllocationEpoch: 1n,
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
  async lockParentAllocation(): Promise<StoredParentAllocation | null> {
    this.parentLockCount += 1;
    return this.parentLoaded;
  }
  async createMediaChildAllocation(_transaction: never, record: MediaChildAllocationReservationRecord) {
    this.derived = record;
    return { kind: "accepted" as const, value: record.receipt };
  }
  async lockMediaChildAllocation(): Promise<StoredMediaChildAllocation | null> {
    this.childLockCount += 1;
    return this.childLoaded;
  }
  async closeMediaChildAllocation(_transaction: never, record: MediaChildAllocationReturnRecord) {
    this.returned = record;
    return { kind: "accepted" as const, value: record.receipt };
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
    consumptionScope: { surfaceRef: "general.chat", capabilityKey: "general.chat.message", agentRef: null },
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
    executionBudgetRootRef: EXECUTION_ROOT_REF, executionBudgetRootState: "open", executionBudgetRootVersion: 1n,
    creditHoldRef: "hold-1", creditHoldState: "open", creditHoldFenceEpoch: 1n,
    budgetAllocationRef: "allocation-1", authorizationSegmentRef: "segment-1",
    executionManifestRef: "manifest-1", expiresAt: "2026-07-29T00:05:00.000Z",
    consumptionScope: { surfaceRef: "general.chat", capabilityKey: "general.chat.message", agentRef: null },
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

function deriveChildInput() {
  return {
    siteId: "site-1",
    executionBudgetRootRef: EXECUTION_ROOT_REF,
    parentAllocationRef: PARENT_ALLOCATION_REF,
    expectedParentRevision: 3n,
    expectedParentAllocationEpoch: 2n,
    mediaOperationRef: "media-operation-1",
    businessOperationKey: "derive:media-operation-1",
    requestDigest: "b".repeat(64),
    exactCeiling: 30n,
    audience: "media",
    purpose: "media_operation",
    consumptionScope: { surfaceRef: "media.image", capabilityKey: "image.text_to_image", agentRef: null },
    expiresAt: "2026-07-29T00:04:00.000Z",
  } as const;
}

function returnChildInput() {
  return {
    siteId: "site-1",
    executionBudgetRootRef: EXECUTION_ROOT_REF,
    parentAllocationRef: PARENT_ALLOCATION_REF,
    childAllocationRef: CHILD_ALLOCATION_REF,
    expectedParentRevision: 4n,
    expectedParentAllocationEpoch: 2n,
    expectedChildRevision: 2n,
    expectedChildAllocationEpoch: 1n,
    mediaOperationRef: "media-operation-1",
    businessOperationKey: "return:media-operation-1",
    requestDigest: "d".repeat(64),
    ownerClosureEvidence: {
      kind: "media_operation_terminal",
      mediaOperationRef: "media-operation-1",
      terminalReceiptRef: "media-terminal-receipt-1",
      outcome: "completed",
    },
  } as const;
}

function storedParentAllocation(): StoredParentAllocation {
  return {
    siteId: "site-1",
    billingAccountId: "billing-1",
    creditAccountId: "00000000-0000-7000-8000-000000000001",
    unit: "credit_micros",
    liabilityMerchantAccountId: "merchant-1",
    executionBudgetRootRef: EXECUTION_ROOT_REF,
    executionBudgetRootState: "open",
    creditHoldRef: "hold-1",
    creditHoldState: "open",
    creditHoldExpiresAt: "2026-07-29T00:05:00.000Z",
    parentAllocationRef: PARENT_ALLOCATION_REF,
    isRoot: true,
    audience: "root",
    reservedSegmentStock: 0n,
    allocation: { revision: 3n, allocationEpoch: 2n, creditCeiling: 100n,
      unassignedStock: 100n, activeChildReservedStock: 0n, committedStock: 0n,
      capturedCumulative: 0n, returnedToParentCumulative: 0n, state: "active" },
  };
}

function storedMediaChildAllocation(): StoredMediaChildAllocation {
  return {
    ...storedParentAllocation(),
    parentAllocation: { ...storedParentAllocation().allocation, revision: 4n,
      unassignedStock: 70n, activeChildReservedStock: 30n },
    childAllocationRef: CHILD_ALLOCATION_REF,
    childAudience: "media",
    childPurpose: "media_operation",
    mediaOperationRef: "media-operation-1",
    consumptionScope: { surfaceRef: "media.image", capabilityKey: "image.text_to_image", agentRef: null },
    expiresAt: "2026-07-29T00:04:00.000Z",
    childAllocation: { revision: 2n, allocationEpoch: 1n, creditCeiling: 30n,
      unassignedStock: 20n, activeChildReservedStock: 0n, committedStock: 0n,
      capturedCumulative: 10n, returnedToParentCumulative: 0n, state: "active",
      terminalReceiptDigest: null, parentAppliedRevision: null },
    authorizationClosure: { reserved: 0n, committed: 0n, ratingPending: 0n,
      reconciliationRequired: 0n },
    priorReturn: null,
  };
}

function derivedChildReceipt() {
  return buildDerivedMediaChildReceipt({
    allocationReservationReceiptRef: "reservation-receipt-1",
    executionBudgetRootRef: EXECUTION_ROOT_REF,
    parentAllocationRef: PARENT_ALLOCATION_REF,
    parentRevisionBefore: 3n,
    parentRevisionAfter: 4n,
    parentAllocationEpoch: 2n,
    childAllocationRef: CHILD_ALLOCATION_REF,
    childRevisionBefore: 0n,
    childRevisionAfter: 1n,
    childAllocationEpoch: 1n,
    mediaOperationRef: "media-operation-1",
    reservedCeiling: 30n,
    audience: "media" as const,
    purpose: "media_operation" as const,
    consumptionScope: { surfaceRef: "media.image", capabilityKey: "image.text_to_image", agentRef: null },
    expiresAt: "2026-07-29T00:04:00.000Z",
    state: "active" as const,
    observedAt: "2026-07-29T00:00:00.000Z",
  }, {
    siteId: "site-1",
    operationKind: "derive_media_child",
    businessOperationKey: "derive:media-operation-1",
    requestDigest: "b".repeat(64),
  });
}

function returnedChildReceipt() {
  return buildReturnedMediaChildReceipt({
    allocationReturnReceiptRef: "return-receipt-1",
    executionBudgetRootRef: EXECUTION_ROOT_REF,
    parentAllocationRef: PARENT_ALLOCATION_REF,
    childAllocationRef: CHILD_ALLOCATION_REF,
    parentRevisionBefore: 4n,
    parentRevisionAfter: 5n,
    parentAllocationEpoch: 2n,
    childRevisionBefore: 2n,
    childRevisionAfter: 3n,
    childAllocationEpochBefore: 1n,
    childAllocationEpochAfter: 2n,
    mediaOperationRef: "media-operation-1",
    returnedAmount: 20n,
    capturedAmount: 10n,
    reason: "completed" as const,
    rootStateAtReturn: "open" as const,
    ownerClosureEvidence: returnChildInput().ownerClosureEvidence,
    state: "terminal" as const,
    observedAt: "2026-07-29T00:00:00.000Z",
  }, {
    siteId: "site-1",
    operationKind: "return_media_child",
    businessOperationKey: "return:media-operation-1",
    requestDigest: "d".repeat(64),
  });
}

function transactionLease() {
  return issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
}
