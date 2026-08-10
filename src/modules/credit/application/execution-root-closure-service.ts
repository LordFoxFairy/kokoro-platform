import { createHash } from "node:crypto";
import type {
  ExecutionRootClosureIdentity,
  ExecutionRootClosureReceipt,
  ExecutionRootClosureRepository,
  ExecutionRootOwnerProof,
  StoredExecutionRootClosureContext,
} from "./contracts/execution-root-closure-repository.js";
import {
  ExecutionRootClosureAuthority,
  type StoredExecutionRootClosure,
} from "./execution-root-closure-authority.js";
import { creditJournalEntriesDigest } from "../domain/journal-digest.js";
import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";

export type ExecutionRootClosureRequest = Readonly<{
  siteId: string;
  ownerProof: ExecutionRootOwnerProof;
  budget: Readonly<{
    kind: "direct_root";
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
  businessOperationKey: string;
  requestDigest: string;
}>;

export interface ExecutionRootClosurePort {
  close(transaction: PlatformTransaction, input: ExecutionRootClosureRequest): Promise<
    | Readonly<{ kind: "accepted" | "replayed"; value: Readonly<{
        allocationClosureReceiptRef: string; capturedAmount: bigint; releasedAmount: bigint }> }>
    | Readonly<{ kind: "reconciliation_required" | "conflict" | "not_found" | "invalid_state";
        code?: string; reconciliationReceiptRef?: string }>
  >;
}

type ClosureInput = ExecutionRootClosureRequest;
type ReferenceKind = "execution-root-closure" | "allocation-revision" | "release-journal" |
  "reconciliation" | "reconciliation-allocation-revision";

/** Credit-owned terminal authority. Owner proof is verified before this source-neutral policy is entered. */
export class ExecutionRootClosureService implements ExecutionRootClosurePort {
  readonly #clock: () => Date;
  readonly #reference: (kind: ReferenceKind, stableSeed: string) => string;
  readonly #rootClosure = new ExecutionRootClosureAuthority();

  constructor(private readonly dependencies: Readonly<{
    repository: ExecutionRootClosureRepository;
    clock?: () => Date;
    reference?: (kind: ReferenceKind, stableSeed: string) => string;
  }>) {
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#reference = dependencies.reference ?? stableUuid;
  }

  async close(transaction: PlatformTransaction, input: ClosureInput) {
    validateInput(input);
    const identity = Object.freeze({ siteId: input.siteId, ownerProof: input.ownerProof,
      businessOperationKey: input.businessOperationKey,
      requestDigest: input.requestDigest }) satisfies ExecutionRootClosureIdentity;
    const prior = await this.dependencies.repository.findClosure(transaction, identity);
    if (prior.kind !== "none") return closureOutcome(prior);
    const current = await this.dependencies.repository.lockRootClosure(transaction, {
      identity, budget: input.budget, settlementRef: input.settlement.settlementRef,
    });
    const raced = await this.dependencies.repository.findClosure(transaction, identity);
    if (raced.kind !== "none") return closureOutcome(raced);
    if (current === null) return Object.freeze({ kind: "not_found" as const });
    const decision = this.#rootClosure.decide(toStoredExecutionRoot(current), {
      siteId: input.siteId,
      sourceRef: input.ownerProof.sourceRef,
      budget: input.budget,
      settlement: input.settlement,
    });
    if (decision.kind === "invalid_state") {
      return Object.freeze({ kind: "invalid_state" as const,
        code: `CREDIT_EXECUTION_ROOT_${decision.code}` });
    }
    if (decision.kind === "reconciliation_required") {
      return this.#reconcile(transaction, identity, current, input,
        `CREDIT_EXECUTION_ROOT_${decision.code}`);
    }
    const { allocation, rootState, rootVersion, holdState, holdFenceEpoch,
      capturedAmount, releasedAmount, releases } = decision.value;
    const recordedAt = now(this.#clock());
    const receiptRef = this.#reference("execution-root-closure", input.businessOperationKey);
    const receiptBase = Object.freeze({ allocationClosureReceiptRef: receiptRef,
      siteId: input.siteId, sourceKind: input.ownerProof.kind, sourceRef: input.ownerProof.sourceRef,
      ownerProofDigest: input.ownerProof.proofDigest,
      businessOperationKey: input.businessOperationKey, requestDigest: input.requestDigest,
      terminalEvidenceRef: input.ownerProof.terminalEvidenceRef,
      settlementRef: input.settlement.settlementRef,
      executionBudgetRootRef: input.budget.executionBudgetRootRef,
      rootAllocationRef: input.budget.rootAllocationRef, rootHoldRef: input.budget.rootHoldRef,
      capturedAmount, releasedAmount, unit: input.budget.unit, outcome: input.ownerProof.outcome,
      executionManifestRef: input.budget.executionManifestRef,
      authorizationSegmentRef: input.budget.authorizationSegmentRef,
      authorizationSegmentVersion: input.budget.authorizationSegmentVersion,
      settlementClosureRef: input.settlement.closureRef,
      settlementClosureRevision: input.settlement.closureRevision,
      platformExposureAmount: input.settlement.platformExposureAmount,
      ratingSnapshotRef: current.settlement.ratingSnapshotRef, recordedAt });
    const receipt: ExecutionRootClosureReceipt = Object.freeze({ ...receiptBase,
      receiptDigest: executionRootReceiptDigest(receiptBase) });
    const releaseEntriesDigest = releasedAmount === 0n ? null : digestJournalPostings(current, releases);
    return closureOutcome(await this.dependencies.repository.persistClosure(transaction, Object.freeze({
      identity, current, allocation,
      allocationRevisionRef: this.#reference("allocation-revision", input.businessOperationKey),
      rootState, rootVersion, holdState, holdFenceEpoch, capturedAmount, releasedAmount,
      releases,
      releaseJournalTransactionRef: releasedAmount === 0n ? null
        : this.#reference("release-journal", input.businessOperationKey),
      releaseEntriesDigest,
      command: closureCommand(input),
      receipt,
    })));
  }

  async #reconcile(
    transaction: PlatformTransaction,
    identity: ExecutionRootClosureIdentity,
    current: StoredExecutionRootClosureContext,
    input: ClosureInput,
    code: string,
  ) {
    const reconciliationReceiptRef = this.#reference("reconciliation", input.businessOperationKey);
    await this.dependencies.repository.markReconciliationRequired(transaction, {
      identity, current, reconciliationReceiptRef,
      reconciliationAllocationRevisionRef: this.#reference("reconciliation-allocation-revision",
        input.businessOperationKey),
      command: closureCommand(input), code, observedAt: now(this.#clock()),
    });
    return Object.freeze({ kind: "reconciliation_required" as const, reconciliationReceiptRef, code });
  }
}

