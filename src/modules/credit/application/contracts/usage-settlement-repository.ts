import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { StoredSegmentAllocation } from "./credit-authority-repository.js";
import type { AttemptUsageEvidence, RatingPolicyRevision, SegmentAttemptRating, UsageDimension } from "../../domain/usage-rating.js";
import type { HoldAllocationAvailability } from "../../domain/settlement.js";

export type UsageReferenceKind =
  | "attempt-authorization"
  | "allocation-revision"
  | "rating-snapshot"
  | "rated-usage"
  | "usage-settlement"
  | "usage-variance"
  | "usage-journal"
  | "usage-receipt";

export type UsageCommandIdentity = Readonly<{
  siteId: string;
  operationKind: "prepare_attempt" | "attempt_unknown" | "finalize_attempt" | "settle_usage";
  businessOperationKey: string;
  requestDigest: string;
}>;

export type UsageEvidenceReceipt = Readonly<{
  evidenceRef: string;
  revision: bigint;
}>;

export type UsageSettlementReceipt = Readonly<{
  settlementRef: string;
  authorizationSegmentRef: string;
  authorizationSegmentVersion: bigint;
  closureRef: string;
  closureRevision: bigint;
  state: "settled";
  customerAmount: bigint;
  platformExposureAmount: bigint;
}>;

export type UsageAttemptReceipt = Readonly<{
  attemptAuthorizationRef: string;
  state: "effect_committed" | "outcome_unknown";
  fenceEpoch: bigint;
}>;

export type UsageCommandReceiptLookup =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "conflict"; code: "REQUEST_DIGEST_CONFLICT" }>
  | Readonly<{ kind: "replayed"; value: UsageAttemptReceipt | UsageEvidenceReceipt | UsageSettlementReceipt }>;

export type UsageWriteOutcome<T> =
  | Readonly<{ kind: "accepted"; value: T }>
  | Readonly<{ kind: "replayed"; value: T }>
  | Readonly<{ kind: "conflict"; code: "REQUEST_DIGEST_CONFLICT" }>;

export type StoredUsageSettlementContext = StoredSegmentAllocation & Readonly<{
  ratingPolicy: RatingPolicyRevision;
  ratingSnapshotRef: string | null;
}>;

export type StoredAttemptUsageEvidence = Readonly<{
  siteId: string;
  attemptAuthorizationRef: string;
  executionBudgetRootRef: string;
  budgetAllocationRef: string;
  creditHoldRef: string;
  creditAccountId: string;
  unit: string;
  evidenceRef: string;
  businessOperationKey: string;
  requestDigest: string;
  evidence: AttemptUsageEvidence;
  evidenceDigest: string;
  observedAt: string;
}>;

export type PriorUsageSettlement = Readonly<{
  settlementRef: string;
  closureRef: string;
  closureRevision: bigint;
  customerAmount: bigint;
  platformExposureAmount: bigint;
}>;

export type PriorUsageClosure = Readonly<{
  closureRef: string;
  closureRevision: bigint;
}>;

export type StoredUsageAttemptIntent = Readonly<{
  siteId: string;
  executionBudgetRootRef: string;
  budgetAllocationRef: string;
  authorizationSegmentRef: string;
  creditHoldRef: string;
  creditAccountId: string;
  unit: string;
  executionManifestRef: string;
  attemptAuthorizationRef: string;
  producerKind: AttemptUsageEvidence["producerKind"];
  producerContext: string;
  producerGeneration: bigint;
  attemptRef: string;
  logicalEffectRef: string;
  maximumDimensions: readonly UsageDimension[];
  maximumDimensionsDigest: string;
  maximumAmount: bigint;
  provisionalCustomerAmount: bigint | null;
  state: "effect_committed" | "outcome_unknown" | "finalized";
  fenceEpoch: bigint;
  ownerEvidenceRef: string | null;
}>;

export type UsageSourceMutation = Readonly<{
  creditGrantId: string;
  ordinal: number;
  amount: bigint;
  direction: "capture" | "increase" | "decrease";
}>;

export type UsageSettlementRecord = Readonly<{
  identity: UsageCommandIdentity;
  receipt: UsageSettlementReceipt;
  context: StoredUsageSettlementContext;
  allocation?: StoredSegmentAllocation["allocation"];
  ratingPendingSegment?: StoredSegmentAllocation["segment"];
  segment?: StoredSegmentAllocation["segment"];
  closureDigest: string;
  closedAt: string;
  correctionOfClosureRef: string | null;
  priorSettlementRef?: string;
  ratingSnapshotRef: string;
  ratingSnapshotDigest: string;
  evidenceSet: readonly StoredAttemptUsageEvidence[];
  attemptRatings: readonly SegmentAttemptRating[];
  sourceMutations: readonly UsageSourceMutation[];
  policyRatedAmount: bigint;
  customerAmount: bigint;
  platformExposureAmount: bigint;
  settledAt: string;
  journalTransactionRef?: string;
  varianceRef?: string;
  receiptRef: string;
}>;

