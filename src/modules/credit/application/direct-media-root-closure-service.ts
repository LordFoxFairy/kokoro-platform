import { createHash } from "node:crypto";
import {
  deriveDirectMediaRootClosureRequestDigest,
  type DirectMediaRootClosureAuthority,
} from "./media-budget-finalization-service.js";
import type {
  DirectMediaRootClosureIdentity,
  DirectMediaRootClosureReceipt,
  DirectMediaRootClosureRepository,
  StoredDirectMediaRootClosure,
} from "./contracts/direct-media-root-closure-repository.js";
import { rehydrateBudgetAllocationRevision } from "../domain/allocation.js";
import { planHoldRelease } from "../domain/settlement.js";

type ClosureInput = Parameters<DirectMediaRootClosureAuthority["close"]>[1];
type ReferenceKind = "direct-root-closure" | "allocation-revision" | "release-journal" |
  "reconciliation" | "reconciliation-allocation-revision";

/** Credit-owned terminal authority. It consumes a persisted Rating settlement and never prices Media state. */
export class DirectMediaRootClosureService implements DirectMediaRootClosureAuthority {
  readonly #clock: () => Date;
  readonly #reference: (kind: ReferenceKind, stableSeed: string) => string;

  constructor(private readonly dependencies: Readonly<{
    repository: DirectMediaRootClosureRepository;
    clock?: () => Date;
    reference?: (kind: ReferenceKind, stableSeed: string) => string;
  }>) {
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#reference = dependencies.reference ?? stableUuid;
  }

