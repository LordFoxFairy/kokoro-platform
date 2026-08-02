import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  deriveExecutionRootClosureRequestDigest,
  ExecutionRootClosureService,
  type ExecutionRootClosureRequest,
} from "../../src/modules/credit/application/execution-root-closure-service.js";
import { ExecutionRootClosureAuthority } from
  "../../src/modules/credit/application/execution-root-closure-authority.js";
import type {
  ExecutionRootClosureReceipt,
  ExecutionRootClosureRepository,
  StoredExecutionRootClosureContext,
} from "../../src/modules/credit/application/contracts/execution-root-closure-repository.js";
import { verifyMediaExecutionRootOwnerProof } from
  "../../src/modules/credit/application/contracts/execution-root-closure-repository.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";

const transactionLease = () => issuePlatformTransaction({
  query: async () => [],
  execute: async () => 0,
});
type ClosureInput = ExecutionRootClosureRequest;

describe("Credit execution root closure", () => {
  it("keeps the framed request digest stable across TypeScript and PostgreSQL", () => {
    expect(command().requestDigest).toBe(
      "ee20077db02ca6f095c5b4ac45034913b36461b6556ba6006e7e500c201d1646",
    );
  });

  it("terminals the exact root and releases only the uncaptured original Hold sources", async () => {
    const current = openRoot();
    const repository = fakeRepository(current);
    const service = new ExecutionRootClosureService({ repository,
      clock: () => new Date("2026-08-12T12:00:00.000Z"), reference: stableReference });
    const lease = transactionLease();
    try {
      await expect(service.close(lease.transaction, command())).resolves.toEqual({
        kind: "accepted",
        value: {
          allocationClosureReceiptRef: stableReference("execution-root-closure", command().businessOperationKey),
          capturedAmount: 25n,
          releasedAmount: 75n,
        },
      });
      expect(repository.persistClosure).toHaveBeenCalledWith(lease.transaction,
        expect.objectContaining({
          current,
          allocation: expect.objectContaining({ state: "terminal", revision: 4n,
            allocationEpoch: 2n, unassignedStock: 0n, capturedCumulative: 25n,
            returnedToParentCumulative: 75n }),
          rootState: "settled", rootVersion: 2n,
          holdState: "settled", holdFenceEpoch: 2n,
          capturedAmount: 25n, releasedAmount: 75n,
          releases: [
            { creditGrantId: "00000000-0000-7000-8000-000000000101", ordinal: 0,
              amount: 35n },
            { creditGrantId: "00000000-0000-7000-8000-000000000102", ordinal: 1,
              amount: 40n },
          ],
        }));
    } finally { revokePlatformTransaction(lease); }
  });

  it("replays the stable closure receipt without locking or writing again", async () => {
    const prior = receipt();
    const repository = fakeRepository(openRoot(), prior);
    const service = new ExecutionRootClosureService({ repository,
      clock: () => new Date("2026-08-12T12:00:00.000Z"), reference: stableReference });
    const lease = transactionLease();
    try {
      await expect(service.close(lease.transaction, command())).resolves.toEqual({
        kind: "replayed",
        value: { allocationClosureReceiptRef: prior.allocationClosureReceiptRef,
          capturedAmount: 25n, releasedAmount: 75n },
      });
      expect(repository.lockRootClosure).not.toHaveBeenCalled();
      expect(repository.persistClosure).not.toHaveBeenCalled();
    } finally { revokePlatformTransaction(lease); }
  });

  it("replays the exact canonical timestamp and digest emitted by the accepted receipt", async () => {
    const acceptedReceipts: ExecutionRootClosureReceipt[] = [];
    const repository = fakeRepository(openRoot());
    vi.mocked(repository.findClosure).mockImplementation(async () => acceptedReceipts[0] === undefined
      ? { kind: "none" as const } : { kind: "replayed" as const, value: acceptedReceipts[0] });
    vi.mocked(repository.persistClosure).mockImplementation(async (_transaction, record) => {
      acceptedReceipts.push(record.receipt);
      return { kind: "accepted" as const, value: record.receipt };
    });
    const service = new ExecutionRootClosureService({ repository,
      clock: () => new Date("2026-08-12T12:00:00.000Z"), reference: stableReference });
    const lease = transactionLease();
    try {
      await expect(service.close(lease.transaction, command())).resolves.toMatchObject({ kind: "accepted" });
      const stored = acceptedReceipts[0]!;
      expect(stored.recordedAt).toBe("2026-08-12T12:00:00.000Z");
      await expect(service.close(lease.transaction, command())).resolves.toMatchObject({ kind: "replayed" });
      expect(acceptedReceipts[0]?.receiptDigest).toBe(stored.receiptDigest);
      expect(repository.persistClosure).toHaveBeenCalledOnce();
    } finally { revokePlatformTransaction(lease); }
  });

  it("replays the exact reconciliation outcome after the accepted response is lost", async () => {
    const expected = Object.freeze({
      kind: "reconciliation_required" as const,
      reconciliationReceiptRef: stableReference("reconciliation", command().businessOperationKey),
      code: "CREDIT_EXECUTION_ROOT_RATING_MISMATCH",
    });
    let persisted = false;
    const base = fakeRepository({ ...openRoot(), settlement: {
      ...openRoot().settlement, customerAmount: 24n,
    } });
    const repository = {
      ...base,
      findClosure: vi.fn(async () => persisted
        ? expected
        : { kind: "none" as const }),
      markReconciliationRequired: vi.fn(async () => { persisted = true; }),
    } as unknown as ExecutionRootClosureRepository;
    const service = new ExecutionRootClosureService({ repository,
      clock: () => new Date("2026-08-12T12:00:00.000Z"), reference: stableReference });
    const lease = transactionLease();
    try {
      const baseCommand = command();
      const input = withRequestDigest({ ...baseCommand,
        settlement: { ...baseCommand.settlement, customerAmount: 24n } });
      await expect(service.close(lease.transaction, input)).resolves.toEqual(expected);
      await expect(service.close(lease.transaction, input)).resolves.toEqual(expected);
      expect(repository.lockRootClosure).toHaveBeenCalledOnce();
      expect(repository.markReconciliationRequired).toHaveBeenCalledOnce();
    } finally { revokePlatformTransaction(lease); }
  });

  it("returns a reconciliation winner discovered after the authority lock race", async () => {
    const expected = Object.freeze({
      kind: "reconciliation_required" as const,
      reconciliationReceiptRef: stableReference("reconciliation", command().businessOperationKey),
      code: "CREDIT_EXECUTION_ROOT_RATING_MISMATCH",
    });
    let lookups = 0;
    const base = fakeRepository(openRoot());
    const repository = {
      ...base,
      findClosure: vi.fn(async () => ++lookups === 1 ? { kind: "none" as const } : expected),
    } as unknown as ExecutionRootClosureRepository;
    const service = new ExecutionRootClosureService({ repository,
      clock: () => new Date("2026-08-12T12:00:00.000Z"), reference: stableReference });
    const lease = transactionLease();
    try {
      await expect(service.close(lease.transaction, command())).resolves.toEqual(expected);
      expect(repository.lockRootClosure).toHaveBeenCalledOnce();
      expect(repository.persistClosure).not.toHaveBeenCalled();
      expect(repository.markReconciliationRequired).not.toHaveBeenCalled();
    } finally { revokePlatformTransaction(lease); }
  });

  it("keeps an outcome identity or digest collision as a conflict before locking", async () => {
    const base = fakeRepository(openRoot());
    const repository = {
      ...base,
      findClosure: vi.fn(async () => ({ kind: "conflict" as const,
        code: "REQUEST_DIGEST_CONFLICT" as const })),
    };
    const service = new ExecutionRootClosureService({ repository,
      clock: () => new Date("2026-08-12T12:00:00.000Z"), reference: stableReference });
    const lease = transactionLease();
    try {
      await expect(service.close(lease.transaction, command())).resolves.toEqual({
        kind: "conflict", code: "REQUEST_DIGEST_CONFLICT",
      });
      expect(repository.lockRootClosure).not.toHaveBeenCalled();
    } finally { revokePlatformTransaction(lease); }
  });

  it("does not manufacture an empty journal when the Hold is fully captured", async () => {
    const current = openRoot();
    const repository = fakeRepository({ ...current,
      holdCapturedAmount: 100n,
      allocation: { ...current.allocation, unassignedStock: 0n, capturedCumulative: 100n },
      settlement: { ...current.settlement, customerAmount: 100n },
      holdAllocations: current.holdAllocations.map((source) => ({ ...source,
        netCustomerAmount: source.allocatedAmount })),
    });
    const service = new ExecutionRootClosureService({ repository,
      clock: () => new Date("2026-08-12T12:00:00.000Z"), reference: stableReference });
    const lease = transactionLease();
    try {
      const base = command();
      const input = withRequestDigest({ ...base,
        settlement: { ...base.settlement, customerAmount: 100n } });
      await expect(service.close(lease.transaction, input)).resolves.toMatchObject({
        kind: "accepted", value: { capturedAmount: 100n, releasedAmount: 0n },
      });
      expect(repository.persistClosure).toHaveBeenCalledWith(lease.transaction,
        expect.objectContaining({ releases: [], releaseJournalTransactionRef: null }));
    } finally { revokePlatformTransaction(lease); }
  });

  it("fails closed while any descendant, Segment or attempt remains open", async () => {
    const repository = fakeRepository({ ...openRoot(), openAttemptCount: 1n });
    const service = new ExecutionRootClosureService({ repository,
      clock: () => new Date("2026-08-12T12:00:00.000Z"), reference: stableReference });
    const lease = transactionLease();
    try {
      await expect(service.close(lease.transaction, command())).resolves.toEqual({
        kind: "invalid_state", code: "CREDIT_EXECUTION_ROOT_ATTEMPT_PENDING",
      });
      expect(repository.persistClosure).not.toHaveBeenCalled();
    } finally { revokePlatformTransaction(lease); }
  });

  it("never derives capture from Media outcome when the durable Rating settlement mismatches", async () => {
    const repository = fakeRepository({ ...openRoot(), settlement: {
      ...openRoot().settlement, customerAmount: 24n,
    } });
    const service = new ExecutionRootClosureService({ repository,
      clock: () => new Date("2026-08-12T12:00:00.000Z"), reference: stableReference });
    const lease = transactionLease();
    try {
      const base = command();
      const input = withRequestDigest({ ...base,
        settlement: { ...base.settlement, customerAmount: 24n } });
      await expect(service.close(lease.transaction, input)).resolves.toEqual({
        kind: "reconciliation_required",
        code: "CREDIT_EXECUTION_ROOT_RATING_MISMATCH",
        reconciliationReceiptRef: stableReference("reconciliation", command().businessOperationKey),
      });
      expect(repository.markReconciliationRequired).toHaveBeenCalledOnce();
      expect(repository.persistClosure).not.toHaveBeenCalled();
    } finally { revokePlatformTransaction(lease); }
  });

  it("reconciles when captured Hold source facts do not equal the persisted Hold capture", async () => {
    const current = openRoot();
    const repository = fakeRepository({ ...current, holdAllocations: current.holdAllocations.map(
      (source, index) => index === 0 ? { ...source, netCustomerAmount: 24n } : source) });
    const service = new ExecutionRootClosureService({ repository,
      clock: () => new Date("2026-08-12T12:00:00.000Z"), reference: stableReference });
    const lease = transactionLease();
    try {
      await expect(service.close(lease.transaction, command())).resolves.toMatchObject({
        kind: "reconciliation_required", code: "CREDIT_EXECUTION_ROOT_HOLD_SOURCE_MISMATCH",
      });
      expect(repository.persistClosure).not.toHaveBeenCalled();
    } finally { revokePlatformTransaction(lease); }
  });

  it("reconciles when the frozen Media budget authority no longer matches the close command", async () => {
    const current = openRoot();
    const repository = fakeRepository({ ...current, sourceBudget: {
      ...current.sourceBudget, executionManifestRef: "manifest:stale",
    } });
    const service = new ExecutionRootClosureService({ repository,
      clock: () => new Date("2026-08-12T12:00:00.000Z"), reference: stableReference });
    const lease = transactionLease();
    try {
      await expect(service.close(lease.transaction, command())).resolves.toMatchObject({
        kind: "reconciliation_required", code: "CREDIT_EXECUTION_ROOT_SOURCE_AUTHORITY_MISMATCH",
      });
      const reconciliation = vi.mocked(repository.markReconciliationRequired).mock.calls[0]?.[1];
      expect(reconciliation?.reconciliationAllocationRevisionRef).not.toBe(
        reconciliation?.reconciliationReceiptRef);
    } finally { revokePlatformTransaction(lease); }
  });

  it("reconciles when the durable Rating closure or platform exposure differs", async () => {
    const current = openRoot();
    const repository = fakeRepository(current);
    const service = new ExecutionRootClosureService({ repository,
      clock: () => new Date("2026-08-12T12:00:00.000Z"), reference: stableReference });
    const lease = transactionLease();
    try {
      const base = command();
      const changed = withRequestDigest({ ...base, settlement: {
        ...base.settlement, closureRevision: 2n, platformExposureAmount: 1n,
      } });
      await expect(service.close(lease.transaction, changed)).resolves.toMatchObject({
        kind: "reconciliation_required", code: "CREDIT_EXECUTION_ROOT_SOURCE_AUTHORITY_MISMATCH",
      });
    } finally { revokePlatformTransaction(lease); }
  });

  it("does not regress an already-terminal root into reconciliation", async () => {
    const current = openRoot();
    const repository = fakeRepository({ ...current, rootState: "settled",
      sourceBudget: { ...current.sourceBudget, executionManifestRef: "manifest:stale" } });
    const service = new ExecutionRootClosureService({ repository,
      clock: () => new Date("2026-08-12T12:00:00.000Z"), reference: stableReference });
    const lease = transactionLease();
    try {
      await expect(service.close(lease.transaction, command())).resolves.toEqual({
        kind: "invalid_state", code: "CREDIT_EXECUTION_ROOT_ROOT_NOT_OPEN",
      });
      expect(repository.markReconciliationRequired).not.toHaveBeenCalled();
    } finally { revokePlatformTransaction(lease); }
  });

  it("rejects a non-canonical request digest before consulting durable Credit state", async () => {
    const repository = fakeRepository(openRoot());
    const service = new ExecutionRootClosureService({ repository,
      clock: () => new Date("2026-08-12T12:00:00.000Z"), reference: stableReference });
    const lease = transactionLease();
    try {
      await expect(service.close(lease.transaction, { ...command(), requestDigest: "a".repeat(64) }))
        .rejects.toThrow("CREDIT_EXECUTION_ROOT_REQUEST_DIGEST_INVALID");
      expect(repository.findClosure).not.toHaveBeenCalled();
    } finally { revokePlatformTransaction(lease); }
  });

  it("plans the same conserved closure for a non-Media terminal source", () => {
    const media = openRoot();
    const decision = new ExecutionRootClosureAuthority().decide({
      siteId: media.siteId,
      sourceRef: "agent-run:one",
      executionBudgetRootRef: media.executionBudgetRootRef,
      rootState: media.rootState,
      rootVersion: media.rootVersion,
      creditHoldRef: media.creditHoldRef,
      holdState: media.holdState,
      holdFenceEpoch: media.holdFenceEpoch,
      holdReservedAmount: media.holdReservedAmount,
      holdCapturedAmount: media.holdCapturedAmount,
      holdReleasedAmount: media.holdReleasedAmount,
      rootAllocationRef: media.rootAllocationRef,
      sourceBudget: media.sourceBudget,
      allocation: media.allocation,
      openChildCount: media.openChildCount,
      openSegmentCount: media.openSegmentCount,
      openAttemptCount: media.openAttemptCount,
      settlement: media.settlement,
      holdAllocations: media.holdAllocations,
    }, {
      siteId: media.siteId,
      sourceRef: "agent-run:one",
      budget: command().budget,
      settlement: command().settlement,
    });
    expect(decision).toMatchObject({ kind: "ready", value: {
      rootState: "settled", holdState: "settled", capturedAmount: 25n, releasedAmount: 75n,
      allocation: { state: "terminal", unassignedStock: 0n },
    } });
  });
});

