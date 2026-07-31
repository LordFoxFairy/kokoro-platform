import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DirectMediaRootClosureService } from
  "../../src/modules/credit/application/direct-media-root-closure-service.js";
import type {
  DirectMediaRootClosureRepository,
  StoredDirectMediaRootClosure,
} from "../../src/modules/credit/application/contracts/direct-media-root-closure-repository.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";

const transactionLease = () => issuePlatformTransaction({
  query: async () => [],
  execute: async () => 0,
});

describe("Credit direct Media root closure", () => {
  it("terminals the exact root and releases only the uncaptured original Hold sources", async () => {
    const current = openRoot();
    const repository = fakeRepository(current);
    const service = new DirectMediaRootClosureService({ repository,
      clock: () => new Date("2026-08-12T12:00:00.000Z"), reference: stableReference });
    const lease = transactionLease();
    try {
      await expect(service.close(lease.transaction, command())).resolves.toEqual({
        kind: "accepted",
        value: {
          allocationClosureReceiptRef: stableReference("direct-root-closure", command().businessOperationKey),
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
    const service = new DirectMediaRootClosureService({ repository,
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

  it("does not manufacture an empty journal when the Hold is fully captured", async () => {
    const current = openRoot();
    const repository = fakeRepository({ ...current,
      holdCapturedAmount: 100n,
      allocation: { ...current.allocation, unassignedStock: 0n, capturedCumulative: 100n },
      settlement: { ...current.settlement, customerAmount: 100n },
      holdAllocations: current.holdAllocations.map((source) => ({ ...source,
        netCustomerAmount: source.allocatedAmount })),
    });
    const service = new DirectMediaRootClosureService({ repository,
      clock: () => new Date("2026-08-12T12:00:00.000Z"), reference: stableReference });
    const lease = transactionLease();
    try {
      const input = { ...command(), settlement: { ...command().settlement, customerAmount: 100n } };
      await expect(service.close(lease.transaction, input)).resolves.toMatchObject({
        kind: "accepted", value: { capturedAmount: 100n, releasedAmount: 0n },
      });
      expect(repository.persistClosure).toHaveBeenCalledWith(lease.transaction,
        expect.objectContaining({ releases: [], releaseJournalTransactionRef: null }));
    } finally { revokePlatformTransaction(lease); }
  });

  it("fails closed while any descendant, Segment or attempt remains open", async () => {
    const repository = fakeRepository({ ...openRoot(), openAttemptCount: 1n });
    const service = new DirectMediaRootClosureService({ repository,
      clock: () => new Date("2026-08-12T12:00:00.000Z"), reference: stableReference });
    const lease = transactionLease();
    try {
      await expect(service.close(lease.transaction, command())).resolves.toEqual({
        kind: "invalid_state", code: "CREDIT_DIRECT_ROOT_ATTEMPT_PENDING",
      });
      expect(repository.persistClosure).not.toHaveBeenCalled();
    } finally { revokePlatformTransaction(lease); }
  });

  it("never derives capture from Media outcome when the durable Rating settlement mismatches", async () => {
    const repository = fakeRepository({ ...openRoot(), settlement: {
      ...openRoot().settlement, customerAmount: 24n,
    } });
    const service = new DirectMediaRootClosureService({ repository,
      clock: () => new Date("2026-08-12T12:00:00.000Z"), reference: stableReference });
    const lease = transactionLease();
    try {
      await expect(service.close(lease.transaction, command())).resolves.toEqual({
        kind: "reconciliation_required",
        code: "CREDIT_DIRECT_ROOT_RATING_MISMATCH",
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
    const service = new DirectMediaRootClosureService({ repository,
      clock: () => new Date("2026-08-12T12:00:00.000Z"), reference: stableReference });
    const lease = transactionLease();
    try {
      await expect(service.close(lease.transaction, command())).resolves.toMatchObject({
        kind: "reconciliation_required", code: "CREDIT_DIRECT_ROOT_HOLD_SOURCE_MISMATCH",
      });
      expect(repository.persistClosure).not.toHaveBeenCalled();
    } finally { revokePlatformTransaction(lease); }
  });
});

function command() {
  return {
    siteId: "site:one", operationRef: "media-operation:one",
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
    effectClosureReceiptRef: "media-terminal:one", outcome: "completed" as const,
    settlement: {
      settlementRef: "00000000-0000-7000-8000-000000000005",
      authorizationSegmentRef: "00000000-0000-7000-8000-000000000004",
      closureRef: "00000000-0000-7000-8000-000000000006",
      closureRevision: 1n, state: "settled" as const,
      customerAmount: 25n, platformExposureAmount: 0n,
    },
    businessOperationKey: "media-root-close:one", requestDigest: "a".repeat(64),
  };
}

function openRoot(): StoredDirectMediaRootClosure {
  return Object.freeze({
    siteId: "site:one", operationRef: "media-operation:one",
    executionBudgetRootRef: "00000000-0000-7000-8000-000000000001",
    rootState: "open", rootVersion: 1n,
    billingAccountId: "billing:one",
    creditAccountId: "00000000-0000-7000-8000-000000000011",
    liabilityMerchantAccountId: "merchant:one",
    creditHoldRef: "00000000-0000-7000-8000-000000000002",
    holdState: "open", holdFenceEpoch: 1n, holdReservedAmount: 100n,
    holdCapturedAmount: 25n, holdReleasedAmount: 0n,
    rootAllocationRef: "00000000-0000-7000-8000-000000000003",
    allocation: { revision: 3n, allocationEpoch: 1n, creditCeiling: 100n,
      unassignedStock: 75n, activeChildReservedStock: 0n, committedStock: 0n,
      capturedCumulative: 25n, returnedToParentCumulative: 0n, state: "active" as const },
    openChildCount: 0n, openSegmentCount: 0n, openAttemptCount: 0n,
    settlement: { settlementRef: "00000000-0000-7000-8000-000000000005",
      authorizationSegmentRef: "00000000-0000-7000-8000-000000000004",
      executionBudgetRootRef: "00000000-0000-7000-8000-000000000001",
      budgetAllocationRef: "00000000-0000-7000-8000-000000000003",
      creditHoldRef: "00000000-0000-7000-8000-000000000002",
      unit: "credit_micros", customerAmount: 25n, ratingSnapshotRef:
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
    stableReference("direct-root-closure", command().businessOperationKey),
  siteId: "site:one", operationRef: "media-operation:one",
  businessOperationKey: command().businessOperationKey, requestDigest: "a".repeat(64),
  effectClosureReceiptRef: "media-terminal:one",
  settlementRef: "00000000-0000-7000-8000-000000000005",
  executionBudgetRootRef: "00000000-0000-7000-8000-000000000001",
  rootAllocationRef: "00000000-0000-7000-8000-000000000003",
  rootHoldRef: "00000000-0000-7000-8000-000000000002",
  capturedAmount: 25n, releasedAmount: 75n, unit: "credit_micros",
  receiptDigest: "b".repeat(64), recordedAt: "2026-08-12T12:00:00.000Z" });
}

function fakeRepository(current: StoredDirectMediaRootClosure,
  prior: ReturnType<typeof receipt> | null = null): DirectMediaRootClosureRepository {
  return {
    findClosure: vi.fn(async () => prior === null ? { kind: "none" as const }
      : { kind: "replayed" as const, value: prior }),
    lockRootClosure: vi.fn(async () => current),
    persistClosure: vi.fn(async (_transaction, record) => ({ kind: "accepted" as const,
      value: record.receipt })),
    markReconciliationRequired: vi.fn(async () => undefined),
  };
}

function stableReference(kind: "direct-root-closure" | "allocation-revision" |
  "release-journal" | "reconciliation", seed: string): string {
  const value = createHash("sha256").update(`${kind}\0${seed}`).digest("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-7${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}
