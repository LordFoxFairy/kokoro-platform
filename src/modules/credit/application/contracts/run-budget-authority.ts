import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { MediaChildReturnReason } from "../../domain/allocation.js";
import type { MediaChildInvalidStateCode } from "../../domain/credit-domain-error.js";

export type ReservedRunBudget = Readonly<{
  executionBudgetRootRef: string;
  creditHoldRef: string;
  authorizationSegmentRef: string;
  segmentVersion: bigint;
  state: "reserved";
  expiresAt: string;
}>;

export type SegmentMutationResult = Readonly<{
  authorizationSegmentRef: string;
  segmentVersion: bigint;
  state: "committed" | "released" | "reconciliation_required";
  observedAt: string;
}>;

export type CreditAuthorityConflictCode = "REQUEST_DIGEST_CONFLICT" | "VERSION_CONFLICT";

export type MediaChildAllocationConflictCode =
  | "REQUEST_DIGEST_CONFLICT"
  | "PARENT_REVISION_CONFLICT"
  | "PARENT_EPOCH_CONFLICT"
  | "CHILD_REVISION_CONFLICT"
  | "CHILD_EPOCH_CONFLICT";

export type CreditAuthorityOutcome<T> =
  | Readonly<{ kind: "accepted"; value: T }>
  | Readonly<{ kind: "replayed"; value: T }>
  | Readonly<{ kind: "conflict"; code: CreditAuthorityConflictCode }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "invalid_state"; code: string }>
  | Readonly<{ kind: "insufficient_credit" }>
  | Readonly<{ kind: "reconciliation_required"; value: SegmentMutationResult }>;

export type CreditConsumptionScope = Readonly<{
  surfaceRef: string;
  capabilityKey: string;
  agentRef: string | null;
}>;

export type MediaChildAllocationPurpose = "media_operation";
export type MediaChildAllocationAudience = "media";

export type MediaOperationClosureEvidence = Readonly<{
  kind: "media_operation_terminal";
  mediaOperationRef: string;
  terminalReceiptRef: string;
  outcome: "completed" | "partial" | "failed" | "canceled";
}>;

export type DerivedMediaChildAllocation = Readonly<{
  allocationReservationReceiptRef: string;
  receiptDigest: string;
  executionBudgetRootRef: string;
  parentAllocationRef: string;
  parentRevisionBefore: bigint;
  parentRevisionAfter: bigint;
  parentAllocationEpoch: bigint;
  childAllocationRef: string;
  childRevisionBefore: 0n;
  childRevisionAfter: 1n;
  childAllocationEpoch: 1n;
  mediaOperationRef: string;
  reservedCeiling: bigint;
  audience: MediaChildAllocationAudience;
  purpose: MediaChildAllocationPurpose;
  consumptionScope: CreditConsumptionScope;
  expiresAt: string;
  state: "active";
  observedAt: string;
}>;

export type ReturnedMediaChildAllocation = Readonly<{
  allocationReturnReceiptRef: string;
  receiptDigest: string;
  executionBudgetRootRef: string;
  parentAllocationRef: string;
  childAllocationRef: string;
  parentRevisionBefore: bigint;
  parentRevisionAfter: bigint;
  parentAllocationEpoch: bigint;
  childRevisionBefore: bigint;
  childRevisionAfter: bigint;
  childAllocationEpochBefore: bigint;
  childAllocationEpochAfter: bigint;
  mediaOperationRef: string;
  returnedAmount: bigint;
  capturedAmount: bigint;
  reason: MediaChildReturnReason;
  rootStateAtReturn: "open" | "closing";
  ownerClosureEvidence: MediaOperationClosureEvidence;
  state: "terminal";
  observedAt: string;
}>;

export type MediaChildAllocationClosedCode =
  | "ALREADY_RETURNED"
  | "RESERVED_AUTHORIZATION_PENDING"
  | "COMMITTED_STOCK_PENDING"
  | "RATING_PENDING"
  | "RECONCILIATION_REQUIRED"
  | "DESCENDANT_ALLOCATION_PENDING"
  | "ROOT_RECONCILIATION_REQUIRED";

export type MediaChildAllocationOutcome<T> =
  | Readonly<{ kind: "accepted"; value: T }>
  | Readonly<{ kind: "replayed"; value: T }>
  | Readonly<{ kind: "conflict"; code: MediaChildAllocationConflictCode }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "invalid_state"; code: MediaChildInvalidStateCode }>
  | Readonly<{ kind: "closed"; code: MediaChildAllocationClosedCode }>;

export interface RunBudgetAuthority {
  reserveRootBudget(transaction: PlatformTransaction, input: Readonly<{
    siteId: string;
    billingAccountId: string;
    creditAccountId: string;
    unit: string;
    liabilityMerchantAccountId: string;
    executionRootId: string;
    authorizationBudgetRef: string;
    ratingPolicyRevisionRef: string;
    executionManifestRef: string;
    consumptionScope: CreditConsumptionScope;
    businessOperationKey: string;
    requestDigest: string;
    rootCeiling: bigint;
    segmentMaximum: bigint;
    expiresAt: string;
  }>): Promise<CreditAuthorityOutcome<ReservedRunBudget>>;

  finalizeAuthorizationSegment(transaction: PlatformTransaction, input: SegmentCommand): Promise<CreditAuthorityOutcome<SegmentMutationResult>>;

  releaseAuthorizationSegment(transaction: PlatformTransaction, input: SegmentCommand & Readonly<{
    noDispatchEvidenceRef: string;
  }>): Promise<CreditAuthorityOutcome<SegmentMutationResult>>;

  reconcileAuthorizationSegment(transaction: PlatformTransaction, input: SegmentCommand & Readonly<{
    ownerEvidence: Readonly<{ kind: "outcome_unknown"; evidenceRef: string }>;
  }>): Promise<CreditAuthorityOutcome<SegmentMutationResult>>;

  deriveChildAllocation(transaction: PlatformTransaction, input: Readonly<{
    siteId: string;
    executionBudgetRootRef: string;
    parentAllocationRef: string;
    expectedParentRevision: bigint;
    expectedParentAllocationEpoch: bigint;
    mediaOperationRef: string;
    businessOperationKey: string;
    requestDigest: string;
    exactCeiling: bigint;
    audience: MediaChildAllocationAudience;
    purpose: MediaChildAllocationPurpose;
    consumptionScope: CreditConsumptionScope;
    expiresAt: string;
  }>): Promise<MediaChildAllocationOutcome<DerivedMediaChildAllocation>>;

  returnChildAllocation(transaction: PlatformTransaction, input: Readonly<{
    siteId: string;
    executionBudgetRootRef: string;
    parentAllocationRef: string;
    childAllocationRef: string;
    expectedParentRevision: bigint;
    expectedParentAllocationEpoch: bigint;
    expectedChildRevision: bigint;
    expectedChildAllocationEpoch: bigint;
    mediaOperationRef: string;
    businessOperationKey: string;
    requestDigest: string;
    ownerClosureEvidence: MediaOperationClosureEvidence;
  }>): Promise<MediaChildAllocationOutcome<ReturnedMediaChildAllocation>>;
}

export type SegmentCommand = Readonly<{
  siteId: string;
  authorizationSegmentRef: string;
  executionManifestRef: string;
  expectedSegmentVersion: bigint;
  businessOperationKey: string;
  requestDigest: string;
}>;
