import { createHash } from "node:crypto";
import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";
import type { AttemptUsageEvidence, UsageAttemptOutcome, UsageDimension } from "../domain/usage-rating.js";
import type { UsageSettlementService } from "./usage-settlement-service.js";
import type { CreditAuthorityRepository } from "./contracts/credit-authority-repository.js";
import type { RunBudgetAuthority } from "./contracts/run-budget-authority.js";

export type CreditMediaBudgetBinding = Readonly<{
  kind: "agent_child";
  executionBudgetRootRef: string;
  executionManifestRef: string;
  parentAllocationRef: string;
  childAllocationRef: string;
  allocationReservationReceiptRef: string;
  authorizationSegmentRef: string;
  authorizationSegmentVersion: bigint;
  reservedCeiling: bigint;
  unit: string;
}> | Readonly<{
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

export type CreditMediaTypedUsageFact = Readonly<{
  evidenceKind: "measured";
  dimensions: readonly UsageDimension[];
  attemptOutcome: UsageAttemptOutcome;
  occurredAt: string;
  sourceDigest: string;
}> | Readonly<{
  evidenceKind: "zero";
  dimensions: readonly [];
  attemptOutcome: UsageAttemptOutcome;
  occurredAt: string;
  sourceDigest: string;
}> | Readonly<{
  evidenceKind: "unavailable";
  dimensions: readonly [];
  attemptOutcome: UsageAttemptOutcome;
  occurredAt: string;
  sourceDigest: string;
  unavailableReason: "provider_usage_missing" | "provider_usage_ambiguous" | "producer_integrity_failure";
}>;

export type CreditMediaAttempt = Readonly<{
  attemptAuthorizationRef: string;
  attemptAuthorizationFenceEpoch: bigint;
  attemptAuthorizationDigest: string;
  usageEvidenceRef: string;
  usageEvidenceDigest: string;
  producerKind: "model_gateway";
  producerContext: string;
  producerGeneration: bigint;
  attemptRef: string;
  logicalEffectRef: string;
  fact: CreditMediaTypedUsageFact;
}>;

export type CreditMediaFinancialClosure = Readonly<{
  kind: "settled";
  financialReceiptRef: string;
  allocationClosureReceiptRef: string;
  usageSettlementReceiptRef: string;
  actualCost: string;
  releasedCredit: string;
  unit: string;
}> | Readonly<{
  kind: "reconciliation_required";
  reconciliationReceiptRef: string;
  code: string;
}>;

export type CreditMediaUsageOwner = Pick<UsageSettlementService, "finalizeAttempt" | "settleUsageSegment">;

type Accepted<T> = Readonly<{ kind: "accepted"; value: T }> | Readonly<{ kind: "replayed"; value: T }>;

type UsageSettlementOutcome = Awaited<ReturnType<UsageSettlementService["settleUsageSegment"]>>;
type UsageSettlement = Extract<UsageSettlementOutcome, { kind: "accepted" | "replayed" }>["value"];

export type CreditMediaWorkerLease = Readonly<{
  taskRef: string;
  leaseEpoch: bigint;
  leaseTokenHash: string;
}>;

export interface DirectMediaRootClosureAuthority {
  close(transaction: PlatformTransaction, input: Readonly<{
    siteId: string;
    operationRef: string;
    workerLease: CreditMediaWorkerLease;
    budget: Extract<CreditMediaBudgetBinding, { kind: "direct_root" }>;
    effectClosureReceiptRef: string;
    outcome: "completed" | "partial" | "failed" | "canceled";
    settlement: UsageSettlement;
    businessOperationKey: string;
    requestDigest: string;
  }>): Promise<Accepted<Readonly<{
    allocationClosureReceiptRef: string;
    capturedAmount: bigint;
    releasedAmount: bigint;
  }>> | Readonly<{ kind: "reconciliation_required" | "conflict" | "not_found" | "invalid_state";
    code?: string; reconciliationReceiptRef?: string }>>;
}

type CreditMediaChildRepository = Pick<CreditAuthorityRepository, "lockMediaChildAllocation">;
type CreditMediaRunBudgetOwner = Pick<RunBudgetAuthority, "returnChildAllocation">;

type CreditMediaReferenceFactory =
  (kind: "usage-evidence" | "usage-closure" | "reconciliation", stableSeed: string) => string;

/**
 * Credit-owned orchestration. Media supplies no price and cannot choose an allocation fence:
 * Usage rating and both allocation closure variants execute in the caller's Credit transaction.
 */
export class CreditMediaBudgetFinalizationService {
  readonly #dependencies: Readonly<{
    usage: CreditMediaUsageOwner;
    repository: CreditMediaChildRepository;
    runBudget: CreditMediaRunBudgetOwner;
    directRoot: DirectMediaRootClosureAuthority;
    reference: CreditMediaReferenceFactory;
    clock: () => Date;
  }>;

  constructor(input: Readonly<{
    usage: CreditMediaUsageOwner;
    repository: CreditMediaChildRepository;
    runBudget: CreditMediaRunBudgetOwner;
    directRoot: DirectMediaRootClosureAuthority;
    reference?: CreditMediaReferenceFactory;
    clock?: () => Date;
  }>) {
    this.#dependencies = Object.freeze({ ...input,
      reference: input.reference ?? stableUuid, clock: input.clock ?? (() => new Date()) });
  }

  async finalize(transaction: PlatformTransaction, input: Readonly<{
    siteId: string;
    operationRef: string;
    workerLease: CreditMediaWorkerLease;
    budget: CreditMediaBudgetBinding;
    effectClosureReceiptRef: string;
    outcome: "completed" | "partial" | "failed" | "canceled";
    attempt?: CreditMediaAttempt | undefined;
  }>): Promise<CreditMediaFinancialClosure> {
    validateCommand(input);
    const now = canonicalNow(this.#dependencies.clock());
    const evidenceRefs: string[] = [];
    if (input.attempt !== undefined) {
      const evidenceRef = this.#dependencies.reference("usage-evidence", digestCanonical({
        siteId: input.siteId, operationRef: input.operationRef,
        attemptAuthorizationRef: input.attempt.attemptAuthorizationRef,
        usageEvidenceRef: input.attempt.usageEvidenceRef,
        usageEvidenceDigest: input.attempt.usageEvidenceDigest,
      }));
      const evidence = attemptEvidence(input.budget, input.attempt);
      const finalized = await this.#dependencies.usage.finalizeAttempt(transaction, {
        siteId: input.siteId,
        attemptAuthorizationRef: input.attempt.attemptAuthorizationRef,
        expectedFenceEpoch: input.attempt.attemptAuthorizationFenceEpoch,
        evidenceRef,
        businessOperationKey: operationKey("media-usage", input.operationRef, input.attempt.attemptRef),
        requestDigest: digestCanonical({ operationRef: input.operationRef,
          effectClosureReceiptRef: input.effectClosureReceiptRef,
          attemptAuthorizationDigest: input.attempt.attemptAuthorizationDigest,
          usageEvidenceRef: input.attempt.usageEvidenceRef,
          usageEvidenceDigest: input.attempt.usageEvidenceDigest, evidence }),
        evidence,
      });
      if (finalized.kind !== "accepted" && finalized.kind !== "replayed") {
        return reconciliation(this.#dependencies.reference("reconciliation", digestCanonical({
          siteId: input.siteId, operationRef: input.operationRef,
          effectClosureReceiptRef: input.effectClosureReceiptRef,
          attemptAuthorizationRef: input.attempt.attemptAuthorizationRef,
          outcomeKind: finalized.kind,
        })),
          ("code" in finalized ? finalized.code : undefined) ??
          `CREDIT_MEDIA_ATTEMPT_${finalized.kind.toUpperCase()}`);
      }
      if (finalized.value.evidenceRef !== evidenceRef || finalized.value.revision !== 1n) {
        throw new Error("CREDIT_MEDIA_USAGE_RECEIPT_INVALID");
      }
      evidenceRefs.push(evidenceRef);
    }

    const closureRef = this.#dependencies.reference("usage-closure", digestCanonical({
      siteId: input.siteId, operationRef: input.operationRef,
      authorizationSegmentRef: input.budget.authorizationSegmentRef,
      effectClosureReceiptRef: input.effectClosureReceiptRef,
    }));
    const settled = await this.#dependencies.usage.settleUsageSegment(transaction, {
      siteId: input.siteId,
      authorizationSegmentRef: input.budget.authorizationSegmentRef,
      executionManifestRef: input.budget.executionManifestRef,
      closureRef,
      closureRevision: 1n,
      correctionOfClosureRef: null,
      evidenceRefs: Object.freeze(evidenceRefs),
      businessOperationKey: operationKey("media-settle", input.operationRef, input.effectClosureReceiptRef),
      requestDigest: digestCanonical({ operationRef: input.operationRef, budget: input.budget,
        effectClosureReceiptRef: input.effectClosureReceiptRef, outcome: input.outcome, evidenceRefs }),
      closureDigest: digestCanonical({ operationRef: input.operationRef,
        effectClosureReceiptRef: input.effectClosureReceiptRef, outcome: input.outcome, evidenceRefs }),
      closedAt: now,
    });
    if (settled.kind === "reconciliation_required") {
      return reconciliation(closureRef, settled.value.code);
    }
    if (settled.kind !== "accepted" && settled.kind !== "replayed") {
      return reconciliation(closureRef, ("code" in settled ? settled.code : undefined) ??
        `CREDIT_MEDIA_SETTLEMENT_${settled.kind.toUpperCase()}`);
    }
    const settlement = settled.value;
    if (settlement.state !== "settled" || settlement.authorizationSegmentRef !==
        input.budget.authorizationSegmentRef || settlement.closureRef !== closureRef ||
        settlement.closureRevision !== 1n) throw new Error("CREDIT_MEDIA_SETTLEMENT_RECEIPT_INVALID");

    if (input.budget.kind === "direct_root") {
      const closed = await this.#dependencies.directRoot.close(transaction, {
        siteId: input.siteId, operationRef: input.operationRef, workerLease: input.workerLease,
        budget: input.budget,
        effectClosureReceiptRef: input.effectClosureReceiptRef, outcome: input.outcome, settlement,
        businessOperationKey: operationKey("media-root-close", input.operationRef,
          input.effectClosureReceiptRef),
        requestDigest: deriveDirectMediaRootClosureRequestDigest({ siteId: input.siteId,
          operationRef: input.operationRef, budget: input.budget,
          effectClosureReceiptRef: input.effectClosureReceiptRef, outcome: input.outcome, settlement }),
      });
      if (closed.kind !== "accepted" && closed.kind !== "replayed") {
        return reconciliation(("reconciliationReceiptRef" in closed
          ? closed.reconciliationReceiptRef : undefined) ?? closureRef,
        ("code" in closed ? closed.code : undefined) ??
          `CREDIT_MEDIA_ROOT_CLOSE_${closed.kind.toUpperCase()}`);
      }
      return financial(settlement, closed.value.allocationClosureReceiptRef,
        closed.value.capturedAmount, closed.value.releasedAmount, input.budget);
    }

    const current = await this.#dependencies.repository.lockMediaChildAllocation(transaction, {
      siteId: input.siteId, executionBudgetRootRef: input.budget.executionBudgetRootRef,
      parentAllocationRef: input.budget.parentAllocationRef,
      childAllocationRef: input.budget.childAllocationRef,
    });
    if (current === null) return reconciliation(closureRef, "CREDIT_MEDIA_CHILD_NOT_FOUND");
    const returned = await this.#dependencies.runBudget.returnChildAllocation(transaction, {
      siteId: input.siteId, executionBudgetRootRef: input.budget.executionBudgetRootRef,
      parentAllocationRef: input.budget.parentAllocationRef,
      childAllocationRef: input.budget.childAllocationRef,
      expectedParentRevision: current.parentAllocation.revision,
      expectedParentAllocationEpoch: current.parentAllocation.allocationEpoch,
      expectedChildRevision: current.childAllocation.revision,
      expectedChildAllocationEpoch: current.childAllocation.allocationEpoch,
      mediaOperationRef: input.operationRef,
      businessOperationKey: operationKey("media-child-close", input.operationRef,
        input.effectClosureReceiptRef),
      requestDigest: digestCanonical({ operationRef: input.operationRef,
        effectClosureReceiptRef: input.effectClosureReceiptRef, settlementRef: settlement.settlementRef,
        parentRevision: current.parentAllocation.revision, childRevision: current.childAllocation.revision }),
      ownerClosureEvidence: Object.freeze({ kind: "media_operation_terminal" as const,
        mediaOperationRef: input.operationRef, terminalReceiptRef: input.effectClosureReceiptRef,
        outcome: input.outcome }),
    });
    if (returned.kind !== "accepted" && returned.kind !== "replayed") {
      return reconciliation(closureRef, ("code" in returned ? returned.code : undefined) ??
        `CREDIT_MEDIA_CHILD_CLOSE_${returned.kind.toUpperCase()}`);
    }
    return financial(settlement, returned.value.allocationReturnReceiptRef,
      returned.value.capturedAmount, returned.value.returnedAmount, input.budget);
  }
}

