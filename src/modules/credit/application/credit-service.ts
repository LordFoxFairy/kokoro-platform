import { randomUUID } from "node:crypto";
import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";
import {
  commitAuthorizationSegment as commitSegment,
  planGrantReservation,
  reconcileUnknownAuthorizationSegment,
  releaseReservedAuthorizationSegment,
} from "../domain/allocation.js";
import type {
  CreditAuthorityRepository,
  CreditOperationIdentity,
  CreditReferenceKind,
  StoredSegmentAllocation,
} from "./contracts/credit-authority-repository.js";
import type {
  RunBudgetAuthority,
  ReservedRunBudget,
  SegmentCommand,
  SegmentMutationResult,
} from "./contracts/run-budget-authority.js";

export class CreditService implements RunBudgetAuthority {
  readonly #clock: () => Date;
  readonly #reference: (kind: CreditReferenceKind, now: number) => string;

  constructor(private readonly dependencies: Readonly<{
    repository: CreditAuthorityRepository;
    clock?: () => Date;
    reference?: (kind: CreditReferenceKind, now: number) => string;
  }>) {
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#reference = dependencies.reference ?? (() => randomUUID());
  }

  async reserveRootBudget(
    transaction: PlatformTransaction,
    input: Parameters<RunBudgetAuthority["reserveRootBudget"]>[1],
  ): ReturnType<RunBudgetAuthority["reserveRootBudget"]> {
    const invalid = expectedError(() => validateReservation(input));
    if (invalid !== null) return { kind: "invalid_state", code: invalid };
    const operation = operationIdentity("reserve_root", input);
    const prior = await this.dependencies.repository.findOperationReceipt(transaction, operation);
    if (prior.kind === "conflict") return prior;
    if (prior.kind === "replayed") {
      if (!isReservedRunBudget(prior.value)) throw new Error("CREDIT_OPERATION_RECEIPT_CORRUPT");
      return { kind: "replayed", value: prior.value };
    }
    const now = this.#clock();
    if (!validReservationWindow(input.expiresAt, now)) {
      return { kind: "invalid_state", code: "CREDIT_RESERVATION_EXPIRY_INVALID" };
    }
    const occurredAt = now.toISOString();
    const grants = await this.dependencies.repository.lockGrantAvailability(transaction, {
      siteId: input.siteId,
      billingAccountId: input.billingAccountId,
      creditAccountId: input.creditAccountId,
      unit: input.unit,
      liabilityMerchantAccountId: input.liabilityMerchantAccountId,
      effectiveAt: occurredAt,
    });
    let allocations;
    try {
      allocations = planGrantReservation(grants, input.rootCeiling);
    } catch (error) {
      if (errorCode(error) === "CREDIT_INSUFFICIENT_AVAILABLE") return { kind: "insufficient_credit" };
      throw error;
    }
    return this.dependencies.repository.createRootBudgetReservation(transaction, {
      ...input,
      occurredAt,
      creditHoldRef: this.#reference("credit-hold", now.getTime()),
      executionBudgetRootRef: this.#reference("execution-budget-root", now.getTime()),
      rootAllocationRef: this.#reference("budget-allocation", now.getTime()),
      initialAllocationRevisionRef: this.#reference("allocation-revision", now.getTime()),
      authorizationSegmentRef: this.#reference("authorization-segment", now.getTime()),
      reserveJournalTransactionRef: this.#reference("reserve-journal", now.getTime()),
      operationReceiptRef: this.#reference("operation-receipt", now.getTime()),
      outboxEventRef: this.#reference("outbox-event", now.getTime()),
      allocations,
    });
  }

