import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type {
  AuthorizationSegmentState,
  BudgetAllocationRevision,
  ChildAllocationRevision,
  GrantAvailability,
  PlannedHoldAllocation,
} from "../../domain/allocation.js";
import type {
  CreditAuthorityConflictCode,
  CreditConsumptionScope,
  DerivedMediaChildAllocation,
  MediaChildAllocationConflictCode,
  ReservedRunBudget,
  ReturnedMediaChildAllocation,
  SegmentMutationResult,
} from "./run-budget-authority.js";

export type CreditReferenceKind =
  | "credit-hold"
  | "execution-budget-root"
  | "budget-allocation"
  | "allocation-revision"
  | "allocation-reservation-receipt"
  | "allocation-return-receipt"
  | "authorization-segment"
  | "reserve-journal"
  | "operation-receipt"
  | "outbox-event";

export type CreditOperationKind =
  | "reserve_root"
  | "finalize_segment"
  | "release_segment"
  | "reconcile_segment"
  | "derive_media_child"
  | "return_media_child";

export type CreditOperationIdentity = Readonly<{
  siteId: string;
  operationKind: CreditOperationKind;
  businessOperationKey: string;
  requestDigest: string;
}>;

export type CreditOperationValue = ReservedRunBudget | SegmentMutationResult
  | DerivedMediaChildAllocation | ReturnedMediaChildAllocation;
export type CreditOperationReceiptLookup =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "replayed"; value: CreditOperationValue }>
  | Readonly<{ kind: "conflict"; code: "REQUEST_DIGEST_CONFLICT" }>;

export type CreditRepositoryWriteOutcome<T extends CreditOperationValue> =
  | Readonly<{ kind: "accepted"; value: T }>
  | Readonly<{ kind: "replayed"; value: T }>
  | Readonly<{ kind: "conflict"; code: Extract<
    CreditAuthorityConflictCode | MediaChildAllocationConflictCode,
    "REQUEST_DIGEST_CONFLICT"
  > }>;

export type RootBudgetReservationRecord = Readonly<{
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
  occurredAt: string;
  creditHoldRef: string;
  executionBudgetRootRef: string;
  rootAllocationRef: string;
  initialAllocationRevisionRef: string;
  authorizationSegmentRef: string;
  reserveJournalTransactionRef: string;
  operationReceiptRef: string;
  outboxEventRef: string;
  allocations: readonly PlannedHoldAllocation[];
}>;

export type StoredSegmentAllocation = Readonly<{
  siteId: string;
  billingAccountId: string;
  creditAccountId: string;
  unit: string;
  liabilityMerchantAccountId: string;
  ratingPolicyRevisionRef: string;
  executionBudgetRootRef: string;
  executionBudgetRootState: "open" | "closing" | "settled" | "reconciliation_required";
  executionBudgetRootVersion: bigint;
  creditHoldRef: string;
  creditHoldState: "open" | "closing" | "settled" | "released" | "expired" | "reconciliation_required";
  creditHoldFenceEpoch: bigint;
  budgetAllocationRef: string;
  authorizationSegmentRef: string;
  executionManifestRef: string;
  consumptionScope: CreditConsumptionScope;
  expiresAt: string;
  allocation: BudgetAllocationRevision;
  segment: AuthorizationSegmentState;
}>;

export type CreditAllocationAudience =
  | "root"
  | "model_gateway"
  | "capability_runtime"
  | "media"
  | "agent_team"
  | "target_runtime";

export type StoredParentAllocation = Readonly<{
  siteId: string;
  billingAccountId: string;
  creditAccountId: string;
  unit: string;
  liabilityMerchantAccountId: string;
  executionBudgetRootRef: string;
  executionBudgetRootState: StoredSegmentAllocation["executionBudgetRootState"];
  creditHoldRef: string;
  creditHoldState: StoredSegmentAllocation["creditHoldState"];
  creditHoldExpiresAt: string;
  parentAllocationRef: string;
  isRoot: boolean;
  audience: CreditAllocationAudience;
  reservedSegmentStock: bigint;
  allocation: BudgetAllocationRevision;
}>;

export type StoredMediaChildAllocation = Readonly<{
  siteId: string;
  billingAccountId: string;
  creditAccountId: string;
  unit: string;
  liabilityMerchantAccountId: string;
  executionBudgetRootRef: string;
  executionBudgetRootState: StoredSegmentAllocation["executionBudgetRootState"];
  creditHoldRef: string;
  creditHoldState: StoredSegmentAllocation["creditHoldState"];
  creditHoldExpiresAt: string;
  parentAllocationRef: string;
  parentAllocation: BudgetAllocationRevision;
  childAllocationRef: string;
  childAudience: "media";
  childPurpose: "media_operation";
  mediaOperationRef: string;
  consumptionScope: CreditConsumptionScope;
  expiresAt: string;
  childAllocation: ChildAllocationRevision;
  authorizationClosure: Readonly<{
    reserved: bigint;
    committed: bigint;
    ratingPending: bigint;
    reconciliationRequired: bigint;
  }>;
  priorReturn: Readonly<{
    operation: CreditOperationIdentity & Readonly<{ operationKind: "return_media_child" }>;
    value: ReturnedMediaChildAllocation;
  }> | null;
}>;