function attemptEvidence(budget: CreditMediaBudgetBinding, attempt: CreditMediaAttempt): AttemptUsageEvidence {
  const base = Object.freeze({ producerKind: attempt.producerKind, producerContext: attempt.producerContext,
    producerGeneration: attempt.producerGeneration, attemptRef: attempt.attemptRef,
    logicalEffectRef: attempt.logicalEffectRef, authorizationSegmentRef: budget.authorizationSegmentRef,
    executionManifestRef: budget.executionManifestRef, revision: 1n, correctionOfEvidenceRef: null,
    attemptOutcome: attempt.fact.attemptOutcome, occurredAt: attempt.fact.occurredAt,
    sourceDigest: attempt.fact.sourceDigest });
  if (attempt.fact.evidenceKind === "measured") return Object.freeze({ ...base,
    evidenceKind: "measured" as const, dimensions: Object.freeze([...attempt.fact.dimensions]) });
  if (attempt.fact.evidenceKind === "zero") return Object.freeze({ ...base,
    evidenceKind: "zero" as const, zeroReason: "provider_reported_zero" as const,
    dimensions: Object.freeze([]) as readonly [] });
  return Object.freeze({ ...base, evidenceKind: "unavailable" as const,
    unavailableReason: attempt.fact.unavailableReason, dimensions: Object.freeze([]) as readonly [] });
}

