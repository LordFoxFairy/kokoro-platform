export const USAGE_PRODUCER_KINDS = [
  "model_gateway",
  "capability_runtime",
  "media",
] as const;

export type UsageProducerKind = (typeof USAGE_PRODUCER_KINDS)[number];

export function assertUsageProducerKind(value: string): asserts value is UsageProducerKind {
  if (!(USAGE_PRODUCER_KINDS as readonly string[]).includes(value)) {
    throw new Error("CREDIT_USAGE_PRODUCER_KIND_INVALID");
  }
}
export type UsageAttemptOutcome =
  | "succeeded"
  | "failed_before_effect"
  | "failed_after_effect"
  | "canceled_before_effect"
  | "canceled_after_effect";

export type UsageDimension = Readonly<{
  dimensionKey: string;
  sourceUnit: string;
  quantity: bigint;
}>;

type AttemptUsageIdentity = Readonly<{
  producerKind: UsageProducerKind;
  producerContext: string;
  producerGeneration: bigint;
  attemptRef: string;
  logicalEffectRef: string;
  authorizationSegmentRef: string;
  executionManifestRef: string;
  revision: bigint;
  correctionOfEvidenceRef: string | null;
  attemptOutcome: UsageAttemptOutcome;
  occurredAt: string;
  sourceDigest: string;
}>;

export type AttemptUsageEvidence = AttemptUsageIdentity & (
  | Readonly<{
      evidenceKind: "measured";
      dimensions: readonly UsageDimension[];
    }>
  | Readonly<{
      evidenceKind: "zero";
      zeroReason: "definitely_not_submitted" | "provider_reported_zero";
      dimensions: readonly [];
    }>
  | Readonly<{
      evidenceKind: "unavailable";
      unavailableReason: "provider_usage_missing" | "provider_usage_ambiguous" | "producer_integrity_failure";
      dimensions: readonly [];
    }>
);

export type RatingRule = Readonly<{
  dimensionKey: string;
  sourceUnit: string;
  quantum: bigint;
  amountPerQuantum: bigint;
  required: boolean;
}>;

export type RatingPolicyRevision = Readonly<{
  ratingPolicyRevisionRef: string;
  customerUnit: string;
  chargeableAttemptOutcomes: readonly UsageAttemptOutcome[];
  minimumAmount: bigint;
  rules: readonly RatingRule[];
}>;

export type RatedUsageLineItem = Readonly<{
  dimensionKey: string;
  quantity: bigint;
  billableQuanta: bigint;
  amount: bigint;
}>;

export type RatedUsageMaximum = Readonly<{
  maximumAmount: bigint;
  lineItems: readonly RatedUsageLineItem[];
}>;

export type UsageRatingResult =
  | Readonly<{
      kind: "rated" | "over_ceiling";
      customerAmount: bigint;
      platformExposureAmount: bigint;
      lineItems: readonly RatedUsageLineItem[];
    }>
  | Readonly<{
      kind: "reconciliation_required";
      code: "CREDIT_USAGE_UNAVAILABLE" | "CREDIT_USAGE_REQUIRED_DIMENSION_MISSING";
    }>;

export type SegmentAttemptRating = Readonly<{
  evidenceRef?: string;
  producerKind: UsageProducerKind;
  producerContext: string;
  producerGeneration: bigint;
  attemptRef: string;
  logicalEffectRef: string;
  policyRatedAmount: bigint;
  lineItems: readonly RatedUsageLineItem[];
}>;

export type SegmentUsageRatingResult =
  | Readonly<{
      kind: "rated" | "over_ceiling";
      customerAmount: bigint;
      platformExposureAmount: bigint;
      policyRatedAmount: bigint;
      attemptRatings: readonly SegmentAttemptRating[];
    }>
  | Extract<UsageRatingResult, { kind: "reconciliation_required" }>;