export type MediaChildAllocationReservationRecord = Readonly<{
  operation: CreditOperationIdentity & Readonly<{ operationKind: "derive_media_child" }>;
  parent: StoredParentAllocation;
  parentAllocation: BudgetAllocationRevision;
  childAllocation: ChildAllocationRevision;
  childAllocationRevisionRef: string;
  parentAllocationRevisionRef: string;
  operationReceiptRef: string;
  receipt: DerivedMediaChildAllocation;
  siteId: string;
  executionBudgetRootRef: string;
  parentAllocationRef: string;
  childAllocationRef: string;
  mediaOperationRef: string;
  audience: "media";
  purpose: "media_operation";
  consumptionScope: CreditConsumptionScope;
  expiresAt: string;
  occurredAt: string;
}>;

export type MediaChildAllocationReturnRecord = Readonly<{
  operation: CreditOperationIdentity & Readonly<{ operationKind: "return_media_child" }>;
  current: StoredMediaChildAllocation;
  parentAllocation: BudgetAllocationRevision;
  childAllocation: ChildAllocationRevision;
  childAllocationRevisionRef: string;
  parentAllocationRevisionRef: string;
  operationReceiptRef: string;
  receipt: ReturnedMediaChildAllocation;
  occurredAt: string;
}>;

export interface CreditAuthorityRepository {
  findOperationReceipt(
    transaction: PlatformTransaction,
    identity: CreditOperationIdentity,
  ): Promise<CreditOperationReceiptLookup>;

  lockGrantAvailability(transaction: PlatformTransaction, input: Readonly<{
    siteId: string;
    billingAccountId: string;
    creditAccountId: string;
    unit: string;
    liabilityMerchantAccountId: string;
    effectiveAt: string;
    consumptionScope: CreditConsumptionScope;
  }>): Promise<readonly GrantAvailability[]>;

  createRootBudgetReservation(
    transaction: PlatformTransaction,
    record: RootBudgetReservationRecord,
  ): Promise<CreditRepositoryWriteOutcome<ReservedRunBudget>>;

  lockSegmentAllocation(transaction: PlatformTransaction, input: Readonly<{
    siteId: string;
    authorizationSegmentRef: string;
  }>): Promise<StoredSegmentAllocation | null>;

  commitAuthorizationSegment(
    transaction: PlatformTransaction,
    record: StoredSegmentAllocation,
    operation: CreditOperationIdentity,
    observedAt: string,
  ): Promise<CreditRepositoryWriteOutcome<SegmentMutationResult>>;

  releaseAuthorizationSegment(
    transaction: PlatformTransaction,
    record: StoredSegmentAllocation,
    operation: CreditOperationIdentity,
    observedAt: string,
  ): Promise<CreditRepositoryWriteOutcome<SegmentMutationResult>>;

  markAuthorizationSegmentReconciliationRequired(
    transaction: PlatformTransaction,
    record: StoredSegmentAllocation,
    operation: CreditOperationIdentity,
    observedAt: string,
  ): Promise<CreditRepositoryWriteOutcome<SegmentMutationResult> | Readonly<{
    kind: "reconciliation_required";
    value: SegmentMutationResult;
  }>>;

  lockParentAllocation(transaction: PlatformTransaction, input: Readonly<{
    siteId: string;
    executionBudgetRootRef: string;
    parentAllocationRef: string;
  }>): Promise<StoredParentAllocation | null>;

  createMediaChildAllocation(
    transaction: PlatformTransaction,
    record: MediaChildAllocationReservationRecord,
  ): Promise<CreditRepositoryWriteOutcome<DerivedMediaChildAllocation>>;

  lockMediaChildAllocation(transaction: PlatformTransaction, input: Readonly<{
    siteId: string;
    executionBudgetRootRef: string;
    parentAllocationRef: string;
    childAllocationRef: string;
  }>): Promise<StoredMediaChildAllocation | null>;

  closeMediaChildAllocation(
    transaction: PlatformTransaction,
    record: MediaChildAllocationReturnRecord,
  ): Promise<CreditRepositoryWriteOutcome<ReturnedMediaChildAllocation>>;
}
