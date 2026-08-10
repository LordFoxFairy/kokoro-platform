import { createHash, randomUUID } from "node:crypto";
import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";
import {
  correctSettledAuthorizationSegmentAllocation,
  markAuthorizationSegmentRatingPending,
  reconcileUnknownAuthorizationSegment,
  settleAuthorizationSegment,
} from "../domain/allocation.js";
import { planHoldCapture, planSettlementCorrection } from "../domain/settlement.js";
import {
  assertUsageProducerKind,
  rateAttemptUsage,
  rateMaximumUsage,
  rateSegmentUsage,
} from "../domain/usage-rating.js";
import type { UsageDimension } from "../domain/usage-rating.js";
import type {
  StoredAttemptUsageEvidence,
  UsageCommandIdentity,
  UsageAttemptReceipt,
  UsageEvidenceReceipt,
  UsageReferenceKind,
  UsageReconciliationRecord,
  UsageSettlementReceipt,
  UsageSettlementRecord,
  UsageSettlementRepository,
} from "./contracts/usage-settlement-repository.js";

export class UsageSettlementService {
  readonly #clock: () => Date;
  readonly #reference: (kind: UsageReferenceKind, now: number) => string;

  constructor(private readonly dependencies: Readonly<{
    repository: UsageSettlementRepository;
    clock?: () => Date;
    reference?: (kind: UsageReferenceKind, now: number) => string;
  }>) {
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#reference = dependencies.reference ?? (() => randomUUID());
  }

  async prepareAttempt(transaction: PlatformTransaction, input: Readonly<{
    siteId: string;
    authorizationSegmentRef: string;
    executionManifestRef: string;
    producerKind: StoredAttemptUsageEvidence["evidence"]["producerKind"];
    producerContext: string;
    producerGeneration: bigint;
    attemptRef: string;
    logicalEffectRef: string;
    maximumDimensions: readonly UsageDimension[];
    businessOperationKey: string;
    requestDigest: string;
  }>): Promise<
    | Readonly<{ kind: "accepted" | "replayed"; value: UsageAttemptReceipt }>
    | Readonly<{ kind: "conflict"; code: "REQUEST_DIGEST_CONFLICT" }>
    | Readonly<{ kind: "not_found" }>
    | Readonly<{ kind: "invalid_state"; code: string }>
  > {
    const invalid = expectedError(() => {
      [input.siteId, input.authorizationSegmentRef, input.executionManifestRef, input.producerContext,
        input.attemptRef, input.logicalEffectRef, input.businessOperationKey].forEach(reference);
      digestValue(input.requestDigest);
      assertUsageProducerKind(input.producerKind);
      if (input.producerGeneration <= 0n) {
        throw new Error("CREDIT_USAGE_ATTEMPT_INTENT_INVALID");
      }
    });
    if (invalid !== null) return { kind: "invalid_state", code: invalid };
    const identity = commandIdentity("prepare_attempt", input);
    const prior = await this.dependencies.repository.findCommandReceipt(transaction, identity);
    if (prior.kind !== "none") {
      if (prior.kind === "conflict") return prior;
      if (!isAttemptReceipt(prior.value)) throw new Error("CREDIT_USAGE_RECEIPT_CORRUPT");
      return { kind: "replayed", value: prior.value };
    }
    const context = await this.dependencies.repository.lockUsageContext(transaction, {
      siteId: input.siteId,
      authorizationSegmentRef: input.authorizationSegmentRef,
      authority: "producer",
    });
    if (context === null) return { kind: "not_found" };
    const racedReceipt = await this.dependencies.repository.findCommandReceipt(transaction, identity);
    if (racedReceipt.kind !== "none") {
      if (racedReceipt.kind === "conflict") return racedReceipt;
      if (!isAttemptReceipt(racedReceipt.value)) throw new Error("CREDIT_USAGE_RECEIPT_CORRUPT");
      return { kind: "replayed", value: racedReceipt.value };
    }
    if (context.executionManifestRef !== input.executionManifestRef || context.segment.state !== "committed" ||
        context.executionBudgetRootState !== "open" || context.creditHoldState !== "open") {
      return { kind: "invalid_state", code: "CREDIT_USAGE_ATTEMPT_AUTHORITY_NOT_OPEN" };
    }
    const maximum = expectedValue(() => rateMaximumUsage(context.ratingPolicy, input.maximumDimensions));
    if (maximum.kind === "error") return { kind: "invalid_state", code: maximum.code };
    const committed = await this.dependencies.repository.loadCommittedAttemptMaximum(transaction, input);
    if (committed + maximum.value.maximumAmount > context.segment.maximumAmount) {
      return { kind: "invalid_state", code: "CREDIT_USAGE_ATTEMPT_CAPACITY_EXCEEDED" };
    }
    const now = this.#clock();
    const attemptAuthorizationRef = this.#reference("attempt-authorization", now.getTime());
    const receipt: UsageAttemptReceipt = Object.freeze({
      attemptAuthorizationRef, state: "effect_committed", fenceEpoch: 1n,
    });
    return this.dependencies.repository.persistAttemptIntent(transaction, Object.freeze({
      identity, receipt, siteId: input.siteId, executionBudgetRootRef: context.executionBudgetRootRef,
      budgetAllocationRef: context.budgetAllocationRef, authorizationSegmentRef: input.authorizationSegmentRef,
      creditHoldRef: context.creditHoldRef, creditAccountId: context.creditAccountId, unit: context.unit,
      executionManifestRef: input.executionManifestRef, attemptAuthorizationRef,
      producerKind: input.producerKind, producerContext: input.producerContext,
      producerGeneration: input.producerGeneration, attemptRef: input.attemptRef,
      logicalEffectRef: input.logicalEffectRef, maximumDimensions: Object.freeze([...input.maximumDimensions]),
      maximumDimensionsDigest: digestCanonical(input.maximumDimensions), maximumAmount: maximum.value.maximumAmount,
      provisionalCustomerAmount: null, state: "effect_committed", fenceEpoch: 1n, ownerEvidenceRef: null,
      committedAt: now.toISOString(), receiptRef: this.#reference("usage-receipt", now.getTime()),
    }));
  }

