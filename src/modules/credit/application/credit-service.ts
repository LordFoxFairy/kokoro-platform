import { randomUUID } from "node:crypto";
import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";
import {
  commitAuthorizationSegment as commitSegment,
  planGrantReservation,
  reconcileUnknownAuthorizationSegment,
  releaseReservedAuthorizationSegment,
} from "../domain/allocation.js";
import { CreditDomainError, type CreditDomainErrorCode } from "../domain/credit-domain-error.js";
import type {
  CreditAuthorityRepository,
  CreditOperationIdentity,
  CreditReferenceKind,
  StoredSegmentAllocation,
} from "./contracts/credit-authority-repository.js";
import type {
  CreditConsumptionScope,
  RunBudgetAuthority,
  ReservedRunBudget,
  SegmentCommand,
  SegmentMutationResult,
} from "./contracts/run-budget-authority.js";
import { MediaChildAllocationService } from "./media-child-allocation-service.js";

export class CreditService implements RunBudgetAuthority {
  readonly #clock: () => Date;
  readonly #reference: (kind: CreditReferenceKind, now: number) => string;
  readonly #mediaChild: MediaChildAllocationService;

  constructor(private readonly dependencies: Readonly<{
    repository: CreditAuthorityRepository;
    clock?: () => Date;
    reference?: (kind: CreditReferenceKind, now: number) => string;
  }>) {
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#reference = dependencies.reference ?? (() => randomUUID());
    this.#mediaChild = new MediaChildAllocationService({
      repository: dependencies.repository,
      clock: this.#clock,
      reference: this.#reference,
    });
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
      consumptionScope: input.consumptionScope,
    });
    let allocations;
    try {
      allocations = planGrantReservation(grants, input.rootCeiling);
    } catch (error) {
      if (error instanceof CreditDomainError && error.code === "CREDIT_INSUFFICIENT_AVAILABLE") {
        return { kind: "insufficient_credit" };
      }
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

  deriveChildAllocation(
    transaction: PlatformTransaction,
    input: Parameters<RunBudgetAuthority["deriveChildAllocation"]>[1],
  ): ReturnType<RunBudgetAuthority["deriveChildAllocation"]> {
    return this.#mediaChild.derive(transaction, input);
  }

  returnChildAllocation(
    transaction: PlatformTransaction,
    input: Parameters<RunBudgetAuthority["returnChildAllocation"]>[1],
  ): ReturnType<RunBudgetAuthority["returnChildAllocation"]> {
    return this.#mediaChild.return(transaction, input);
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
    | Readonly<{ kind: "conflict"; code: "REQUEST_DIGEST_CONFLICT" | "VERSION_CONFLICT" }>
    | Readonly<{ kind: "not_found" }>
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
  validateConsumptionScope(input.consumptionScope);
  [input.siteId, input.billingAccountId, input.creditAccountId, input.unit,
    input.liabilityMerchantAccountId, input.executionRootId, input.authorizationBudgetRef,
    input.ratingPolicyRevisionRef, input.executionManifestRef, input.businessOperationKey]
    .forEach((value) => text(value));
  if (!DIGEST.test(input.requestDigest)) throw new CreditDomainError("CREDIT_REQUEST_DIGEST_INVALID");
  if (input.rootCeiling <= 0n || input.segmentMaximum <= 0n || input.segmentMaximum > input.rootCeiling) {
    throw new CreditDomainError("CREDIT_RESERVATION_AMOUNT_INVALID");
  }
  instant(input.expiresAt);
}

function validateConsumptionScope(scope: CreditConsumptionScope): void {
  const key = /^[a-z0-9][a-z0-9._:-]{0,255}$/u;
  const reference = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
  if (!key.test(scope.surfaceRef) || !key.test(scope.capabilityKey) ||
      (scope.agentRef !== null && !reference.test(scope.agentRef))) {
    throw new CreditDomainError("CREDIT_CONSUMPTION_SCOPE_INVALID");
  }
}

function validateSegmentCommand(input: SegmentCommand): void {
  [input.siteId, input.authorizationSegmentRef, input.executionManifestRef, input.businessOperationKey]
    .forEach((value) => text(value));
  if (!DIGEST.test(input.requestDigest)) throw new CreditDomainError("CREDIT_REQUEST_DIGEST_INVALID");
  if (input.expectedSegmentVersion <= 0n || input.expectedSegmentVersion > POSTGRES_INT8_MAX) {
    throw new CreditDomainError("CREDIT_SEGMENT_VERSION_INVALID");
  }
}

function operationIdentity<const Kind extends CreditOperationIdentity["operationKind"]>(
  operationKind: Kind,
  input: Readonly<{ siteId: string; businessOperationKey: string; requestDigest: string }>,
): Readonly<CreditOperationIdentity & { operationKind: Kind }> {
  return Object.freeze({ operationKind, siteId: input.siteId,
    businessOperationKey: input.businessOperationKey, requestDigest: input.requestDigest });
}

function expectedError(action: () => void): CreditDomainErrorCode | null {
  try { action(); return null; } catch (error) {
    if (error instanceof CreditDomainError) return error.code;
    throw error;
  }
}

function domainOutcome(error: unknown): Readonly<{ kind: "invalid_state"; code: CreditDomainErrorCode }> {
  if (error instanceof CreditDomainError) return { kind: "invalid_state", code: error.code };
  throw error;
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
  if (value.length < 1 || value.length > 256 || hasMalformedUtf16(value)) {
    throw new CreditDomainError("CREDIT_REFERENCE_INVALID");
  }
}

function hasMalformedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function instant(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new CreditDomainError("CREDIT_INSTANT_INVALID");
}

function validReservationWindow(expiresAt: string, now: Date): boolean {
  const expiry = Date.parse(expiresAt);
  const authorityNow = now.getTime();
  return expiry > authorityNow && expiry <= authorityNow + MAX_RESERVATION_TTL_MS;
}

const MAX_RESERVATION_TTL_MS = 15 * 60 * 1_000;
const POSTGRES_INT8_MAX = 9_223_372_036_854_775_807n;
const DIGEST = /^[a-f0-9]{64}$/u;
