import { createHash } from "node:crypto";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { BudgetAllocationRevision } from "../../domain/allocation.js";
import type { HoldAllocationAvailability } from "../../domain/settlement.js";

declare const VERIFIED_OWNER_PROOF: unique symbol;

type VerifiedProofBrand = Readonly<{ [VERIFIED_OWNER_PROOF]: true }>;

export type MediaExecutionRootOwnerProof = Readonly<{
  kind: "media_operation";
  sourceRef: string;
  terminalEvidenceRef: string;
  outcome: "completed" | "partial" | "failed" | "canceled";
  proofDigest: string;
  workerLease: Readonly<{ taskRef: string; leaseEpoch: bigint; leaseTokenHash: string }>;
}> & VerifiedProofBrand;

export type AdmissionExecutionRootOwnerProof = Readonly<{
  kind: "admission_run";
  sourceRef: string;
  terminalEvidenceRef: string;
  terminalEvidenceDigest: string;
  outcome: "completed" | "failed";
  proofDigest: string;
  manifestRef: string;
  sessionId: string;
  launchId: string;
}> & VerifiedProofBrand;

export type ExecutionRootOwnerProof = MediaExecutionRootOwnerProof | AdmissionExecutionRootOwnerProof;

export type ExecutionRootClosureIdentity = Readonly<{
  siteId: string;
  ownerProof: ExecutionRootOwnerProof;
  businessOperationKey: string;
  requestDigest: string;
}>;

export type ExecutionRootClosureReceipt = Readonly<{
  allocationClosureReceiptRef: string;
  siteId: string;
  sourceKind: ExecutionRootOwnerProof["kind"];
  sourceRef: string;
  ownerProofDigest: string;
  businessOperationKey: string;
  requestDigest: string;
  terminalEvidenceRef: string;
  settlementRef: string;
  executionBudgetRootRef: string;
  rootAllocationRef: string;
  rootHoldRef: string;
  capturedAmount: bigint;
  releasedAmount: bigint;
  unit: string;
  outcome: ExecutionRootOwnerProof["outcome"];
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

export type StoredExecutionRootClosureContext = Readonly<{
  siteId: string;
  sourceKind: ExecutionRootOwnerProof["kind"];
  sourceRef: string;
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
  sourceBudget: Readonly<{
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

export type ExecutionRootClosureCommand = Readonly<{
  terminalEvidenceRef: string;
  outcome: ExecutionRootOwnerProof["outcome"];
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

export type ExecutionRootClosureRecord = Readonly<{
  identity: ExecutionRootClosureIdentity;
  current: StoredExecutionRootClosureContext;
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
  command: ExecutionRootClosureCommand;
  receipt: ExecutionRootClosureReceipt;
}>;

export type ExecutionRootClosureLookup =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "conflict"; code: "REQUEST_DIGEST_CONFLICT" }>
  | Readonly<{ kind: "reconciliation_required"; reconciliationReceiptRef: string; code: string }>
  | Readonly<{ kind: "replayed"; value: ExecutionRootClosureReceipt }>;

export interface ExecutionRootClosureRepository {
  findClosure(transaction: PlatformTransaction,
    identity: ExecutionRootClosureIdentity): Promise<ExecutionRootClosureLookup>;
  lockRootClosure(transaction: PlatformTransaction, input: Readonly<{
    identity: ExecutionRootClosureIdentity;
    budget: ExecutionRootClosureCommand["budget"];
    settlementRef: string;
  }>): Promise<StoredExecutionRootClosureContext | null>;
  persistClosure(transaction: PlatformTransaction, record: ExecutionRootClosureRecord): Promise<
    | Readonly<{ kind: "accepted" | "replayed"; value: ExecutionRootClosureReceipt }>
    | Readonly<{ kind: "conflict"; code: "REQUEST_DIGEST_CONFLICT" }>
  >;
  markReconciliationRequired(transaction: PlatformTransaction, input: Readonly<{
    identity: ExecutionRootClosureIdentity;
    current: StoredExecutionRootClosureContext;
    reconciliationReceiptRef: string;
    reconciliationAllocationRevisionRef: string;
    command: ExecutionRootClosureCommand;
    code: string;
    observedAt: string;
  }>): Promise<void>;
}

export function verifyMediaExecutionRootOwnerProof(input: Readonly<{
  sourceRef: string;
  terminalEvidenceRef: string;
  outcome: MediaExecutionRootOwnerProof["outcome"];
  workerLease: MediaExecutionRootOwnerProof["workerLease"];
}>): MediaExecutionRootOwnerProof {
  [input.sourceRef, input.terminalEvidenceRef, input.workerLease.taskRef].forEach(ownerReference);
  ownerDigest(input.workerLease.leaseTokenHash);
  if (input.workerLease.leaseEpoch <= 0n) throw new Error("CREDIT_MEDIA_ROOT_OWNER_PROOF_INVALID");
  const proofDigest = framedOwnerDigest("kokoro.platform.credit.owner-proof.media.v1", [
    input.sourceRef, input.terminalEvidenceRef, input.outcome, input.workerLease.taskRef,
    input.workerLease.leaseEpoch.toString(), input.workerLease.leaseTokenHash,
  ]);
  return Object.freeze({ kind: "media_operation" as const, ...input, proofDigest }) as
    MediaExecutionRootOwnerProof;
}

export function verifyAdmissionExecutionRootOwnerProof(input: Readonly<{
  sourceRef: string;
  terminalEvidenceRef: string;
  terminalEvidenceDigest: string;
  outcome: AdmissionExecutionRootOwnerProof["outcome"];
  manifestRef: string;
  sessionId: string;
  launchId: string;
}>): AdmissionExecutionRootOwnerProof {
  [input.sourceRef, input.terminalEvidenceRef, input.manifestRef, input.sessionId, input.launchId]
    .forEach(ownerReference);
  ownerDigest(input.terminalEvidenceDigest);
  const proofDigest = framedOwnerDigest("kokoro.platform.credit.owner-proof.admission.v1", [
    input.sourceRef, input.terminalEvidenceRef, input.terminalEvidenceDigest, input.outcome, input.manifestRef,
    input.sessionId, input.launchId,
  ]);
  return Object.freeze({ kind: "admission_run" as const, ...input, proofDigest }) as
    AdmissionExecutionRootOwnerProof;
}

function framedOwnerDigest(domain: string, values: readonly string[]): string {
  return createHash("sha256").update([domain, ...values]
    .map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`).join("|")).digest("hex");
}

function ownerReference(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value)) {
    throw new Error("CREDIT_EXECUTION_ROOT_OWNER_REFERENCE_INVALID");
  }
}

function ownerDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("CREDIT_EXECUTION_ROOT_OWNER_DIGEST_INVALID");
}