  async markAttemptOutcomeUnknown(transaction: PlatformTransaction, input: Readonly<{
    siteId: string;
    attemptAuthorizationRef: string;
    expectedFenceEpoch: bigint;
    businessOperationKey: string;
    requestDigest: string;
    ownerEvidenceRef: string;
  }>): Promise<
    | Readonly<{ kind: "accepted" | "replayed"; value: UsageAttemptReceipt }>
    | Readonly<{ kind: "conflict"; code: "REQUEST_DIGEST_CONFLICT" }>
    | Readonly<{ kind: "not_found" }>
    | Readonly<{ kind: "invalid_state"; code: string }>
  > {
    const invalid = expectedError(() => {
      [input.siteId, input.attemptAuthorizationRef, input.businessOperationKey,
        input.ownerEvidenceRef].forEach(reference);
      digestValue(input.requestDigest);
      if (input.expectedFenceEpoch <= 0n) throw new Error("CREDIT_USAGE_ATTEMPT_FENCE_INVALID");
    });
    if (invalid !== null) return { kind: "invalid_state", code: invalid };
    const identity = commandIdentity("attempt_unknown", input);
    const prior = await this.dependencies.repository.findCommandReceipt(transaction, identity);
    if (prior.kind !== "none") {
      if (prior.kind === "conflict") return prior;
      if (!isAttemptReceipt(prior.value)) throw new Error("CREDIT_USAGE_RECEIPT_CORRUPT");
      return { kind: "replayed", value: prior.value };
    }
    const intent = await this.dependencies.repository.lockAttemptIntent(transaction, input);
    if (intent === null) return { kind: "not_found" };
    const racedReceipt = await this.dependencies.repository.findCommandReceipt(transaction, identity);
    if (racedReceipt.kind !== "none") {
      if (racedReceipt.kind === "conflict") return racedReceipt;
      if (!isAttemptReceipt(racedReceipt.value)) throw new Error("CREDIT_USAGE_RECEIPT_CORRUPT");
      return { kind: "replayed", value: racedReceipt.value };
    }
    if (intent.state !== "effect_committed" || intent.fenceEpoch !== input.expectedFenceEpoch) {
      return { kind: "invalid_state", code: "CREDIT_USAGE_ATTEMPT_FENCE_STALE" };
    }
    const now = this.#clock();
    const receipt: UsageAttemptReceipt = Object.freeze({
      attemptAuthorizationRef: intent.attemptAuthorizationRef,
      state: "outcome_unknown",
      fenceEpoch: intent.fenceEpoch + 1n,
    });
    return this.dependencies.repository.updateAttemptIntent(transaction, Object.freeze({
      ...intent, identity, receipt, state: "outcome_unknown", fenceEpoch: receipt.fenceEpoch,
      ownerEvidenceRef: input.ownerEvidenceRef, observedAt: now.toISOString(),
      receiptRef: this.#reference("usage-receipt", now.getTime()),
    }));
  }