export function rateAttemptUsage(
  policy: RatingPolicyRevision,
  evidence: AttemptUsageEvidence,
  committedMaximum: bigint,
): UsageRatingResult {
  validatePolicy(policy);
  if (committedMaximum < 0n) throw new Error("CREDIT_USAGE_COMMITTED_MAXIMUM_INVALID");
  const result = rateUnboundedAttempt(policy, evidence);
  if (result.kind === "reconciliation_required") return result;
  return ratedResult(result.policyRatedAmount, committedMaximum, result.lineItems);
}

export function rateMaximumUsage(
  policy: RatingPolicyRevision,
  dimensions: readonly UsageDimension[],
): RatedUsageMaximum {
  validatePolicy(policy);
  if (dimensions.length < 1 || dimensions.length > 64) {
    throw new Error("CREDIT_USAGE_MAXIMUM_DIMENSIONS_INVALID");
  }
  const result = rateDimensions(policy, dimensions);
  if (result.kind === "reconciliation_required") throw new Error(result.code);
  return Object.freeze({ maximumAmount: result.policyRatedAmount, lineItems: result.lineItems });
}

export function rateSegmentUsage(
  policy: RatingPolicyRevision,
  evidenceSet: readonly AttemptUsageEvidence[],
  committedMaximum: bigint,
): SegmentUsageRatingResult {
  validatePolicy(policy);
  if (committedMaximum < 0n) throw new Error("CREDIT_USAGE_COMMITTED_MAXIMUM_INVALID");
  if (evidenceSet.length > 4_096) {
    throw new Error("CREDIT_USAGE_EVIDENCE_SET_INVALID");
  }
  if (evidenceSet.length === 0) {
    return Object.freeze({
      kind: "rated" as const,
      customerAmount: 0n,
      platformExposureAmount: 0n,
      policyRatedAmount: 0n,
      attemptRatings: Object.freeze([]),
    });
  }
  const attemptKey = (evidence: AttemptUsageEvidence) =>
    `${evidence.producerKind}\u0000${evidence.producerContext}\u0000${evidence.producerGeneration}\u0000${evidence.attemptRef}`;
  const ordered = [...evidenceSet].sort((left, right) => compareCodeUnits(attemptKey(left), attemptKey(right)));
  if (new Set(ordered.map(attemptKey)).size !== ordered.length) {
    throw new Error("CREDIT_USAGE_ATTEMPT_DUPLICATE");
  }
  const segmentRef = ordered[0]?.authorizationSegmentRef;
  const manifestRef = ordered[0]?.executionManifestRef;
  if (ordered.some((evidence) => evidence.authorizationSegmentRef !== segmentRef ||
    evidence.executionManifestRef !== manifestRef)) {
    throw new Error("CREDIT_USAGE_EVIDENCE_SET_SCOPE_MISMATCH");
  }
  const attemptRatings: SegmentAttemptRating[] = [];
  for (const evidence of ordered) {
    const result = rateUnboundedAttempt(policy, evidence);
    if (result.kind === "reconciliation_required") return result;
    attemptRatings.push(Object.freeze({
      producerKind: evidence.producerKind,
      producerContext: evidence.producerContext,
      producerGeneration: evidence.producerGeneration,
      attemptRef: evidence.attemptRef,
      logicalEffectRef: evidence.logicalEffectRef,
      policyRatedAmount: result.policyRatedAmount,
      lineItems: result.lineItems,
    }));
  }
  const policyRatedAmount = attemptRatings.reduce((total, attempt) => total + attempt.policyRatedAmount, 0n);
  return Object.freeze({
    kind: policyRatedAmount <= committedMaximum ? "rated" as const : "over_ceiling" as const,
    customerAmount: policyRatedAmount <= committedMaximum ? policyRatedAmount : committedMaximum,
    platformExposureAmount: policyRatedAmount <= committedMaximum ? 0n : policyRatedAmount - committedMaximum,
    policyRatedAmount,
    attemptRatings: Object.freeze(attemptRatings),
  });
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rateUnboundedAttempt(
  policy: RatingPolicyRevision,
  evidence: AttemptUsageEvidence,
): Readonly<{ kind: "rated"; policyRatedAmount: bigint; lineItems: readonly RatedUsageLineItem[] }>
  | Extract<UsageRatingResult, { kind: "reconciliation_required" }> {
  validateEvidenceIdentity(evidence);
  if (evidence.evidenceKind === "unavailable") {
    return Object.freeze({ kind: "reconciliation_required", code: "CREDIT_USAGE_UNAVAILABLE" });
  }
  if (evidence.evidenceKind === "zero") {
    return Object.freeze({ kind: "rated", policyRatedAmount: 0n, lineItems: Object.freeze([]) });
  }

  validateProvidedDimensions(policy, evidence.dimensions);
  if (!policy.chargeableAttemptOutcomes.includes(evidence.attemptOutcome)) {
    return Object.freeze({ kind: "rated", policyRatedAmount: 0n, lineItems: Object.freeze([]) });
  }
  return rateDimensions(policy, evidence.dimensions);
}

function rateDimensions(
  policy: RatingPolicyRevision,
  sourceDimensions: readonly UsageDimension[],
): Readonly<{ kind: "rated"; policyRatedAmount: bigint; lineItems: readonly RatedUsageLineItem[] }>
  | Extract<UsageRatingResult, { kind: "reconciliation_required" }> {
  const dimensions = new Map<string, UsageDimension>();
  for (const dimension of sourceDimensions) {
    validateKey(dimension.dimensionKey, "CREDIT_USAGE_DIMENSION_KEY_INVALID");
    validateKey(dimension.sourceUnit, "CREDIT_USAGE_DIMENSION_UNIT_INVALID");
    if (dimension.quantity < 0n) throw new Error("CREDIT_USAGE_DIMENSION_QUANTITY_INVALID");
    if (dimensions.has(dimension.dimensionKey)) throw new Error("CREDIT_USAGE_DIMENSION_DUPLICATE");
    dimensions.set(dimension.dimensionKey, dimension);
  }
  const rules = new Map(policy.rules.map((rule) => [rule.dimensionKey, rule]));
  for (const dimension of dimensions.values()) {
    if (!rules.has(dimension.dimensionKey)) throw new Error("CREDIT_USAGE_DIMENSION_NOT_RATABLE");
  }
  const lineItems: RatedUsageLineItem[] = [];
  for (const rule of policy.rules) {
    const dimension = dimensions.get(rule.dimensionKey);
    if (dimension === undefined) {
      if (rule.required) {
        return Object.freeze({
          kind: "reconciliation_required",
          code: "CREDIT_USAGE_REQUIRED_DIMENSION_MISSING",
        });
      }
      continue;
    }
    if (dimension.sourceUnit !== rule.sourceUnit) throw new Error("CREDIT_USAGE_DIMENSION_UNIT_MISMATCH");
    const billableQuanta = divideRoundUp(dimension.quantity, rule.quantum);
    lineItems.push(Object.freeze({
      dimensionKey: rule.dimensionKey,
      quantity: dimension.quantity,
      billableQuanta,
      amount: billableQuanta * rule.amountPerQuantum,
    }));
  }
  const lineTotal = lineItems.reduce((total, line) => total + line.amount, 0n);
  const ratedAmount = lineTotal < policy.minimumAmount ? policy.minimumAmount : lineTotal;
  return Object.freeze({
    kind: "rated",
    policyRatedAmount: ratedAmount,
    lineItems: Object.freeze(lineItems),
  });
}

function validateProvidedDimensions(
  policy: RatingPolicyRevision,
  sourceDimensions: readonly UsageDimension[],
): void {
  if (sourceDimensions.length > 64) throw new Error("CREDIT_USAGE_DIMENSIONS_INVALID");
  const rules = new Map(policy.rules.map((rule) => [rule.dimensionKey, rule]));
  const keys = new Set<string>();
  for (const dimension of sourceDimensions) {
    validateKey(dimension.dimensionKey, "CREDIT_USAGE_DIMENSION_KEY_INVALID");
    validateKey(dimension.sourceUnit, "CREDIT_USAGE_DIMENSION_UNIT_INVALID");
    if (dimension.quantity < 0n) throw new Error("CREDIT_USAGE_DIMENSION_QUANTITY_INVALID");
    if (keys.has(dimension.dimensionKey)) throw new Error("CREDIT_USAGE_DIMENSION_DUPLICATE");
    const rule = rules.get(dimension.dimensionKey);
    if (rule === undefined) throw new Error("CREDIT_USAGE_DIMENSION_NOT_RATABLE");
    if (dimension.sourceUnit !== rule.sourceUnit) throw new Error("CREDIT_USAGE_DIMENSION_UNIT_MISMATCH");
    keys.add(dimension.dimensionKey);
  }
}

function ratedResult(
  ratedAmount: bigint,
  committedMaximum: bigint,
  lineItems: readonly RatedUsageLineItem[],
): Extract<UsageRatingResult, { kind: "rated" | "over_ceiling" }> {
  if (ratedAmount <= committedMaximum) {
    return Object.freeze({
      kind: "rated",
      customerAmount: ratedAmount,
      platformExposureAmount: 0n,
      lineItems: Object.freeze([...lineItems]),
    });
  }
  return Object.freeze({
    kind: "over_ceiling",
    customerAmount: committedMaximum,
    platformExposureAmount: ratedAmount - committedMaximum,
    lineItems: Object.freeze([...lineItems]),
  });
}

function validatePolicy(policy: RatingPolicyRevision): void {
  validateKey(policy.ratingPolicyRevisionRef, "CREDIT_RATING_POLICY_REFERENCE_INVALID");
  validateKey(policy.customerUnit, "CREDIT_RATING_POLICY_UNIT_INVALID");
  if (policy.minimumAmount < 0n || policy.rules.length < 1 || policy.rules.length > 64) {
    throw new Error("CREDIT_RATING_POLICY_INVALID");
  }
  if (policy.chargeableAttemptOutcomes.length < 1 ||
      new Set(policy.chargeableAttemptOutcomes).size !== policy.chargeableAttemptOutcomes.length) {
    throw new Error("CREDIT_RATING_POLICY_OUTCOMES_INVALID");
  }
  const keys = new Set<string>();
  for (const rule of policy.rules) {
    validateKey(rule.dimensionKey, "CREDIT_RATING_POLICY_DIMENSION_INVALID");
    validateKey(rule.sourceUnit, "CREDIT_RATING_POLICY_SOURCE_UNIT_INVALID");
    if (keys.has(rule.dimensionKey) || rule.quantum <= 0n || rule.amountPerQuantum < 0n) {
      throw new Error("CREDIT_RATING_POLICY_RULE_INVALID");
    }
    keys.add(rule.dimensionKey);
  }
}

function validateEvidenceIdentity(evidence: AttemptUsageEvidence): void {
  assertUsageProducerKind(evidence.producerKind);
  [evidence.producerContext, evidence.attemptRef, evidence.logicalEffectRef,
    evidence.authorizationSegmentRef, evidence.executionManifestRef]
    .forEach((value) => validateKey(value, "CREDIT_USAGE_REFERENCE_INVALID"));
  if (evidence.producerGeneration <= 0n || evidence.revision <= 0n) {
    throw new Error("CREDIT_USAGE_REVISION_INVALID");
  }
  if (evidence.correctionOfEvidenceRef !== null) {
    validateKey(evidence.correctionOfEvidenceRef, "CREDIT_USAGE_CORRECTION_REFERENCE_INVALID");
  }
  if (!/^[a-f0-9]{64}$/u.test(evidence.sourceDigest)) throw new Error("CREDIT_USAGE_SOURCE_DIGEST_INVALID");
  if (!Number.isFinite(Date.parse(evidence.occurredAt))) throw new Error("CREDIT_USAGE_OCCURRED_AT_INVALID");
}

function validateKey(value: string, code: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value)) throw new Error(code);
}

function divideRoundUp(quantity: bigint, quantum: bigint): bigint {
  return quantity === 0n ? 0n : (quantity + quantum - 1n) / quantum;
}
