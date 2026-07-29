import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";

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
}

export type SegmentCommand = Readonly<{
  siteId: string;
  authorizationSegmentRef: string;
  executionManifestRef: string;
  expectedSegmentVersion: bigint;
  businessOperationKey: string;
  requestDigest: string;
}>;