  async finalizeAttempt(transaction: PlatformTransaction, input: Readonly<{
    siteId: string;
    attemptAuthorizationRef: string;
    expectedFenceEpoch: bigint;
    evidenceRef: string;
    businessOperationKey: string;
    requestDigest: string;
    evidence: StoredAttemptUsageEvidence["evidence"];
  }>): Promise<
    | Readonly<{ kind: "accepted" | "replayed"; value: UsageEvidenceReceipt }>
    | Readonly<{ kind: "conflict"; code: "REQUEST_DIGEST_CONFLICT" }>
    | Readonly<{ kind: "not_found" }>
    | Readonly<{ kind: "invalid_state"; code: string }>
  > {
    const invalid = expectedError(() => validateFinalize(input));
    if (invalid !== null) return { kind: "invalid_state", code: invalid };
    const identity = commandIdentity("finalize_attempt", input);
    const prior = await this.dependencies.repository.findCommandReceipt(transaction, identity);
    if (prior.kind !== "none") {
      if (prior.kind === "conflict") return prior;
      if (!isEvidenceReceipt(prior.value)) throw new Error("CREDIT_USAGE_RECEIPT_CORRUPT");
      return { kind: "replayed", value: prior.value };
    }
    const intent = await this.dependencies.repository.lockAttemptIntent(transaction, input);
    if (intent === null) return { kind: "not_found" };
    const racedReceipt = await this.dependencies.repository.findCommandReceipt(transaction, identity);
    if (racedReceipt.kind !== "none") {
      if (racedReceipt.kind === "conflict") return racedReceipt;
      if (!isEvidenceReceipt(racedReceipt.value)) throw new Error("CREDIT_USAGE_RECEIPT_CORRUPT");
      return { kind: "replayed", value: racedReceipt.value };
    }
    if (intent.fenceEpoch !== input.expectedFenceEpoch ||
        !["effect_committed", "outcome_unknown", "finalized"].includes(intent.state)) {
      return { kind: "invalid_state", code: "CREDIT_USAGE_ATTEMPT_FENCE_STALE" };
    }
    if (!attemptIdentityMatches(input.evidence, intent)) {
      return { kind: "invalid_state", code: "CREDIT_USAGE_ATTEMPT_IDENTITY_MISMATCH" };
    }
    const context = await this.dependencies.repository.lockUsageContext(transaction, {
      siteId: input.siteId,
      authorizationSegmentRef: intent.authorizationSegmentRef,
      authority: "producer",
    });
    if (context === null) return { kind: "not_found" };
    const scope = Object.freeze({ siteId: intent.siteId, executionBudgetRootRef: intent.executionBudgetRootRef,
      budgetAllocationRef: intent.budgetAllocationRef, creditHoldRef: intent.creditHoldRef,
      creditAccountId: intent.creditAccountId, unit: intent.unit, evidence: input.evidence });
    const scopeError = usageScopeError(scope, context);
    if (scopeError !== null) return { kind: "invalid_state", code: scopeError };
    const attemptRating = expectedValue(() =>
      rateAttemptUsage(context.ratingPolicy, input.evidence, intent.maximumAmount));
    if (attemptRating.kind === "error") return { kind: "invalid_state", code: attemptRating.code };
    const latest = await this.dependencies.repository.lockLatestAttemptEvidence(transaction, {
      siteId: input.siteId,
      authorizationSegmentRef: input.evidence.authorizationSegmentRef,
      producerKind: input.evidence.producerKind,
      producerContext: input.evidence.producerContext,
      producerGeneration: input.evidence.producerGeneration,
      attemptRef: input.evidence.attemptRef,
    });
    if (!linearEvidenceRevision(input.evidence, latest)) {
      return { kind: "invalid_state", code: "CREDIT_USAGE_CORRECTION_CHAIN_INVALID" };
    }
    const observedAt = this.#clock().toISOString();
    const record = Object.freeze({
      identity, siteId: intent.siteId, attemptAuthorizationRef: intent.attemptAuthorizationRef,
      executionBudgetRootRef: intent.executionBudgetRootRef, budgetAllocationRef: intent.budgetAllocationRef,
      creditHoldRef: intent.creditHoldRef, creditAccountId: intent.creditAccountId, unit: intent.unit,
      evidenceRef: input.evidenceRef, businessOperationKey: input.businessOperationKey,
      requestDigest: input.requestDigest, evidence: input.evidence,
      priorAttemptState: intent.state, priorFenceEpoch: intent.fenceEpoch, nextFenceEpoch: intent.fenceEpoch + 1n,
      provisionalCustomerAmount: attemptRating.value.kind === "reconciliation_required"
        ? null : attemptRating.value.customerAmount,
      evidenceDigest: digestCanonical(input.evidence),
      observedAt,
      receiptRef: this.#reference("usage-receipt", Date.parse(observedAt)),
    });
    return this.dependencies.repository.persistAttemptUsage(transaction, record);
  }