function command(): ClosureInput {
  return withRequestDigest({
    siteId: "site:one",
    ownerProof: verifyMediaExecutionRootOwnerProof({
      sourceRef: "media-operation:one",
      terminalEvidenceRef: "media-terminal:one",
      outcome: "completed",
      workerLease: { taskRef: "task:one", leaseEpoch: 7n, leaseTokenHash: "c".repeat(64) },
    }),
    budget: {
      kind: "direct_root" as const,
      executionBudgetRootRef: "00000000-0000-7000-8000-000000000001",
      executionManifestRef: "manifest:one",
      rootHoldRef: "00000000-0000-7000-8000-000000000002",
      rootAllocationRef: "00000000-0000-7000-8000-000000000003",
      rootAllocationRevision: 2n, rootAllocationEpoch: 1n,
      authorizationSegmentRef: "00000000-0000-7000-8000-000000000004",
      authorizationSegmentVersion: 5n, reservedCeiling: 100n, unit: "credit_micros",
    },
    settlement: {
      settlementRef: "00000000-0000-7000-8000-000000000005",
      authorizationSegmentRef: "00000000-0000-7000-8000-000000000004",
      closureRef: "00000000-0000-7000-8000-000000000006",
      closureRevision: 1n, state: "settled" as const,
      customerAmount: 25n, platformExposureAmount: 0n,
    },
    businessOperationKey: "media-root-close:one",
  });
}

