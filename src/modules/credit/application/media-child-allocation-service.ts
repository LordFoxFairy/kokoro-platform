import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";
import {
  deriveChildAllocation as deriveChildAllocationRevision,
  deriveMediaChildReturnReason,
  returnChildAllocation as returnChildAllocationRevision,
} from "../domain/allocation.js";
import {
  CreditDomainError,
  type CreditDomainErrorCode,
  type MediaChildInvalidStateCode,
} from "../domain/credit-domain-error.js";
import type {
  CreditAuthorityRepository,
  CreditOperationIdentity,
  CreditOperationValue,
  CreditReferenceKind,
  StoredMediaChildAllocation,
  StoredParentAllocation,
} from "./contracts/credit-authority-repository.js";
import type {
  DerivedMediaChildAllocation,
  MediaChildAllocationOutcome,
  MediaOperationClosureEvidence,
  ReturnedMediaChildAllocation,
  RunBudgetAuthority,
} from "./contracts/run-budget-authority.js";
import {
  snapshotChildDerivation,
  snapshotChildReturn,
  type DeriveMediaChildCommand,
  type ReturnMediaChildCommand,
} from "./media-child-command.js";
import {
  buildDerivedMediaChildReceipt,
  buildReturnedMediaChildReceipt,
  parseDerivedMediaChildReceipt,
  parseReturnedMediaChildReceipt,
} from "./media-child-receipt-codec.js";

export class MediaChildAllocationService {
  constructor(private readonly dependencies: Readonly<{
    repository: CreditAuthorityRepository;
    clock: () => Date;
    reference: (kind: CreditReferenceKind, now: number) => string;
  }>) {}

  async derive(
    transaction: PlatformTransaction,
    rawInput: Parameters<RunBudgetAuthority["deriveChildAllocation"]>[1],
  ): Promise<MediaChildAllocationOutcome<DerivedMediaChildAllocation>> {
    let input: DeriveMediaChildCommand;
    try { input = snapshotChildDerivation(rawInput); } catch (error) {
      return childDomainOutcome(error);
    }
    const operation = operationIdentity("derive_media_child", input);
    const prior = await this.#priorDerived(transaction, operation, input);
    if (prior !== null) return prior;
    const current = await this.dependencies.repository.lockParentAllocation(transaction, {
      siteId: input.siteId,
      executionBudgetRootRef: input.executionBudgetRootRef,
      parentAllocationRef: input.parentAllocationRef,
    });
    const raced = await this.#priorDerived(transaction, operation, input);
    if (raced !== null) return raced;
    if (current === null || !parentLineageMatches(current, input)) return { kind: "not_found" };
    if (!current.isRoot || current.audience !== "root") {
      return { kind: "invalid_state", code: "CREDIT_CHILD_PARENT_NOT_ROOT" };
    }
    if (current.executionBudgetRootState !== "open" || current.creditHoldState !== "open") {
      return { kind: "invalid_state", code: "CREDIT_CHILD_ROOT_NOT_OPEN" };
    }
    if (current.allocation.revision !== input.expectedParentRevision) {
      return { kind: "conflict", code: "PARENT_REVISION_CONFLICT" };
    }
    if (current.allocation.allocationEpoch !== input.expectedParentAllocationEpoch) {
      return { kind: "conflict", code: "PARENT_EPOCH_CONFLICT" };
    }
    if (current.allocation.revision === POSTGRES_INT8_MAX) {
      return { kind: "invalid_state", code: "CREDIT_CHILD_FENCE_EXHAUSTED" };
    }
    const now = this.dependencies.clock();
    if (!validChildExpiry(input.expiresAt, current.creditHoldExpiresAt, now)) {
      return { kind: "invalid_state", code: "CREDIT_CHILD_EXPIRY_INVALID" };
    }
    let revisions;
    try {
      revisions = deriveChildAllocationRevision({
        parent: current.allocation,
        expectedParentRevision: input.expectedParentRevision,
        expectedParentAllocationEpoch: input.expectedParentAllocationEpoch,
        reservedSegmentStock: current.reservedSegmentStock,
        exactCeiling: input.exactCeiling,
      });
    } catch (error) {
      return childDomainOutcome(error);
    }
    const occurredAt = now.toISOString();
    const childAllocationRef = this.dependencies.reference("budget-allocation", now.getTime());
    const receipt = buildDerivedMediaChildReceipt(Object.freeze({
      allocationReservationReceiptRef: this.dependencies.reference("allocation-reservation-receipt", now.getTime()),
      executionBudgetRootRef: input.executionBudgetRootRef,
      parentAllocationRef: input.parentAllocationRef,
      parentRevisionBefore: current.allocation.revision,
      parentRevisionAfter: revisions.parent.revision,
      parentAllocationEpoch: current.allocation.allocationEpoch,
      childAllocationRef,
      childRevisionBefore: 0n as const,
      childRevisionAfter: 1n as const,
      childAllocationEpoch: 1n as const,
      mediaOperationRef: input.mediaOperationRef,
      reservedCeiling: input.exactCeiling,
      audience: input.audience,
      purpose: input.purpose,
      consumptionScope: Object.freeze({ ...input.consumptionScope }),
      expiresAt: input.expiresAt,
      state: "active" as const,
      observedAt: occurredAt,
    }), operation);
    return this.dependencies.repository.createMediaChildAllocation(transaction, Object.freeze({
      operation,
      parent: current,
      parentAllocation: revisions.parent,
      childAllocation: revisions.child,
      childAllocationRevisionRef: this.dependencies.reference("allocation-revision", now.getTime()),
      parentAllocationRevisionRef: this.dependencies.reference("allocation-revision", now.getTime()),
      operationReceiptRef: this.dependencies.reference("operation-receipt", now.getTime()),
      receipt,
      siteId: input.siteId,
      executionBudgetRootRef: input.executionBudgetRootRef,
      parentAllocationRef: input.parentAllocationRef,
      childAllocationRef,
      mediaOperationRef: input.mediaOperationRef,
      audience: input.audience,
      purpose: input.purpose,
      consumptionScope: receipt.consumptionScope,
      expiresAt: input.expiresAt,
      occurredAt,
    }));
  }