  async settleUsageSegment(transaction: PlatformTransaction, input: Readonly<{
    siteId: string;
    authorizationSegmentRef: string;
    executionManifestRef: string;
    closureRef: string;
    closureRevision: bigint;
    correctionOfClosureRef: string | null;
    evidenceRefs: readonly string[];
    businessOperationKey: string;
    requestDigest: string;
    closureDigest: string;
    closedAt: string;
  }>): Promise<
    | Readonly<{ kind: "accepted" | "replayed"; value: UsageSettlementReceipt }>
    | Readonly<{ kind: "conflict"; code: "REQUEST_DIGEST_CONFLICT" }>
    | Readonly<{ kind: "not_found" }>
    | Readonly<{ kind: "invalid_state"; code: string }>
    | Readonly<{ kind: "reconciliation_required"; value: Readonly<{ authorizationSegmentRef: string; code: string }> }>
  > {
    const invalid = expectedError(() => validateClosure(input));
    if (invalid !== null) return { kind: "invalid_state", code: invalid };
    const identity = commandIdentity("settle_usage", input);
    const priorReceipt = await this.dependencies.repository.findCommandReceipt(transaction, identity);
    if (priorReceipt.kind !== "none") {
      if (priorReceipt.kind === "conflict") return priorReceipt;
      if (!isSettlementReceipt(priorReceipt.value)) throw new Error("CREDIT_USAGE_RECEIPT_CORRUPT");
      return { kind: "replayed", value: priorReceipt.value };
    }
    const context = await this.dependencies.repository.lockUsageContext(transaction, {
      siteId: input.siteId,
      authorizationSegmentRef: input.authorizationSegmentRef,
      authority: "settlement_owner",
    });
    if (context === null) return { kind: "not_found" };
    const racedReceipt = await this.dependencies.repository.findCommandReceipt(transaction, identity);
    if (racedReceipt.kind !== "none") {
      if (racedReceipt.kind === "conflict") return racedReceipt;
      if (!isSettlementReceipt(racedReceipt.value)) throw new Error("CREDIT_USAGE_RECEIPT_CORRUPT");
      return { kind: "replayed", value: racedReceipt.value };
    }
    if (context.executionManifestRef !== input.executionManifestRef) {
      return { kind: "invalid_state", code: "CREDIT_USAGE_MANIFEST_MISMATCH" };
    }
    const [evidenceSet, openAttemptCount, priorClosure, priorSettlement, holdAllocations] = await Promise.all([
      this.dependencies.repository.loadClosureEvidence(transaction, input),
      this.dependencies.repository.loadOpenAttemptCount(transaction, input),
      this.dependencies.repository.loadPriorClosure(transaction, input),
      this.dependencies.repository.loadPriorSettlement(transaction, input),
      this.dependencies.repository.loadHoldAllocationsAfterFinancialLock(transaction, {
        siteId: input.siteId,
        creditHoldRef: context.creditHoldRef,
      }),
    ]);
    if (openAttemptCount !== 0n) {
      return { kind: "invalid_state", code: "CREDIT_USAGE_ATTEMPTS_NOT_FINALIZED" };
    }
    if (!exactEvidenceSet(input.evidenceRefs, evidenceSet) ||
        evidenceSet.some((record) => usageScopeError(record, context) !== null)) {
      return { kind: "invalid_state", code: "CREDIT_USAGE_CLOSURE_EVIDENCE_MISMATCH" };
    }
    if (!linearClosure(input, priorClosure)) {
      return { kind: "invalid_state", code: "CREDIT_USAGE_CLOSURE_CHAIN_INVALID" };
    }
    const rating = rateSegmentUsage(context.ratingPolicy, evidenceSet.map((record) => record.evidence),
      context.segment.maximumAmount);
    const now = this.#clock();
    const observedAt = now.toISOString();
    if (rating.kind === "reconciliation_required") {
      let segment: UsageReconciliationRecord["segment"];
      if (priorSettlement === null) {
        if (context.segment.state === "committed" || context.segment.state === "rating_pending") {
          segment = reconcileUnknownAuthorizationSegment(
            context.segment,
            input.closureRef,
            observedAt,
          );
        } else if (context.segment.state !== "reconciliation_required") {
          return { kind: "invalid_state", code: "CREDIT_USAGE_SEGMENT_NOT_RECONCILABLE" };
        }
      } else if (context.segment.state !== "settled") {
        return { kind: "invalid_state", code: "CREDIT_USAGE_CORRECTION_SEGMENT_NOT_SETTLED" };
      }
      return this.dependencies.repository.persistReconciliationRequired(transaction, Object.freeze({
        identity, context, closureRef: input.closureRef, closureRevision: input.closureRevision,
        closureDigest: input.closureDigest, closedAt: input.closedAt,
        correctionOfClosureRef: input.correctionOfClosureRef,
        evidenceSet, code: rating.code, observedAt,
        ...(segment === undefined ? {} : { segment }),
        receiptRef: this.#reference("usage-receipt", now.getTime()),
      }));
    }
    const delta = rating.customerAmount - (priorSettlement?.customerAmount ?? 0n);
    if (!["open", "closing", "reconciliation_required"].includes(context.creditHoldState)) {
      return { kind: "invalid_state", code: "CREDIT_USAGE_HOLD_NOT_SETTLEABLE" };
    }
    let sourceMutations: UsageSettlementRecord["sourceMutations"];
    let allocation: UsageSettlementRecord["allocation"];
    let ratingPendingSegment: UsageSettlementRecord["ratingPendingSegment"];
    let segment: UsageSettlementRecord["segment"];
    if (priorSettlement === null) {
      if (context.segment.state !== "committed" && context.segment.state !== "reconciliation_required") {
        return { kind: "invalid_state", code: "CREDIT_USAGE_SEGMENT_NOT_SETTLEABLE" };
      }
      const pending = context.segment.state === "committed"
        ? markAuthorizationSegmentRatingPending(context.segment, input.closureRef)
        : context.segment;
      const settled = settleAuthorizationSegment({
        allocation: context.allocation,
        segment: pending,
        ratedAmount: rating.customerAmount,
        settlementRef: input.closureRef,
        settledAt: observedAt,
      });
      sourceMutations = planHoldCapture(holdAllocations, rating.customerAmount)
        .map((source) => Object.freeze({ ...source, direction: "capture" as const }));
      allocation = settled.allocation;
      ratingPendingSegment = context.segment.state === "committed" ? pending : undefined;
      segment = settled.segment;
    } else {
      if (context.segment.state !== "settled") {
        return { kind: "invalid_state", code: "CREDIT_USAGE_CORRECTION_SEGMENT_NOT_SETTLED" };
      }
      sourceMutations = planSettlementCorrection(holdAllocations, delta);
      if (delta !== 0n) allocation = correctSettledAuthorizationSegmentAllocation(context.allocation, delta);
    }
    const settlementRef = this.#reference("usage-settlement", now.getTime());
    const receipt: UsageSettlementReceipt = Object.freeze({
      settlementRef,
      authorizationSegmentRef: input.authorizationSegmentRef,
      authorizationSegmentVersion: segment?.aggregateVersion ?? context.segment.aggregateVersion,
      closureRef: input.closureRef,
      closureRevision: input.closureRevision,
      state: "settled",
      customerAmount: rating.customerAmount,
      platformExposureAmount: rating.platformExposureAmount,
    });
    return this.dependencies.repository.persistSettlement(transaction, Object.freeze({
      identity, receipt, context,
      ...(allocation === undefined ? {} : { allocation }),
      ...(ratingPendingSegment === undefined ? {} : { ratingPendingSegment }),
      ...(segment === undefined ? {} : { segment }),
      closureDigest: input.closureDigest, closedAt: input.closedAt,
      correctionOfClosureRef: input.correctionOfClosureRef,
      ...(priorSettlement === null ? {} : { priorSettlementRef: priorSettlement.settlementRef }),
      ratingSnapshotRef: context.ratingSnapshotRef ?? this.#reference("rating-snapshot", now.getTime()),
      ratingSnapshotDigest: digestCanonical(context.ratingPolicy), evidenceSet, sourceMutations,
      attemptRatings: rating.attemptRatings,
      policyRatedAmount: rating.policyRatedAmount, customerAmount: rating.customerAmount,
      platformExposureAmount: rating.platformExposureAmount, settledAt: observedAt,
      ...(sourceMutations.length === 0 ? {} : {
        journalTransactionRef: this.#reference("usage-journal", now.getTime()),
      }),
      ...(rating.platformExposureAmount === 0n ? {} : {
        varianceRef: this.#reference("usage-variance", now.getTime()),
      }),
      receiptRef: this.#reference("usage-receipt", now.getTime()),
    }));
  }
}