function withRequestDigest(input: Omit<ClosureInput, "requestDigest"> | ClosureInput): ClosureInput {
  return { ...input, requestDigest: deriveExecutionRootClosureRequestDigest(input) };
}

function openRoot(): StoredExecutionRootClosureContext {
  return Object.freeze({
    siteId: "site:one", sourceKind: "media_operation", sourceRef: "media-operation:one",
    executionBudgetRootRef: "00000000-0000-7000-8000-000000000001",
    rootState: "open", rootVersion: 1n,
    billingAccountId: "billing:one",
    creditAccountId: "00000000-0000-7000-8000-000000000011",
    liabilityMerchantAccountId: "merchant:one",
    creditHoldRef: "00000000-0000-7000-8000-000000000002",
    holdState: "open", holdFenceEpoch: 1n, holdReservedAmount: 100n,
    holdCapturedAmount: 25n, holdReleasedAmount: 0n,
    rootAllocationRef: "00000000-0000-7000-8000-000000000003",
    sourceBudget: { executionManifestRef: "manifest:one", rootAllocationRevision: 2n,
      rootAllocationEpoch: 1n, authorizationSegmentVersion: 5n,
      reservedCeiling: 100n, unit: "credit_micros" },
    allocation: { revision: 3n, allocationEpoch: 1n, creditCeiling: 100n,
      unassignedStock: 75n, activeChildReservedStock: 0n, committedStock: 0n,
      capturedCumulative: 25n, returnedToParentCumulative: 0n, state: "active" as const },
    openChildCount: 0n, openSegmentCount: 0n, openAttemptCount: 0n,
    settlement: { settlementRef: "00000000-0000-7000-8000-000000000005",
      authorizationSegmentRef: "00000000-0000-7000-8000-000000000004",
      executionBudgetRootRef: "00000000-0000-7000-8000-000000000001",
      budgetAllocationRef: "00000000-0000-7000-8000-000000000003",
      creditHoldRef: "00000000-0000-7000-8000-000000000002",
      unit: "credit_micros", customerAmount: 25n,
      closureRef: "00000000-0000-7000-8000-000000000006", closureRevision: 1n,
      platformExposureAmount: 0n, ratingSnapshotRef:
        "00000000-0000-7000-8000-000000000007" },
    holdAllocations: [
      { creditGrantId: "00000000-0000-7000-8000-000000000101", ordinal: 0,
        allocatedAmount: 60n, netCustomerAmount: 25n },
      { creditGrantId: "00000000-0000-7000-8000-000000000102", ordinal: 1,
        allocatedAmount: 40n, netCustomerAmount: 0n },
    ],
  });
}