  async finalizeAuthorizationSegment(
    transaction: PlatformTransaction,
    input: Parameters<RunBudgetAuthority["finalizeAuthorizationSegment"]>[1],
  ): ReturnType<RunBudgetAuthority["finalizeAuthorizationSegment"]> {
    const invalid = expectedError(() => validateSegmentCommand(input));
    if (invalid !== null) return { kind: "invalid_state", code: invalid };
    const operation = operationIdentity("finalize_segment", input);
    const prior = await this.#priorSegmentOperation(transaction, operation);
    if (prior !== null) return prior;
    const loaded = await this.#load(transaction, input, operation);
    if (loaded.kind !== "loaded") return loaded;
    const current = loaded.value;
    if (current.executionBudgetRootState !== "open" || current.creditHoldState !== "open") {
      return { kind: "invalid_state", code: "CREDIT_AUTHORIZATION_ROOT_NOT_OPEN" };
    }
    const observedAt = this.#clock().toISOString();
    if (Date.parse(observedAt) >= Date.parse(current.expiresAt)) {
      return { kind: "invalid_state", code: "CREDIT_SEGMENT_EXPIRED" };
    }
    try {
      const next = Object.freeze({
        ...current,
        ...commitSegment({ allocation: current.allocation, segment: current.segment, committedAt: observedAt }),
      });
      return this.dependencies.repository.commitAuthorizationSegment(transaction, next, operation, observedAt);
    } catch (error) {
      return domainOutcome(error);
    }
  }

  async releaseAuthorizationSegment(
    transaction: PlatformTransaction,
    input: Parameters<RunBudgetAuthority["releaseAuthorizationSegment"]>[1],
  ): ReturnType<RunBudgetAuthority["releaseAuthorizationSegment"]> {
    const invalid = expectedError(() => validateSegmentCommand(input));
    if (invalid !== null) return { kind: "invalid_state", code: invalid };
    const operation = operationIdentity("release_segment", input);
    const prior = await this.#priorSegmentOperation(transaction, operation);
    if (prior !== null) return prior;
    const loaded = await this.#load(transaction, input, operation);
    if (loaded.kind !== "loaded") return loaded;
    const current = loaded.value;
    const observedAt = this.#clock().toISOString();
    try {
      const next = Object.freeze({
        ...current,
        segment: releaseReservedAuthorizationSegment(current.segment, observedAt, input.noDispatchEvidenceRef),
      });
      return this.dependencies.repository.releaseAuthorizationSegment(transaction, next, operation, observedAt);
    } catch (error) {
      return domainOutcome(error);
    }
  }

  async reconcileAuthorizationSegment(
    transaction: PlatformTransaction,
    input: Parameters<RunBudgetAuthority["reconcileAuthorizationSegment"]>[1],
  ): ReturnType<RunBudgetAuthority["reconcileAuthorizationSegment"]> {
    const invalid = expectedError(() => validateSegmentCommand(input));
    if (invalid !== null) return { kind: "invalid_state", code: invalid };
    const operation = operationIdentity("reconcile_segment", input);
    const prior = await this.#priorSegmentOperation(transaction, operation);
    if (prior !== null) return prior;
    const loaded = await this.#load(transaction, input, operation);
    if (loaded.kind !== "loaded") return loaded;
    const current = loaded.value;
    const observedAt = this.#clock().toISOString();
    try {
      const next = Object.freeze({
        ...current,
        segment: reconcileUnknownAuthorizationSegment(
          current.segment,
          input.ownerEvidence.evidenceRef,
          observedAt,
        ),
      });
      return this.dependencies.repository.markAuthorizationSegmentReconciliationRequired(
        transaction, next, operation, observedAt,
      );
    } catch (error) {
      return domainOutcome(error);
    }
  }

  async #priorSegmentOperation(transaction: PlatformTransaction, operation: CreditOperationIdentity): Promise<
    | Readonly<{ kind: "replayed"; value: SegmentMutationResult }>
    | Readonly<{ kind: "conflict"; code: "REQUEST_DIGEST_CONFLICT" }>
    | null
  > {
    const prior = await this.dependencies.repository.findOperationReceipt(transaction, operation);
    if (prior.kind === "none") return null;
    if (prior.kind === "conflict") return prior;
    if (!isSegmentMutationResult(prior.value)) throw new Error("CREDIT_OPERATION_RECEIPT_CORRUPT");
    return { kind: "replayed", value: prior.value };
  }