function financial(settlement: UsageSettlement, allocationClosureReceiptRef: string,
  capturedAmount: bigint, releasedAmount: bigint, budget: CreditMediaBudgetBinding): CreditMediaFinancialClosure {
  if (capturedAmount !== settlement.customerAmount || capturedAmount + releasedAmount !== budget.reservedCeiling) {
    throw new Error("CREDIT_MEDIA_FINANCIAL_CONSERVATION_INVALID");
  }
  return Object.freeze({ kind: "settled" as const, financialReceiptRef: allocationClosureReceiptRef,
    allocationClosureReceiptRef, usageSettlementReceiptRef: settlement.settlementRef,
    actualCost: capturedAmount.toString(), releasedCredit: releasedAmount.toString(), unit: budget.unit });
}

function reconciliation(reconciliationReceiptRef: string, code: string): CreditMediaFinancialClosure {
  return Object.freeze({ kind: "reconciliation_required" as const, reconciliationReceiptRef, code });
}

function validateCommand(input: Readonly<{ siteId: string; operationRef: string;
  workerLease: CreditMediaWorkerLease;
  effectClosureReceiptRef: string; budget: CreditMediaBudgetBinding;
  outcome: "completed" | "partial" | "failed" | "canceled";
  attempt?: CreditMediaAttempt | undefined }>): void {
  for (const value of [input.siteId, input.operationRef, input.effectClosureReceiptRef,
    input.workerLease.taskRef, input.budget.executionManifestRef,
    input.budget.authorizationSegmentRef, input.budget.unit]) reference(value);
  digest(input.workerLease.leaseTokenHash);
  if (input.workerLease.leaseEpoch <= 0n) throw new Error("CREDIT_MEDIA_WORKER_LEASE_INVALID");
  if (input.budget.reservedCeiling <= 0n || input.budget.authorizationSegmentVersion <= 0n) {
    throw new Error("CREDIT_MEDIA_BUDGET_INVALID");
  }
  const attempt = input.attempt;
  if (attempt === undefined && input.outcome !== "canceled") {
    throw new Error("CREDIT_MEDIA_USAGE_EVIDENCE_REQUIRED");
  }
  if (attempt !== undefined) {
    for (const value of [attempt.attemptAuthorizationRef, attempt.usageEvidenceRef,
      attempt.producerContext, attempt.attemptRef, attempt.logicalEffectRef]) reference(value);
    for (const value of [attempt.attemptAuthorizationDigest, attempt.usageEvidenceDigest,
      attempt.fact.sourceDigest]) digest(value);
    if (attempt.attemptAuthorizationFenceEpoch <= 0n || attempt.producerGeneration <= 0n) {
      throw new Error("CREDIT_MEDIA_ATTEMPT_INVALID");
    }
  }
}