  async close(transaction: Parameters<DirectMediaRootClosureAuthority["close"]>[0], input: ClosureInput) {
    validateInput(input);
    const identity = Object.freeze({ siteId: input.siteId, operationRef: input.operationRef,
      businessOperationKey: input.businessOperationKey,
      requestDigest: input.requestDigest, workerLease: input.workerLease }) satisfies DirectMediaRootClosureIdentity;
    const prior = await this.dependencies.repository.findClosure(transaction, identity);
    if (prior.kind !== "none") return closureOutcome(prior);
    const current = await this.dependencies.repository.lockRootClosure(transaction, {
      siteId: input.siteId, operationRef: input.operationRef,
      executionBudgetRootRef: input.budget.executionBudgetRootRef,
      rootAllocationRef: input.budget.rootAllocationRef, rootHoldRef: input.budget.rootHoldRef,
      authorizationSegmentRef: input.budget.authorizationSegmentRef,
      settlementRef: input.settlement.settlementRef,
      executionManifestRef: input.budget.executionManifestRef,
      rootAllocationRevision: input.budget.rootAllocationRevision,
      rootAllocationEpoch: input.budget.rootAllocationEpoch,
      authorizationSegmentVersion: input.budget.authorizationSegmentVersion,
      reservedCeiling: input.budget.reservedCeiling, unit: input.budget.unit,
      workerLease: input.workerLease,
    });
    const raced = await this.dependencies.repository.findClosure(transaction, identity);
    if (raced.kind !== "none") return closureOutcome(raced);
    if (current === null) return Object.freeze({ kind: "not_found" as const });
    if (current.rootState !== "open" || current.holdState !== "open" || current.allocation.state !== "active") {
      return Object.freeze({ kind: "invalid_state" as const, code: "CREDIT_DIRECT_ROOT_NOT_OPEN" });
    }
    const scopeError = closureScopeError(current, input);
    if (scopeError !== null) return this.#reconcile(transaction, current, input, scopeError);
    const pending = pendingCode(current);
    if (pending !== null) return Object.freeze({ kind: "invalid_state" as const, code: pending });
    if (current.rootVersion === POSTGRES_INT8_MAX || current.holdFenceEpoch === POSTGRES_INT8_MAX ||
        current.allocation.revision === POSTGRES_INT8_MAX ||
        current.allocation.allocationEpoch === POSTGRES_INT8_MAX) {
      return Object.freeze({ kind: "invalid_state" as const, code: "CREDIT_DIRECT_ROOT_FENCE_EXHAUSTED" });
    }
    const releasedAmount = current.allocation.unassignedStock;
    const capturedAmount = current.allocation.capturedCumulative;
    if (capturedAmount !== input.settlement.customerAmount ||
        capturedAmount !== current.settlement.customerAmount || capturedAmount !== current.holdCapturedAmount ||
        capturedAmount + releasedAmount !== input.budget.reservedCeiling ||
        current.holdCapturedAmount + current.holdReleasedAmount + releasedAmount !== current.holdReservedAmount) {
      return this.#reconcile(transaction, current, input, "CREDIT_DIRECT_ROOT_RATING_MISMATCH");
    }
    const holdAllocated = current.holdAllocations.reduce((total, source) => total + source.allocatedAmount, 0n);
    const holdCaptured = current.holdAllocations.reduce((total, source) => total + source.netCustomerAmount, 0n);
    if (holdAllocated !== current.holdReservedAmount || holdCaptured !== capturedAmount) {
      return this.#reconcile(transaction, current, input, "CREDIT_DIRECT_ROOT_HOLD_SOURCE_MISMATCH");
    }
    let releases;
    try { releases = planHoldRelease(current.holdAllocations, releasedAmount); } catch {
      return this.#reconcile(transaction, current, input, "CREDIT_DIRECT_ROOT_HOLD_SOURCE_MISMATCH");
    }
    if (releases.reduce((total, release) => total + release.amount, 0n) !== releasedAmount) {
      return this.#reconcile(transaction, current, input, "CREDIT_DIRECT_ROOT_HOLD_SOURCE_MISMATCH");
    }
    const allocation = rehydrateBudgetAllocationRevision(Object.freeze({
      ...current.allocation,
      revision: current.allocation.revision + 1n,
      allocationEpoch: current.allocation.allocationEpoch + 1n,
      unassignedStock: 0n,
      returnedToParentCumulative: current.allocation.returnedToParentCumulative + releasedAmount,
      state: "terminal" as const,
    }));
    const recordedAt = now(this.#clock());
    const receiptRef = this.#reference("direct-root-closure", input.businessOperationKey);
    const receiptBase = Object.freeze({ allocationClosureReceiptRef: receiptRef,
      siteId: input.siteId, operationRef: input.operationRef,
      businessOperationKey: input.businessOperationKey, requestDigest: input.requestDigest,
      effectClosureReceiptRef: input.effectClosureReceiptRef,
      settlementRef: input.settlement.settlementRef,
      executionBudgetRootRef: input.budget.executionBudgetRootRef,
      rootAllocationRef: input.budget.rootAllocationRef, rootHoldRef: input.budget.rootHoldRef,
      capturedAmount, releasedAmount, unit: input.budget.unit, outcome: input.outcome,
      executionManifestRef: input.budget.executionManifestRef,
      authorizationSegmentRef: input.budget.authorizationSegmentRef,
      authorizationSegmentVersion: input.budget.authorizationSegmentVersion,
      settlementClosureRef: input.settlement.closureRef,
      settlementClosureRevision: input.settlement.closureRevision,
      platformExposureAmount: input.settlement.platformExposureAmount,
      ratingSnapshotRef: current.settlement.ratingSnapshotRef, recordedAt });
    const receipt: DirectMediaRootClosureReceipt = Object.freeze({ ...receiptBase,
      receiptDigest: directRootReceiptDigest(receiptBase) });
    const releaseEntriesDigest = releasedAmount === 0n ? null : digestJournalPostings(current, releases);
    return closureOutcome(await this.dependencies.repository.persistClosure(transaction, Object.freeze({
      identity, current, allocation,
      allocationRevisionRef: this.#reference("allocation-revision", input.businessOperationKey),
      rootState: "settled" as const, rootVersion: current.rootVersion + 1n,
      holdState: capturedAmount === 0n ? "released" as const : "settled" as const,
      holdFenceEpoch: current.holdFenceEpoch + 1n, capturedAmount, releasedAmount,
      releases,
      releaseJournalTransactionRef: releasedAmount === 0n ? null
        : this.#reference("release-journal", input.businessOperationKey),
      releaseEntriesDigest,
      command: closureCommand(input),
      receipt,
    })));
  }

  async #reconcile(
    transaction: Parameters<DirectMediaRootClosureAuthority["close"]>[0],
    current: StoredDirectMediaRootClosure,
    input: ClosureInput,
    code: string,
  ) {
    const reconciliationReceiptRef = this.#reference("reconciliation", input.businessOperationKey);
    await this.dependencies.repository.markReconciliationRequired(transaction, {
      current, reconciliationReceiptRef,
      reconciliationAllocationRevisionRef: this.#reference("reconciliation-allocation-revision",
        input.businessOperationKey),
      workerLease: input.workerLease, command: closureCommand(input),
      businessOperationKey: input.businessOperationKey,
      requestDigest: input.requestDigest, code, observedAt: now(this.#clock()),
    });
    return Object.freeze({ kind: "reconciliation_required" as const, reconciliationReceiptRef, code });
  }
}