function receipt() {
  return Object.freeze({ allocationClosureReceiptRef:
    stableReference("execution-root-closure", command().businessOperationKey),
  siteId: "site:one", sourceKind: "media_operation" as const, sourceRef: "media-operation:one",
  ownerProofDigest: command().ownerProof.proofDigest,
  businessOperationKey: command().businessOperationKey, requestDigest: "a".repeat(64),
  terminalEvidenceRef: "media-terminal:one",
  settlementRef: "00000000-0000-7000-8000-000000000005",
  executionBudgetRootRef: "00000000-0000-7000-8000-000000000001",
  rootAllocationRef: "00000000-0000-7000-8000-000000000003",
  rootHoldRef: "00000000-0000-7000-8000-000000000002",
  capturedAmount: 25n, releasedAmount: 75n, unit: "credit_micros",
  outcome: "completed" as const, executionManifestRef: "manifest:one",
  authorizationSegmentRef: "00000000-0000-7000-8000-000000000004",
  authorizationSegmentVersion: 5n,
  settlementClosureRef: "00000000-0000-7000-8000-000000000006",
  settlementClosureRevision: 1n, platformExposureAmount: 0n,
  ratingSnapshotRef: "00000000-0000-7000-8000-000000000007",
  receiptDigest: "b".repeat(64), recordedAt: "2026-08-12T12:00:00.000Z" });
}

function fakeRepository(current: StoredExecutionRootClosureContext,
  prior: ReturnType<typeof receipt> | null = null): ExecutionRootClosureRepository {
  return {
    findClosure: vi.fn(async () => prior === null ? { kind: "none" as const }
      : { kind: "replayed" as const, value: prior }),
    lockRootClosure: vi.fn(async () => current),
    persistClosure: vi.fn(async (_transaction, record) => ({ kind: "accepted" as const,
      value: record.receipt })),
    markReconciliationRequired: vi.fn(async () => undefined),
  };
}

function stableReference(kind: "execution-root-closure" | "allocation-revision" |
  "release-journal" | "reconciliation" | "reconciliation-allocation-revision", seed: string): string {
  const value = createHash("sha256").update(`${kind}\0${seed}`).digest("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-7${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}