function usageScopeError(
  input: Pick<StoredAttemptUsageEvidence, "siteId" | "executionBudgetRootRef" | "budgetAllocationRef" |
    "creditHoldRef" | "creditAccountId" | "unit" | "evidence">,
  context: Awaited<ReturnType<UsageSettlementRepository["lockUsageContext"]>> & object,
): string | null {
  if (input.siteId !== context.siteId || input.executionBudgetRootRef !== context.executionBudgetRootRef ||
      input.budgetAllocationRef !== context.budgetAllocationRef || input.creditHoldRef !== context.creditHoldRef ||
      input.creditAccountId !== context.creditAccountId || input.unit !== context.unit ||
      input.evidence.authorizationSegmentRef !== context.authorizationSegmentRef ||
      input.evidence.executionManifestRef !== context.executionManifestRef) {
    return "CREDIT_USAGE_AUTHORITY_SCOPE_MISMATCH";
  }
  return null;
}

function linearEvidenceRevision(
  evidence: StoredAttemptUsageEvidence["evidence"],
  latest: StoredAttemptUsageEvidence | null,
): boolean {
  if (latest === null) return evidence.revision === 1n && evidence.correctionOfEvidenceRef === null;
  return evidence.revision === latest.evidence.revision + 1n &&
    evidence.correctionOfEvidenceRef === latest.evidenceRef &&
    evidence.logicalEffectRef === latest.evidence.logicalEffectRef &&
    evidence.authorizationSegmentRef === latest.evidence.authorizationSegmentRef &&
    evidence.executionManifestRef === latest.evidence.executionManifestRef;
}

