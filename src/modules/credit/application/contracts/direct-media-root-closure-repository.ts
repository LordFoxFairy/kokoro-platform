import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { BudgetAllocationRevision } from "../../domain/allocation.js";
import type { HoldAllocationAvailability } from "../../domain/settlement.js";

export type DirectMediaRootClosureIdentity = Readonly<{
  siteId: string;
  operationRef: string;
  businessOperationKey: string;
  requestDigest: string;
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
    ratingSnapshotRef: string;
  }>;
  holdAllocations: readonly HoldAllocationAvailability[];
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
  }>): Promise<StoredDirectMediaRootClosure | null>;
  persistClosure(transaction: PlatformTransaction, record: DirectMediaRootClosureRecord): Promise<
    | Readonly<{ kind: "accepted" | "replayed"; value: DirectMediaRootClosureReceipt }>
    | Readonly<{ kind: "conflict"; code: "REQUEST_DIGEST_CONFLICT" }>
  >;
  markReconciliationRequired(transaction: PlatformTransaction, input: Readonly<{
    current: StoredDirectMediaRootClosure;
    reconciliationReceiptRef: string;
    businessOperationKey: string;
    requestDigest: string;
    code: string;
    observedAt: string;
  }>): Promise<void>;
}
