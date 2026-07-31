import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { BudgetAllocationRevision } from "../../domain/allocation.js";
import type { HoldAllocationAvailability } from "../../domain/settlement.js";

export type DirectMediaRootClosureIdentity = Readonly<{
  siteId: string;
  operationRef: string;
  businessOperationKey: string;
  requestDigest: string;
  workerLease: Readonly<{ taskRef: string; leaseEpoch: bigint; leaseTokenHash: string }>;
}>;

export type DirectMediaRootClosureReceipt = Readonly<{
  allocationClosureReceiptRef: string;
  siteId: string;
  operationRef: string;
  businessOperationKey: string;
  requestDigest: string;
  effectClosureReceiptRef: string;
  settlementRef: string;
  executionBudgetRootRef: string;
  rootAllocationRef: string;
  rootHoldRef: string;
  capturedAmount: bigint;
  releasedAmount: bigint;
  unit: string;
  outcome: "completed" | "partial" | "failed" | "canceled";
  executionManifestRef: string;
  authorizationSegmentRef: string;
  authorizationSegmentVersion: bigint;
  settlementClosureRef: string;
  settlementClosureRevision: bigint;
  platformExposureAmount: bigint;
  ratingSnapshotRef: string;
  receiptDigest: string;
  recordedAt: string;
}>;

export type StoredDirectMediaRootClosure = Readonly<{
  siteId: string;
  operationRef: string;
  executionBudgetRootRef: string;
  rootState: "open" | "closing" | "settled" | "reconciliation_required";
  rootVersion: bigint;
  billingAccountId: string;
  creditAccountId: string;
  liabilityMerchantAccountId: string;
  creditHoldRef: string;
  holdState: "open" | "closing" | "settled" | "released" | "expired" | "reconciliation_required";
  holdFenceEpoch: bigint;
  holdReservedAmount: bigint;
  holdCapturedAmount: bigint;
  holdReleasedAmount: bigint;
  rootAllocationRef: string;
  operationBudget: Readonly<{
    executionManifestRef: string;
    rootAllocationRevision: bigint;
    rootAllocationEpoch: bigint;
    authorizationSegmentVersion: bigint;
    reservedCeiling: bigint;
    unit: string;
  }>;
  allocation: BudgetAllocationRevision;
  openChildCount: bigint;
  openSegmentCount: bigint;
  openAttemptCount: bigint;
  settlement: Readonly<{
    settlementRef: string;
    authorizationSegmentRef: string;
    executionBudgetRootRef: string;
    budgetAllocationRef: string;
    creditHoldRef: string;
    unit: string;
    customerAmount: bigint;
    closureRef: string;
    closureRevision: bigint;
    platformExposureAmount: bigint;
    ratingSnapshotRef: string;
  }>;
  holdAllocations: readonly HoldAllocationAvailability[];
}>;

export type DirectMediaRootClosureCommand = Readonly<{
  effectClosureReceiptRef: string;
  outcome: "completed" | "partial" | "failed" | "canceled";
  budget: Readonly<{
    executionBudgetRootRef: string;
    executionManifestRef: string;
    rootHoldRef: string;
    rootAllocationRef: string;
    rootAllocationRevision: bigint;
    rootAllocationEpoch: bigint;
    authorizationSegmentRef: string;
    authorizationSegmentVersion: bigint;
    reservedCeiling: bigint;
    unit: string;
  }>;
  settlement: Readonly<{
    settlementRef: string;
    authorizationSegmentRef: string;
    closureRef: string;
    closureRevision: bigint;
    state: "settled";
    customerAmount: bigint;
    platformExposureAmount: bigint;
  }>;
}>;

export type DirectMediaRootClosureRecord = Readonly<{
  identity: DirectMediaRootClosureIdentity;
  current: StoredDirectMediaRootClosure;
  allocation: BudgetAllocationRevision;
  allocationRevisionRef: string;
  rootState: "settled";
  rootVersion: bigint;
  holdState: "settled" | "released";
  holdFenceEpoch: bigint;
  capturedAmount: bigint;
  releasedAmount: bigint;
  releases: readonly Readonly<{ creditGrantId: string; ordinal: number; amount: bigint }>[];
  releaseJournalTransactionRef: string | null;
  releaseEntriesDigest: string | null;
  command: DirectMediaRootClosureCommand;
  receipt: DirectMediaRootClosureReceipt;
}>;

export type DirectMediaRootClosureLookup =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "conflict"; code: "REQUEST_DIGEST_CONFLICT" }>
  | Readonly<{ kind: "replayed"; value: DirectMediaRootClosureReceipt }>;

export interface DirectMediaRootClosureRepository {
  findClosure(
    transaction: PlatformTransaction,
    identity: DirectMediaRootClosureIdentity,
  ): Promise<DirectMediaRootClosureLookup>;
  lockRootClosure(transaction: PlatformTransaction, input: Readonly<{
    siteId: string;
    operationRef: string;
    executionBudgetRootRef: string;
    rootAllocationRef: string;
    rootHoldRef: string;
    authorizationSegmentRef: string;
    settlementRef: string;
    executionManifestRef: string;
    rootAllocationRevision: bigint;
    rootAllocationEpoch: bigint;
    authorizationSegmentVersion: bigint;
    reservedCeiling: bigint;
    unit: string;
    workerLease: DirectMediaRootClosureIdentity["workerLease"];
  }>): Promise<StoredDirectMediaRootClosure | null>;
  persistClosure(transaction: PlatformTransaction, record: DirectMediaRootClosureRecord): Promise<
    | Readonly<{ kind: "accepted" | "replayed"; value: DirectMediaRootClosureReceipt }>
    | Readonly<{ kind: "conflict"; code: "REQUEST_DIGEST_CONFLICT" }>
  >;
  markReconciliationRequired(transaction: PlatformTransaction, input: Readonly<{
    current: StoredDirectMediaRootClosure;
    reconciliationReceiptRef: string;
    reconciliationAllocationRevisionRef: string;
    workerLease: DirectMediaRootClosureIdentity["workerLease"];
    command: DirectMediaRootClosureCommand;
    businessOperationKey: string;
    requestDigest: string;
    code: string;
    observedAt: string;
  }>): Promise<void>;
}