  async return(
    transaction: PlatformTransaction,
    rawInput: Parameters<RunBudgetAuthority["returnChildAllocation"]>[1],
  ): Promise<MediaChildAllocationOutcome<ReturnedMediaChildAllocation>> {
    let input: ReturnMediaChildCommand;
    try { input = snapshotChildReturn(rawInput); } catch (error) {
      return childDomainOutcome(error);
    }
    const operation = operationIdentity("return_media_child", input);
    const prior = await this.#priorReturned(transaction, operation, input);
    if (prior !== null) return prior;
    const current = await this.dependencies.repository.lockMediaChildAllocation(transaction, {
      siteId: input.siteId,
      executionBudgetRootRef: input.executionBudgetRootRef,
      parentAllocationRef: input.parentAllocationRef,
      childAllocationRef: input.childAllocationRef,
    });
    const raced = await this.#priorReturned(transaction, operation, input);
    if (raced !== null) return raced;
    if (current === null || !childLineageMatches(current, input)) return { kind: "not_found" };
    if (current.parentAllocation.revision !== input.expectedParentRevision) {
      return { kind: "conflict", code: "PARENT_REVISION_CONFLICT" };
    }
    if (current.parentAllocation.allocationEpoch !== input.expectedParentAllocationEpoch) {
      return { kind: "conflict", code: "PARENT_EPOCH_CONFLICT" };
    }
    if (current.childAllocation.revision !== input.expectedChildRevision) {
      return { kind: "conflict", code: "CHILD_REVISION_CONFLICT" };
    }
    if (current.childAllocation.allocationEpoch !== input.expectedChildAllocationEpoch) {
      return { kind: "conflict", code: "CHILD_EPOCH_CONFLICT" };
    }
    if (current.parentAllocation.revision === POSTGRES_INT8_MAX ||
        current.childAllocation.revision === POSTGRES_INT8_MAX ||
        current.childAllocation.allocationEpoch === POSTGRES_INT8_MAX) {
      return { kind: "invalid_state", code: "CREDIT_CHILD_FENCE_EXHAUSTED" };
    }
    if (input.ownerClosureEvidence.mediaOperationRef !== input.mediaOperationRef ||
        current.mediaOperationRef !== input.mediaOperationRef) {
      return { kind: "invalid_state", code: "CREDIT_CHILD_OWNER_EVIDENCE_MISMATCH" };
    }
    if (current.childAllocation.state === "terminal") {
      const priorReturn = verifiedTerminalPrior(current);
      if (sameOperationIdentity(priorReturn.operation, operation) &&
          sameOwnerClosureEvidence(priorReturn.value.ownerClosureEvidence, input.ownerClosureEvidence)) {
        return { kind: "replayed", value: priorReturn.value };
      }
      return { kind: "closed", code: "ALREADY_RETURNED" };
    }
    const closed = closedChildOutcome(current);
    if (closed !== null) return closed;
    if (current.executionBudgetRootState !== "open" && current.executionBudgetRootState !== "closing") {
      return { kind: "invalid_state", code: "CREDIT_CHILD_ROOT_NOT_RETURNABLE" };
    }
    const now = this.dependencies.clock();
    const occurredAt = now.toISOString();
    const rootStateAtReturn = current.executionBudgetRootState;
    const reason = deriveMediaChildReturnReason({
      rootState: rootStateAtReturn,
      ownerOutcome: input.ownerClosureEvidence.outcome,
      capturedAmount: current.childAllocation.capturedCumulative,
    });
    const receipt = buildReturnedMediaChildReceipt(Object.freeze({
      allocationReturnReceiptRef: this.dependencies.reference("allocation-return-receipt", now.getTime()),
      executionBudgetRootRef: input.executionBudgetRootRef,
      parentAllocationRef: input.parentAllocationRef,
      childAllocationRef: input.childAllocationRef,
      parentRevisionBefore: current.parentAllocation.revision,
      parentRevisionAfter: current.parentAllocation.revision + 1n,
      childRevisionBefore: current.childAllocation.revision,
      childRevisionAfter: current.childAllocation.revision + 1n,
      childAllocationEpochBefore: current.childAllocation.allocationEpoch,
      childAllocationEpochAfter: current.childAllocation.allocationEpoch + 1n,
      returnedAmount: current.childAllocation.unassignedStock,
      capturedAmount: current.childAllocation.capturedCumulative,
      mediaOperationRef: input.mediaOperationRef,
      reason,
      rootStateAtReturn,
      ownerClosureEvidence: input.ownerClosureEvidence,
      parentAllocationEpoch: current.parentAllocation.allocationEpoch,
      state: "terminal" as const,
      observedAt: occurredAt,
    }), operation);
    let revisions;
    try {
      revisions = returnChildAllocationRevision({
        parent: current.parentAllocation,
        child: current.childAllocation,
        expectedParentRevision: input.expectedParentRevision,
        expectedParentAllocationEpoch: input.expectedParentAllocationEpoch,
        expectedChildRevision: input.expectedChildRevision,
        expectedChildAllocationEpoch: input.expectedChildAllocationEpoch,
        receiptDigest: receipt.receiptDigest,
      });
    } catch (error) {
      return childDomainOutcome(error);
    }
    if (receipt.parentRevisionAfter !== revisions.parent.revision ||
        receipt.childRevisionAfter !== revisions.child.revision ||
        receipt.childAllocationEpochAfter !== revisions.child.allocationEpoch) {
      throw new Error("CREDIT_CHILD_RECEIPT_REVISION_MISMATCH");
    }
    return this.dependencies.repository.closeMediaChildAllocation(transaction, Object.freeze({
      operation,
      current,
      parentAllocation: revisions.parent,
      childAllocation: revisions.child,
      childAllocationRevisionRef: this.dependencies.reference("allocation-revision", now.getTime()),
      parentAllocationRevisionRef: this.dependencies.reference("allocation-revision", now.getTime()),
      operationReceiptRef: this.dependencies.reference("operation-receipt", now.getTime()),
      receipt,
      occurredAt,
    }));
  }