function closureCommand(input: ClosureInput) {
  return Object.freeze({ terminalEvidenceRef: input.ownerProof.terminalEvidenceRef,
    outcome: input.ownerProof.outcome,
    budget: Object.freeze({ executionBudgetRootRef: input.budget.executionBudgetRootRef,
      executionManifestRef: input.budget.executionManifestRef,
      rootHoldRef: input.budget.rootHoldRef, rootAllocationRef: input.budget.rootAllocationRef,
      rootAllocationRevision: input.budget.rootAllocationRevision,
      rootAllocationEpoch: input.budget.rootAllocationEpoch,
      authorizationSegmentRef: input.budget.authorizationSegmentRef,
      authorizationSegmentVersion: input.budget.authorizationSegmentVersion,
      reservedCeiling: input.budget.reservedCeiling, unit: input.budget.unit }),
    settlement: Object.freeze({ settlementRef: input.settlement.settlementRef,
      authorizationSegmentRef: input.settlement.authorizationSegmentRef,
      closureRef: input.settlement.closureRef, closureRevision: input.settlement.closureRevision,
      state: input.settlement.state, customerAmount: input.settlement.customerAmount,
      platformExposureAmount: input.settlement.platformExposureAmount }) });
}

function closureOutcome(input:
  | Readonly<{ kind: "conflict"; code: "REQUEST_DIGEST_CONFLICT" }>
  | Readonly<{ kind: "reconciliation_required"; reconciliationReceiptRef: string; code: string }>
  | Readonly<{ kind: "accepted" | "replayed"; value: ExecutionRootClosureReceipt }>) {
  if (input.kind === "conflict" || input.kind === "reconciliation_required") return input;
  return Object.freeze({ kind: input.kind, value: Object.freeze({
    allocationClosureReceiptRef: input.value.allocationClosureReceiptRef,
    capturedAmount: input.value.capturedAmount,
    releasedAmount: input.value.releasedAmount,
  }) });
}

function validateInput(input: ClosureInput): void {
  [input.siteId, input.ownerProof.sourceRef, input.ownerProof.terminalEvidenceRef,
    input.businessOperationKey,
    input.budget.executionBudgetRootRef, input.budget.rootAllocationRef, input.budget.rootHoldRef,
    input.budget.authorizationSegmentRef, input.budget.executionManifestRef, input.budget.unit,
    input.settlement.authorizationSegmentRef, input.settlement.closureRef].forEach(reference);
  digest(input.requestDigest);
  digest(input.ownerProof.proofDigest);
  if (input.budget.kind !== "direct_root" || input.budget.reservedCeiling <= 0n ||
      input.budget.rootAllocationRevision <= 0n || input.budget.rootAllocationEpoch <= 0n ||
      input.budget.authorizationSegmentVersion <= 0n ||
      input.settlement.state !== "settled" || input.settlement.closureRevision <= 0n ||
      input.settlement.customerAmount < 0n || input.settlement.platformExposureAmount < 0n) {
    throw new Error("CREDIT_EXECUTION_ROOT_CLOSURE_COMMAND_INVALID");
  }
  if (input.requestDigest !== deriveExecutionRootClosureRequestDigest(input)) {
    throw new Error("CREDIT_EXECUTION_ROOT_REQUEST_DIGEST_INVALID");
  }
}

