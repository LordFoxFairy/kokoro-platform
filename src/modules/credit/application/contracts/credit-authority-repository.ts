import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type {
  AuthorizationSegmentState,
  BudgetAllocationRevision,
  GrantAvailability,
  PlannedHoldAllocation,
} from "../../domain/allocation.js";
import type {
  CreditAuthorityConflictCode,
  ReservedRunBudget,
  SegmentMutationResult,
} from "./run-budget-authority.js";

export type CreditReferenceKind =
  | "credit-hold"
  | "execution-budget-root"
  | "budget-allocation"
  | "allocation-revision"
  | "authorization-segment"
  | "reserve-journal"
  | "operation-receipt"
  | "outbox-event";

export type CreditOperationKind =
  | "reserve_root"
  | "finalize_segment"
  | "release_segment"
  | "reconcile_segment";

export type CreditOperationIdentity = Readonly<{
  siteId: string;
  operationKind: CreditOperationKind;
  businessOperationKey: string;
  requestDigest: string;
}>;

export type CreditOperationValue = ReservedRunBudget | SegmentMutationResult;
export type CreditOperationReceiptLookup =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "replayed"; value: CreditOperationValue }>
  | Readonly<{ kind: "conflict"; code: "REQUEST_DIGEST_CONFLICT" }>;

export type CreditRepositoryWriteOutcome<T extends CreditOperationValue> =
  | Readonly<{ kind: "accepted"; value: T }>
  | Readonly<{ kind: "replayed"; value: T }>
  | Readonly<{ kind: "conflict"; code: CreditAuthorityConflictCode }>;

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
  allocation: BudgetAllocationRevision;
  segment: AuthorizationSegmentState;
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
}