  async #priorDerived(
    transaction: PlatformTransaction,
    operation: CreditOperationIdentity,
    input: DeriveMediaChildCommand,
  ): Promise<Readonly<{ kind: "replayed"; value: DerivedMediaChildAllocation }>
    | Readonly<{ kind: "conflict"; code: "REQUEST_DIGEST_CONFLICT" | "PARENT_REVISION_CONFLICT" |
      "PARENT_EPOCH_CONFLICT" }>
    | Readonly<{ kind: "invalid_state"; code: MediaChildInvalidStateCode }> | null> {
    const prior = await this.dependencies.repository.findOperationReceipt(transaction, operation);
    if (prior.kind === "none") return null;
    if (prior.kind === "conflict") return prior;
    if (!isDerivedMediaChildAllocation(prior.value)) throw new Error("CREDIT_OPERATION_RECEIPT_CORRUPT");
    return validateDerivedChildReplay(parseDerivedMediaChildReceipt(prior.value, operation), input);
  }

  async #priorReturned(
    transaction: PlatformTransaction,
    operation: CreditOperationIdentity,
    input: ReturnMediaChildCommand,
  ): Promise<Readonly<{ kind: "replayed"; value: ReturnedMediaChildAllocation }>
    | Readonly<{ kind: "conflict"; code: "REQUEST_DIGEST_CONFLICT" | "PARENT_REVISION_CONFLICT" |
      "PARENT_EPOCH_CONFLICT" | "CHILD_REVISION_CONFLICT" | "CHILD_EPOCH_CONFLICT" }>
    | Readonly<{ kind: "invalid_state"; code: MediaChildInvalidStateCode }> | null> {
    const prior = await this.dependencies.repository.findOperationReceipt(transaction, operation);
    if (prior.kind === "none") return null;
    if (prior.kind === "conflict") return prior;
    if (!isReturnedMediaChildAllocation(prior.value)) throw new Error("CREDIT_OPERATION_RECEIPT_CORRUPT");
    return validateReturnedChildReplay(parseReturnedMediaChildReceipt(prior.value, operation), input);
  }
}