function closureCommand(input: ClosureInput) {
  return Object.freeze({ effectClosureReceiptRef: input.effectClosureReceiptRef,
    outcome: input.outcome,
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

function closureScopeError(current: StoredDirectMediaRootClosure, input: ClosureInput): string | null {
  const budget = input.budget;
  const settlement = current.settlement;
  const operationBudget = current.operationBudget;
  if (current.siteId !== input.siteId || current.operationRef !== input.operationRef ||
      current.executionBudgetRootRef !== budget.executionBudgetRootRef ||
      current.creditHoldRef !== budget.rootHoldRef || current.rootAllocationRef !== budget.rootAllocationRef ||
      current.allocation.creditCeiling !== budget.reservedCeiling || current.holdReservedAmount !== budget.reservedCeiling ||
      operationBudget.executionManifestRef !== budget.executionManifestRef ||
      operationBudget.rootAllocationRevision !== budget.rootAllocationRevision ||
      operationBudget.rootAllocationEpoch !== budget.rootAllocationEpoch ||
      operationBudget.authorizationSegmentVersion !== budget.authorizationSegmentVersion ||
      operationBudget.reservedCeiling !== budget.reservedCeiling || operationBudget.unit !== budget.unit ||
      settlement.settlementRef !== input.settlement.settlementRef ||
      settlement.authorizationSegmentRef !== budget.authorizationSegmentRef ||
      settlement.executionBudgetRootRef !== budget.executionBudgetRootRef ||
      settlement.budgetAllocationRef !== budget.rootAllocationRef || settlement.creditHoldRef !== budget.rootHoldRef ||
      settlement.unit !== budget.unit || settlement.closureRef !== input.settlement.closureRef ||
      settlement.closureRevision !== input.settlement.closureRevision ||
      settlement.customerAmount !== input.settlement.customerAmount ||
      settlement.platformExposureAmount !== input.settlement.platformExposureAmount) {
    return "CREDIT_DIRECT_ROOT_AUTHORITY_MISMATCH";
  }
  return null;
}

function closureOutcome(input:
  | Readonly<{ kind: "conflict"; code: "REQUEST_DIGEST_CONFLICT" }>
  | Readonly<{ kind: "reconciliation_required"; reconciliationReceiptRef: string; code: string }>
  | Readonly<{ kind: "accepted" | "replayed"; value: DirectMediaRootClosureReceipt }>) {
  if (input.kind === "conflict" || input.kind === "reconciliation_required") return input;
  return Object.freeze({ kind: input.kind, value: Object.freeze({
    allocationClosureReceiptRef: input.value.allocationClosureReceiptRef,
    capturedAmount: input.value.capturedAmount,
    releasedAmount: input.value.releasedAmount,
  }) });
}

function pendingCode(current: StoredDirectMediaRootClosure): string | null {
  if (current.openChildCount !== 0n || current.allocation.activeChildReservedStock !== 0n) {
    return "CREDIT_DIRECT_ROOT_CHILD_PENDING";
  }
  if (current.openSegmentCount !== 0n || current.allocation.committedStock !== 0n) {
    return "CREDIT_DIRECT_ROOT_SEGMENT_PENDING";
  }
  if (current.openAttemptCount !== 0n) return "CREDIT_DIRECT_ROOT_ATTEMPT_PENDING";
  return null;
}

function validateInput(input: ClosureInput): void {
  [input.siteId, input.operationRef, input.effectClosureReceiptRef, input.businessOperationKey,
    input.budget.executionBudgetRootRef, input.budget.rootAllocationRef, input.budget.rootHoldRef,
    input.budget.authorizationSegmentRef, input.budget.executionManifestRef, input.budget.unit,
    input.workerLease.taskRef, input.settlement.settlementRef,
    input.settlement.authorizationSegmentRef, input.settlement.closureRef].forEach(reference);
  digest(input.requestDigest);
  digest(input.workerLease.leaseTokenHash);
  if (input.budget.kind !== "direct_root" || input.budget.reservedCeiling <= 0n ||
      input.budget.rootAllocationRevision <= 0n || input.budget.rootAllocationEpoch <= 0n ||
      input.budget.authorizationSegmentVersion <= 0n || input.workerLease.leaseEpoch <= 0n ||
      input.settlement.state !== "settled" || input.settlement.closureRevision <= 0n ||
      input.settlement.customerAmount < 0n || input.settlement.platformExposureAmount < 0n) {
    throw new Error("CREDIT_DIRECT_ROOT_CLOSURE_COMMAND_INVALID");
  }
  if (input.requestDigest !== deriveDirectMediaRootClosureRequestDigest(input)) {
    throw new Error("CREDIT_DIRECT_ROOT_REQUEST_DIGEST_INVALID");
  }
}

function stableUuid(kind: ReferenceKind, stableSeed: string): string {
  reference(stableSeed);
  const raw = createHash("sha256").update("kokoro.platform.credit.direct-root-closure.v1\0")
    .update(kind).update("\0").update(stableSeed).digest("hex");
  const variant = ((Number.parseInt(raw[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-7${raw.slice(13, 16)}-${variant}${raw.slice(17, 20)}-${raw.slice(20, 32)}`;
}
function digestJournalPostings(current: StoredDirectMediaRootClosure,
  releases: readonly Readonly<{ creditGrantId: string; ordinal: number; amount: bigint }>[]): string {
  const rows: string[] = [];
  for (const release of releases) {
    for (const [side, accountType] of [["debit", "customer_reserved"],
      ["credit", "customer_available"]] as const) {
      rows.push([rows.length, current.siteId, current.creditAccountId.toLowerCase(),
        current.settlement.unit, side, accountType, release.amount.toString(),
        release.creditGrantId.toLowerCase(), current.creditHoldRef.toLowerCase()].join("|"));
    }
  }
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}
function directRootReceiptDigest(receipt: Omit<DirectMediaRootClosureReceipt, "receiptDigest">): string {
  return framedDigest("kokoro.platform.credit.direct-media-root.receipt.v1", [
    receipt.allocationClosureReceiptRef, receipt.siteId, receipt.operationRef,
    receipt.businessOperationKey, receipt.requestDigest, receipt.effectClosureReceiptRef,
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
  if (!Number.isFinite(value.getTime())) throw new Error("CREDIT_DIRECT_ROOT_CLOCK_INVALID");
  return value.toISOString();
}
function reference(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value)) {
    throw new Error("CREDIT_DIRECT_ROOT_REFERENCE_INVALID");
  }
}
function digest(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("CREDIT_DIRECT_ROOT_DIGEST_INVALID");
}
const POSTGRES_INT8_MAX = 9_223_372_036_854_775_807n;