  async #load(transaction: PlatformTransaction, input: SegmentCommand, operation: CreditOperationIdentity): Promise<
    | Readonly<{ kind: "loaded"; value: StoredSegmentAllocation }>
    | Readonly<{ kind: "replayed"; value: SegmentMutationResult }>
    | Readonly<{ kind: "conflict"; code: "REQUEST_DIGEST_CONFLICT" }>
    | Readonly<{ kind: "not_found" }>
    | Readonly<{ kind: "conflict"; code: "VERSION_CONFLICT" }>
    | Readonly<{ kind: "invalid_state"; code: string }>
  > {
    const current = await this.dependencies.repository.lockSegmentAllocation(transaction, {
      siteId: input.siteId,
      authorizationSegmentRef: input.authorizationSegmentRef,
    });
    const raced = await this.#priorSegmentOperation(transaction, operation);
    if (raced !== null) return raced;
    if (current === null) return { kind: "not_found" };
    if (current.executionManifestRef !== input.executionManifestRef) {
      return { kind: "invalid_state", code: "CREDIT_SEGMENT_MANIFEST_MISMATCH" };
    }
    if (current.segment.aggregateVersion !== input.expectedSegmentVersion) {
      return { kind: "conflict", code: "VERSION_CONFLICT" };
    }
    return { kind: "loaded", value: current };
  }
}

function validateReservation(input: Parameters<RunBudgetAuthority["reserveRootBudget"]>[1]): void {
  [input.siteId, input.billingAccountId, input.creditAccountId, input.unit,
    input.liabilityMerchantAccountId, input.executionRootId, input.authorizationBudgetRef,
    input.ratingPolicyRevisionRef, input.executionManifestRef, input.businessOperationKey]
    .forEach((value) => text(value));
  if (!/^[a-f0-9]{64}$/u.test(input.requestDigest)) throw new Error("CREDIT_REQUEST_DIGEST_INVALID");
  if (input.rootCeiling <= 0n || input.segmentMaximum <= 0n || input.segmentMaximum > input.rootCeiling) {
    throw new Error("CREDIT_RESERVATION_AMOUNT_INVALID");
  }
  instant(input.expiresAt);
}

function validateSegmentCommand(input: SegmentCommand): void {
  [input.siteId, input.authorizationSegmentRef, input.executionManifestRef, input.businessOperationKey]
    .forEach((value) => text(value));
  if (!/^[a-f0-9]{64}$/u.test(input.requestDigest)) throw new Error("CREDIT_REQUEST_DIGEST_INVALID");
  if (input.expectedSegmentVersion <= 0n) throw new Error("CREDIT_SEGMENT_VERSION_INVALID");
}

function operationIdentity(
  operationKind: CreditOperationIdentity["operationKind"],
  input: Readonly<{ siteId: string; businessOperationKey: string; requestDigest: string }>,
): CreditOperationIdentity {
  return Object.freeze({ operationKind, siteId: input.siteId,
    businessOperationKey: input.businessOperationKey, requestDigest: input.requestDigest });
}

function expectedError(action: () => void): string | null {
  try { action(); return null; } catch (error) { return errorCode(error); }
}

function domainOutcome(error: unknown): Readonly<{ kind: "invalid_state"; code: string }> {
  const code = errorCode(error);
  if (code.startsWith("CREDIT_")) return { kind: "invalid_state", code };
  throw error;
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : "CREDIT_UNKNOWN_ERROR";
}

function isReservedRunBudget(value: unknown): value is ReservedRunBudget {
  return typeof value === "object" && value !== null && "state" in value && value.state === "reserved" &&
    "executionBudgetRootRef" in value;
}

function isSegmentMutationResult(value: unknown): value is SegmentMutationResult {
  return typeof value === "object" && value !== null && "state" in value &&
    (value.state === "committed" || value.state === "released" || value.state === "reconciliation_required") &&
    "authorizationSegmentRef" in value;
}

function text(value: string): void {
  if (value.length < 1 || value.length > 256) throw new Error("CREDIT_REFERENCE_INVALID");
}

function instant(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error("CREDIT_INSTANT_INVALID");
}

const MAX_RESERVATION_TTL_MS = 15 * 60 * 1_000;

function validReservationWindow(expiresAt: string, now: Date): boolean {
  const expiry = Date.parse(expiresAt);
  const authorityNow = now.getTime();
  return expiry > authorityNow && expiry <= authorityNow + MAX_RESERVATION_TTL_MS;
}