function validateDerivedChildReplay(
  value: DerivedMediaChildAllocation,
  input: DeriveMediaChildCommand,
): Readonly<{ kind: "replayed"; value: DerivedMediaChildAllocation }>
  | Readonly<{ kind: "conflict"; code: "PARENT_REVISION_CONFLICT" | "PARENT_EPOCH_CONFLICT" }>
  | Readonly<{ kind: "invalid_state"; code: "CREDIT_OPERATION_RECEIPT_SCOPE_MISMATCH" }> {
  if (value.parentRevisionBefore !== input.expectedParentRevision) {
    return { kind: "conflict", code: "PARENT_REVISION_CONFLICT" };
  }
  if (value.parentAllocationEpoch !== input.expectedParentAllocationEpoch) {
    return { kind: "conflict", code: "PARENT_EPOCH_CONFLICT" };
  }
  if (value.executionBudgetRootRef !== input.executionBudgetRootRef ||
      value.parentAllocationRef !== input.parentAllocationRef ||
      value.mediaOperationRef !== input.mediaOperationRef ||
      value.reservedCeiling !== input.exactCeiling || value.audience !== input.audience ||
      value.purpose !== input.purpose || value.expiresAt !== input.expiresAt ||
      value.consumptionScope.surfaceRef !== input.consumptionScope.surfaceRef ||
      value.consumptionScope.capabilityKey !== input.consumptionScope.capabilityKey ||
      value.consumptionScope.agentRef !== input.consumptionScope.agentRef) {
    return { kind: "invalid_state", code: "CREDIT_OPERATION_RECEIPT_SCOPE_MISMATCH" };
  }
  return { kind: "replayed", value };
}

function validateReturnedChildReplay(
  value: ReturnedMediaChildAllocation,
  input: ReturnMediaChildCommand,
): Readonly<{ kind: "replayed"; value: ReturnedMediaChildAllocation }>
  | Readonly<{ kind: "conflict"; code: "PARENT_REVISION_CONFLICT" | "PARENT_EPOCH_CONFLICT" |
    "CHILD_REVISION_CONFLICT" | "CHILD_EPOCH_CONFLICT" }>
  | Readonly<{ kind: "invalid_state"; code: MediaChildInvalidStateCode }> {
  if (value.executionBudgetRootRef !== input.executionBudgetRootRef ||
      value.parentAllocationRef !== input.parentAllocationRef || value.childAllocationRef !== input.childAllocationRef ||
      value.mediaOperationRef !== input.mediaOperationRef) {
    return { kind: "invalid_state", code: "CREDIT_OPERATION_RECEIPT_SCOPE_MISMATCH" };
  }
  if (value.parentRevisionBefore !== input.expectedParentRevision) {
    return { kind: "conflict", code: "PARENT_REVISION_CONFLICT" };
  }
  if (value.parentAllocationEpoch !== input.expectedParentAllocationEpoch) {
    return { kind: "conflict", code: "PARENT_EPOCH_CONFLICT" };
  }
  if (value.childRevisionBefore !== input.expectedChildRevision) {
    return { kind: "conflict", code: "CHILD_REVISION_CONFLICT" };
  }
  if (value.childAllocationEpochBefore !== input.expectedChildAllocationEpoch) {
    return { kind: "conflict", code: "CHILD_EPOCH_CONFLICT" };
  }
  if (!sameOwnerClosureEvidence(value.ownerClosureEvidence, input.ownerClosureEvidence)) {
    return { kind: "invalid_state", code: "CREDIT_CHILD_OWNER_EVIDENCE_MISMATCH" };
  }
  return { kind: "replayed", value };
}