export function deriveDirectMediaRootClosureRequestDigest(input: Readonly<{
  siteId: string;
  operationRef: string;
  budget: Extract<CreditMediaBudgetBinding, { kind: "direct_root" }>;
  effectClosureReceiptRef: string;
  outcome: "completed" | "partial" | "failed" | "canceled";
  settlement: UsageSettlement;
}>): string {
  const budget = input.budget;
  const settlement = input.settlement;
  return framedDigest("kokoro.platform.credit.direct-media-root.request.v1", [
    input.siteId, input.operationRef, budget.executionBudgetRootRef, budget.executionManifestRef,
    budget.rootHoldRef, budget.rootAllocationRef, budget.rootAllocationRevision.toString(),
    budget.rootAllocationEpoch.toString(), budget.authorizationSegmentRef,
    budget.authorizationSegmentVersion.toString(), budget.reservedCeiling.toString(), budget.unit,
    input.effectClosureReceiptRef, input.outcome, settlement.settlementRef,
    settlement.authorizationSegmentRef, settlement.closureRef, settlement.closureRevision.toString(),
    settlement.state, settlement.customerAmount.toString(), settlement.platformExposureAmount.toString(),
  ]);
}

function framedDigest(domain: string, values: readonly string[]): string {
  return createHash("sha256").update([domain, ...values].map((value) =>
    `${Buffer.byteLength(value, "utf8")}:${value}`).join("|")).digest("hex");
}

function canonicalNow(clock: Date): string {
  if (!Number.isFinite(clock.getTime())) throw new Error("CREDIT_MEDIA_CLOCK_INVALID");
  return clock.toISOString();
}
function operationKey(kind: string, ...parts: readonly string[]): string {
  return `${kind}:${createHash("sha256").update(parts.join("\0"), "utf8").digest("hex")}`;
}
function digestCanonical(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}
function stableUuid(kind: "usage-evidence" | "usage-closure" | "reconciliation", stableSeed: string): string {
  digest(stableSeed);
  const raw = createHash("sha256")
    .update("kokoro.platform.credit.media-finalization-reference.v1\0", "utf8")
    .update(kind, "utf8").update("\0", "utf8").update(stableSeed, "utf8").digest("hex");
  const variant = ((Number.parseInt(raw[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-5${raw.slice(13, 16)}-${variant}${raw.slice(17, 20)}-${raw.slice(20, 32)}`;
}
function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function reference(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value)) throw new Error("CREDIT_MEDIA_REFERENCE_INVALID");
}
function digest(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("CREDIT_MEDIA_DIGEST_INVALID");
}