export type UsageReconciliationRecord = Readonly<{
  identity: UsageCommandIdentity;
  context: StoredUsageSettlementContext;
  closureRef: string;
  closureRevision: bigint;
  closureDigest: string;
  closedAt: string;
  correctionOfClosureRef: string | null;
  evidenceSet: readonly StoredAttemptUsageEvidence[];
  segment?: StoredSegmentAllocation["segment"];
  code: "CREDIT_USAGE_UNAVAILABLE" | "CREDIT_USAGE_REQUIRED_DIMENSION_MISSING";
  observedAt: string;
  receiptRef: string;
}>;

export interface UsageSettlementRepository {
  findCommandReceipt(transaction: PlatformTransaction, identity: UsageCommandIdentity): Promise<UsageCommandReceiptLookup>;
  lockUsageContext(transaction: PlatformTransaction, input: Readonly<{
    siteId: string;
    authorizationSegmentRef: string;
    authority: "producer" | "settlement_owner";
  }>): Promise<StoredUsageSettlementContext | null>;
  loadCommittedAttemptMaximum(transaction: PlatformTransaction, input: Readonly<{
    siteId: string;
    authorizationSegmentRef: string;
  }>): Promise<bigint>;
  persistAttemptIntent(transaction: PlatformTransaction, record: StoredUsageAttemptIntent & Readonly<{
    identity: UsageCommandIdentity;
    receipt: UsageAttemptReceipt;
    receiptRef: string;
    committedAt: string;
  }>): Promise<UsageWriteOutcome<UsageAttemptReceipt>>;
  lockAttemptIntent(transaction: PlatformTransaction, input: Readonly<{
    siteId: string;
    attemptAuthorizationRef: string;
  }>): Promise<StoredUsageAttemptIntent | null>;
  updateAttemptIntent(transaction: PlatformTransaction, record: StoredUsageAttemptIntent & Readonly<{
    identity: UsageCommandIdentity;
    receipt: UsageAttemptReceipt;
    receiptRef: string;
    observedAt: string;
  }>): Promise<UsageWriteOutcome<UsageAttemptReceipt>>;
  lockLatestAttemptEvidence(transaction: PlatformTransaction, input: Readonly<{
    siteId: string;
    authorizationSegmentRef: string;
    producerKind: AttemptUsageEvidence["producerKind"];
    producerContext: string;
    producerGeneration: bigint;
    attemptRef: string;
  }>): Promise<StoredAttemptUsageEvidence | null>;
  persistAttemptUsage(
    transaction: PlatformTransaction,
    record: StoredAttemptUsageEvidence & Readonly<{
      identity: UsageCommandIdentity;
      priorAttemptState: StoredUsageAttemptIntent["state"];
      priorFenceEpoch: bigint;
      nextFenceEpoch: bigint;
      provisionalCustomerAmount: bigint | null;
      receiptRef: string;
    }>,
  ): Promise<UsageWriteOutcome<UsageEvidenceReceipt>>;
  loadClosureEvidence(transaction: PlatformTransaction, input: Readonly<{
    siteId: string;
    authorizationSegmentRef: string;
    evidenceRefs: readonly string[];
  }>): Promise<readonly StoredAttemptUsageEvidence[]>;
  loadOpenAttemptCount(transaction: PlatformTransaction, input: Readonly<{
    siteId: string;
    authorizationSegmentRef: string;
  }>): Promise<bigint>;
  loadPriorSettlement(transaction: PlatformTransaction, input: Readonly<{
    siteId: string;
    authorizationSegmentRef: string;
  }>): Promise<PriorUsageSettlement | null>;
  loadPriorClosure(transaction: PlatformTransaction, input: Readonly<{
    siteId: string;
    authorizationSegmentRef: string;
  }>): Promise<PriorUsageClosure | null>;
  loadHoldAllocationsAfterFinancialLock(transaction: PlatformTransaction, input: Readonly<{
    siteId: string;
    creditHoldRef: string;
  }>): Promise<readonly HoldAllocationAvailability[]>;
  persistSettlement(
    transaction: PlatformTransaction,
    record: UsageSettlementRecord,
  ): Promise<UsageWriteOutcome<UsageSettlementReceipt>>;
  persistReconciliationRequired(
    transaction: PlatformTransaction,
    record: UsageReconciliationRecord,
  ): Promise<Readonly<{ kind: "reconciliation_required"; value: Readonly<{
    authorizationSegmentRef: string;
    code: UsageReconciliationRecord["code"];
  }> }>>;
}