function verifiedTerminalPrior(
  current: StoredMediaChildAllocation,
): NonNullable<StoredMediaChildAllocation["priorReturn"]> {
  const prior = current.priorReturn;
  if (prior === null) throw new Error("CREDIT_CHILD_TERMINAL_RECEIPT_MISSING");
  const value = prior.value;
  if (prior.operation.siteId !== current.siteId || prior.operation.operationKind !== "return_media_child" ||
      !DIGEST.test(prior.operation.requestDigest) || value.executionBudgetRootRef !== current.executionBudgetRootRef ||
      value.parentAllocationRef !== current.parentAllocationRef || value.childAllocationRef !== current.childAllocationRef ||
      value.mediaOperationRef !== current.mediaOperationRef ||
      value.ownerClosureEvidence.mediaOperationRef !== current.mediaOperationRef ||
      value.parentRevisionAfter !== current.parentAllocation.revision ||
      value.parentAllocationEpoch !== current.parentAllocation.allocationEpoch ||
      value.childRevisionAfter !== current.childAllocation.revision ||
      value.childAllocationEpochAfter !== current.childAllocation.allocationEpoch ||
      value.returnedAmount !== current.childAllocation.returnedToParentCumulative ||
      value.capturedAmount !== current.childAllocation.capturedCumulative ||
      value.receiptDigest !== current.childAllocation.terminalReceiptDigest ||
      value.parentRevisionAfter !== current.childAllocation.parentAppliedRevision) {
    throw new Error("CREDIT_CHILD_TERMINAL_RECEIPT_MISMATCH");
  }
  return prior;
}

function closedChildOutcome(
  current: StoredMediaChildAllocation,
): MediaChildAllocationOutcome<ReturnedMediaChildAllocation> | null {
  if (current.executionBudgetRootState === "reconciliation_required" ||
      current.creditHoldState === "reconciliation_required") {
    return { kind: "closed", code: "ROOT_RECONCILIATION_REQUIRED" };
  }
  if (current.childAllocation.state === "reconciliation_required" ||
      current.authorizationClosure.reconciliationRequired !== 0n) {
    return { kind: "closed", code: "RECONCILIATION_REQUIRED" };
  }
  if (current.authorizationClosure.ratingPending !== 0n) return { kind: "closed", code: "RATING_PENDING" };
  if (current.childAllocation.committedStock !== 0n || current.authorizationClosure.committed !== 0n) {
    return { kind: "closed", code: "COMMITTED_STOCK_PENDING" };
  }
  if (current.authorizationClosure.reserved !== 0n) return { kind: "closed", code: "RESERVED_AUTHORIZATION_PENDING" };
  if (current.childAllocation.activeChildReservedStock !== 0n) {
    return { kind: "closed", code: "DESCENDANT_ALLOCATION_PENDING" };
  }
  if (current.executionBudgetRootState === "settled" || current.creditHoldState === "settled" ||
      current.creditHoldState === "released" || current.creditHoldState === "expired") {
    return { kind: "invalid_state", code: "CREDIT_CHILD_ROOT_NOT_RETURNABLE" };
  }
  return null;
}

function operationIdentity<const Kind extends CreditOperationIdentity["operationKind"]>(
  operationKind: Kind,
  input: Readonly<{ siteId: string; businessOperationKey: string; requestDigest: string }>,
): Readonly<CreditOperationIdentity & { operationKind: Kind }> {
  return Object.freeze({ operationKind, siteId: input.siteId,
    businessOperationKey: input.businessOperationKey, requestDigest: input.requestDigest });
}

function parentLineageMatches(current: StoredParentAllocation, input: DeriveMediaChildCommand): boolean {
  return current.siteId === input.siteId && current.executionBudgetRootRef === input.executionBudgetRootRef &&
    current.parentAllocationRef === input.parentAllocationRef;
}

function childLineageMatches(current: StoredMediaChildAllocation, input: ReturnMediaChildCommand): boolean {
  return current.siteId === input.siteId && current.executionBudgetRootRef === input.executionBudgetRootRef &&
    current.parentAllocationRef === input.parentAllocationRef && current.childAllocationRef === input.childAllocationRef &&
    current.childAudience === "media" && current.childPurpose === "media_operation";
}