function linearClosure(
  input: Readonly<{ closureRevision: bigint; correctionOfClosureRef: string | null }>,
  prior: Readonly<{ closureRef: string; closureRevision: bigint }> | null,
): boolean {
  return prior === null
    ? input.closureRevision === 1n && input.correctionOfClosureRef === null
    : input.closureRevision === prior.closureRevision + 1n && input.correctionOfClosureRef === prior.closureRef;
}

function exactEvidenceSet(refs: readonly string[], records: readonly StoredAttemptUsageEvidence[]): boolean {
  const expected = [...refs].sort();
  const actual = records.map((record) => record.evidenceRef).sort();
  return expected.length === actual.length && expected.every((value, index) => value === actual[index]);
}

function validateFinalize(input: Readonly<{ attemptAuthorizationRef: string; expectedFenceEpoch: bigint;
  evidenceRef: string; businessOperationKey: string; requestDigest: string }>): void {
  reference(input.attemptAuthorizationRef);
  reference(input.evidenceRef);
  reference(input.businessOperationKey);
  digestValue(input.requestDigest);
  if (input.expectedFenceEpoch <= 0n) throw new Error("CREDIT_USAGE_ATTEMPT_FENCE_INVALID");
}

function attemptIdentityMatches(
  evidence: StoredAttemptUsageEvidence["evidence"],
  intent: Readonly<{ producerKind: string; producerContext: string; producerGeneration: bigint;
    attemptRef: string; logicalEffectRef: string; authorizationSegmentRef: string; executionManifestRef: string }>,
): boolean {
  return evidence.producerKind === intent.producerKind && evidence.producerContext === intent.producerContext &&
    evidence.producerGeneration === intent.producerGeneration && evidence.attemptRef === intent.attemptRef &&
    evidence.logicalEffectRef === intent.logicalEffectRef &&
    evidence.authorizationSegmentRef === intent.authorizationSegmentRef &&
    evidence.executionManifestRef === intent.executionManifestRef;
}