function stableUuid(kind: ReferenceKind, stableSeed: string): string {
  reference(stableSeed);
  const raw = createHash("sha256").update("kokoro.platform.credit.execution-root-closure.v1\0")
    .update(kind).update("\0").update(stableSeed).digest("hex");
  const variant = ((Number.parseInt(raw[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-7${raw.slice(13, 16)}-${variant}${raw.slice(17, 20)}-${raw.slice(20, 32)}`;
}
function digestJournalPostings(current: StoredExecutionRootClosureContext,
  releases: readonly Readonly<{ creditGrantId: string; ordinal: number; amount: bigint }>[]): string {
  return creditJournalEntriesDigest(releases.flatMap((release, index) => ([
    { ordinal: index * 2, siteId: current.siteId, creditAccountId: current.creditAccountId,
      unit: current.settlement.unit, side: "debit" as const, accountType: "customer_reserved",
      amount: release.amount, creditGrantId: release.creditGrantId,
      creditHoldRef: current.creditHoldRef },
    { ordinal: index * 2 + 1, siteId: current.siteId, creditAccountId: current.creditAccountId,
      unit: current.settlement.unit, side: "credit" as const, accountType: "customer_available",
      amount: release.amount, creditGrantId: release.creditGrantId,
      creditHoldRef: current.creditHoldRef },
  ])));
}
function executionRootReceiptDigest(receipt: Omit<ExecutionRootClosureReceipt, "receiptDigest">): string {
  return framedDigest("kokoro.platform.credit.execution-root.receipt.v1", [
    receipt.allocationClosureReceiptRef, receipt.siteId, receipt.sourceKind, receipt.sourceRef,
    receipt.ownerProofDigest, receipt.businessOperationKey, receipt.requestDigest,
    receipt.terminalEvidenceRef,
    receipt.settlementRef, receipt.executionBudgetRootRef, receipt.rootAllocationRef,
    receipt.rootHoldRef, receipt.capturedAmount.toString(), receipt.releasedAmount.toString(),
    receipt.unit, receipt.outcome, receipt.executionManifestRef, receipt.authorizationSegmentRef,
    receipt.authorizationSegmentVersion.toString(), receipt.settlementClosureRef,
    receipt.settlementClosureRevision.toString(), receipt.platformExposureAmount.toString(),
    receipt.ratingSnapshotRef, receipt.recordedAt,
  ]);
}
function framedDigest(domain: string, values: readonly string[]): string {
  return createHash("sha256").update([domain, ...values].map((value) =>
    `${Buffer.byteLength(value, "utf8")}:${value}`).join("|")).digest("hex");
}
function now(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new Error("CREDIT_EXECUTION_ROOT_CLOCK_INVALID");
  return value.toISOString();
}
function reference(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value)) {
    throw new Error("CREDIT_EXECUTION_ROOT_REFERENCE_INVALID");
  }
}
function digest(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("CREDIT_EXECUTION_ROOT_DIGEST_INVALID");
}

function toStoredExecutionRoot(current: StoredExecutionRootClosureContext): StoredExecutionRootClosure {
  return Object.freeze({
    siteId: current.siteId,
    sourceRef: current.sourceRef,
    executionBudgetRootRef: current.executionBudgetRootRef,
    rootState: current.rootState,
    rootVersion: current.rootVersion,
    creditHoldRef: current.creditHoldRef,
    holdState: current.holdState,
    holdFenceEpoch: current.holdFenceEpoch,
    holdReservedAmount: current.holdReservedAmount,
    holdCapturedAmount: current.holdCapturedAmount,
    holdReleasedAmount: current.holdReleasedAmount,
    rootAllocationRef: current.rootAllocationRef,
    sourceBudget: current.sourceBudget,
    allocation: current.allocation,
    openChildCount: current.openChildCount,
    openSegmentCount: current.openSegmentCount,
    openAttemptCount: current.openAttemptCount,
    settlement: current.settlement,
    holdAllocations: current.holdAllocations,
  });
}

export function deriveExecutionRootClosureRequestDigest(input: Omit<ClosureInput, "requestDigest"> |
  ClosureInput): string {
  const budget = input.budget;
  const settlement = input.settlement;
  return framedDigest("kokoro.platform.credit.execution-root.request.v1", [
    input.siteId, input.ownerProof.kind, input.ownerProof.sourceRef,
    input.ownerProof.terminalEvidenceRef, input.ownerProof.outcome, input.ownerProof.proofDigest,
    budget.executionBudgetRootRef, budget.executionManifestRef, budget.rootHoldRef,
    budget.rootAllocationRef, budget.rootAllocationRevision.toString(), budget.rootAllocationEpoch.toString(),
    budget.authorizationSegmentRef, budget.authorizationSegmentVersion.toString(),
    budget.reservedCeiling.toString(), budget.unit, settlement.settlementRef,
    settlement.authorizationSegmentRef, settlement.closureRef, settlement.closureRevision.toString(),
    settlement.state, settlement.customerAmount.toString(), settlement.platformExposureAmount.toString(),
  ]);
}