function sameOperationIdentity(left: CreditOperationIdentity, right: CreditOperationIdentity): boolean {
  return left.siteId === right.siteId && left.operationKind === right.operationKind &&
    left.businessOperationKey === right.businessOperationKey && left.requestDigest === right.requestDigest;
}

function sameOwnerClosureEvidence(left: MediaOperationClosureEvidence, right: MediaOperationClosureEvidence): boolean {
  return left.kind === right.kind && left.mediaOperationRef === right.mediaOperationRef &&
    left.terminalReceiptRef === right.terminalReceiptRef && left.outcome === right.outcome;
}

function childDomainOutcome(error: unknown): Readonly<{ kind: "invalid_state"; code: MediaChildInvalidStateCode }> {
  if (error instanceof CreditDomainError && isMediaChildInvalidStateCode(error.code)) {
    return { kind: "invalid_state", code: error.code };
  }
  throw error;
}

function isMediaChildInvalidStateCode(code: CreditDomainErrorCode): code is MediaChildInvalidStateCode {
  return MEDIA_CHILD_INVALID_STATE_CODES.has(code as MediaChildInvalidStateCode);
}

function isDerivedMediaChildAllocation(value: CreditOperationValue): value is DerivedMediaChildAllocation {
  return value.state === "active";
}

function isReturnedMediaChildAllocation(value: CreditOperationValue): value is ReturnedMediaChildAllocation {
  return value.state === "terminal";
}

function validChildExpiry(expiresAt: string, holdExpiresAt: string, now: Date): boolean {
  const expiry = Date.parse(expiresAt);
  return expiry > now.getTime() && expiry <= Date.parse(holdExpiresAt);
}

const DIGEST = /^[a-f0-9]{64}$/u;
const MEDIA_CHILD_INVALID_STATE_CODES = new Set<MediaChildInvalidStateCode>([
  "CREDIT_CHILD_ALLOCATION_CAPACITY_EXCEEDED", "CREDIT_CHILD_ALREADY_TERMINAL",
  "CREDIT_CHILD_CAPTURED_AMOUNT_INVALID", "CREDIT_CHILD_CEILING_INVALID", "CREDIT_CHILD_COMMAND_INVALID",
  "CREDIT_CHILD_FENCE_EXHAUSTED",
  "CREDIT_CHILD_COMMITTED_STOCK_PENDING", "CREDIT_CHILD_DESCENDANT_PENDING", "CREDIT_CHILD_EPOCH_STALE",
  "CREDIT_CHILD_EXPIRY_INVALID", "CREDIT_CHILD_NOT_RETURNABLE", "CREDIT_CHILD_OWNER_EVIDENCE_INVALID",
  "CREDIT_CHILD_OWNER_EVIDENCE_MISMATCH", "CREDIT_CHILD_PARENT_EPOCH_STALE", "CREDIT_CHILD_PARENT_FENCE_INVALID",
  "CREDIT_CHILD_PARENT_NOT_ACTIVE", "CREDIT_CHILD_PARENT_NOT_RETURNABLE", "CREDIT_CHILD_PARENT_NOT_ROOT",
  "CREDIT_CHILD_PARENT_REVISION_STALE", "CREDIT_CHILD_PARENT_STOCK_INVALID", "CREDIT_CHILD_PARTIAL_RETURN_INVALID",
  "CREDIT_CHILD_PURPOSE_INVALID", "CREDIT_CHILD_RECEIPT_DIGEST_INVALID", "CREDIT_CHILD_RECONCILIATION_REQUIRED",
  "CREDIT_CHILD_RESERVED_SEGMENT_STOCK_INVALID", "CREDIT_CHILD_RETURN_FENCE_INVALID", "CREDIT_CHILD_REVISION_STALE",
  "CREDIT_CHILD_ROOT_NOT_OPEN", "CREDIT_CHILD_ROOT_NOT_RETURNABLE", "CREDIT_CONSUMPTION_SCOPE_INVALID",
  "CREDIT_INSTANT_INVALID", "CREDIT_OPERATION_RECEIPT_SCOPE_MISMATCH", "CREDIT_REFERENCE_INVALID",
  "CREDIT_REQUEST_DIGEST_INVALID", "CREDIT_UUID_REFERENCE_INVALID",
]);
const POSTGRES_INT8_MAX = 9_223_372_036_854_775_807n;