function validateClosure(input: Readonly<{ closureRef: string; closureRevision: bigint; evidenceRefs: readonly string[];
  businessOperationKey: string; requestDigest: string; closureDigest: string; closedAt: string }>): void {
  reference(input.closureRef);
  reference(input.businessOperationKey);
  digestValue(input.requestDigest);
  digestValue(input.closureDigest);
  if (input.closureRevision <= 0n || input.evidenceRefs.length > 4_096 ||
      new Set(input.evidenceRefs).size !== input.evidenceRefs.length) throw new Error("CREDIT_USAGE_CLOSURE_INVALID");
  input.evidenceRefs.forEach(reference);
  if (!Number.isFinite(Date.parse(input.closedAt))) throw new Error("CREDIT_USAGE_CLOSURE_TIME_INVALID");
}

function commandIdentity(
  operationKind: UsageCommandIdentity["operationKind"],
  input: Readonly<{ siteId: string; businessOperationKey: string; requestDigest: string }>,
): UsageCommandIdentity {
  return Object.freeze({ operationKind, siteId: input.siteId,
    businessOperationKey: input.businessOperationKey, requestDigest: input.requestDigest });
}

function isAttemptReceipt(value: UsageAttemptReceipt | UsageEvidenceReceipt | UsageSettlementReceipt): value is UsageAttemptReceipt {
  return "attemptAuthorizationRef" in value;
}

function isEvidenceReceipt(value: UsageAttemptReceipt | UsageEvidenceReceipt | UsageSettlementReceipt): value is UsageEvidenceReceipt {
  return "evidenceRef" in value;
}

function isSettlementReceipt(value: UsageAttemptReceipt | UsageEvidenceReceipt | UsageSettlementReceipt): value is UsageSettlementReceipt {
  return "settlementRef" in value;
}

function digestCanonical(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function digestValue(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("CREDIT_USAGE_DIGEST_INVALID");
}

function reference(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value)) throw new Error("CREDIT_USAGE_REFERENCE_INVALID");
}

function expectedError(action: () => void): string | null {
  try { action(); return null; } catch (error) { return error instanceof Error ? error.message : "CREDIT_USAGE_INVALID"; }
}

function expectedValue<T>(action: () => T): Readonly<{ kind: "value"; value: T }> |
  Readonly<{ kind: "error"; code: string }> {
  try { return { kind: "value", value: action() }; }
  catch (error) { return { kind: "error", code: error instanceof Error ? error.message : "CREDIT_USAGE_INVALID" }; }
}
