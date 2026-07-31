export const MEDIA_OPERATION_RECONCILIATION_REASONS = Object.freeze([
  "submission_unknown",
  "outcome_unknown",
  "finalization_unknown",
] as const);

export const MEDIA_STEP_RECONCILIATION_REASONS = Object.freeze([
  "submission_unknown",
  "outcome_unknown",
  "lease_lost",
] as const);

export const MEDIA_CANDIDATE_UNKNOWN_REASONS = Object.freeze([
  "submission_unknown",
  "outcome_unknown",
  "finalization_unknown",
] as const);

export const MEDIA_STEP_FAILURE_CAUSES = Object.freeze([
  "gateway_effect_failed",
  "candidate_finalization_failed",
  "orchestration_failed",
] as const);

export const MEDIA_CANDIDATE_POST_OUTPUT_FAILURE_CAUSES = Object.freeze([
  "provider_output_invalid",
  "artifact_finalization_failed",
  "trust_evaluation_failed",
] as const);

export const MEDIA_CANDIDATE_PRE_OUTPUT_FAILURE_CAUSES = Object.freeze([
  "gateway_effect_failed",
  "gateway_outcome_irreconcilable",
] as const);

export const MEDIA_CANCELLATION_CAUSES = Object.freeze([
  "gateway_effect_canceled",
  "operation_cancel_confirmed",
] as const);

export const GATEWAY_EFFECT_FAILURE_CAUSES = Object.freeze([
  "provider_rejected",
  "provider_failed",
  "provider_output_unavailable",
] as const);

export const GATEWAY_IRRECONCILABLE_REASONS = Object.freeze([
  "submission_deadline_exceeded",
  "outcome_deadline_exceeded",
  "finalization_deadline_exceeded",
] as const);

export type MediaOperationReconciliationReason =
  typeof MEDIA_OPERATION_RECONCILIATION_REASONS[number];
export type MediaStepReconciliationReason = typeof MEDIA_STEP_RECONCILIATION_REASONS[number];
export type MediaCandidateUnknownReason = typeof MEDIA_CANDIDATE_UNKNOWN_REASONS[number];
export type MediaStepFailureCause = typeof MEDIA_STEP_FAILURE_CAUSES[number];
export type MediaCandidatePostOutputFailureCause =
  typeof MEDIA_CANDIDATE_POST_OUTPUT_FAILURE_CAUSES[number];
export type MediaCandidatePreOutputFailureCause =
  typeof MEDIA_CANDIDATE_PRE_OUTPUT_FAILURE_CAUSES[number];
export type MediaCandidateFailureCause =
  | MediaCandidatePostOutputFailureCause
  | MediaCandidatePreOutputFailureCause;
export type MediaCancellationCause = typeof MEDIA_CANCELLATION_CAUSES[number];
export type GatewayEffectFailureCause = typeof GATEWAY_EFFECT_FAILURE_CAUSES[number];
export type GatewayIrreconcilableReason = typeof GATEWAY_IRRECONCILABLE_REASONS[number];

export function isMediaOperationReconciliationReason(
  value: unknown,
): value is MediaOperationReconciliationReason {
  return isVocabularyMember(MEDIA_OPERATION_RECONCILIATION_REASONS, value);
}

export function isMediaStepReconciliationReason(value: unknown): value is MediaStepReconciliationReason {
  return isVocabularyMember(MEDIA_STEP_RECONCILIATION_REASONS, value);
}

export function isMediaCandidateUnknownReason(value: unknown): value is MediaCandidateUnknownReason {
  return isVocabularyMember(MEDIA_CANDIDATE_UNKNOWN_REASONS, value);
}

export function isMediaStepFailureCause(value: unknown): value is MediaStepFailureCause {
  return isVocabularyMember(MEDIA_STEP_FAILURE_CAUSES, value);
}

export function isMediaCandidatePostOutputFailureCause(
  value: unknown,
): value is MediaCandidatePostOutputFailureCause {
  return isVocabularyMember(MEDIA_CANDIDATE_POST_OUTPUT_FAILURE_CAUSES, value);
}

export function isMediaCandidateFailureCause(value: unknown): value is MediaCandidateFailureCause {
  return isMediaCandidatePostOutputFailureCause(value) ||
    isVocabularyMember(MEDIA_CANDIDATE_PRE_OUTPUT_FAILURE_CAUSES, value);
}

export function isMediaCancellationCause(value: unknown): value is MediaCancellationCause {
  return isVocabularyMember(MEDIA_CANCELLATION_CAUSES, value);
}

export function isGatewayEffectFailureCause(value: unknown): value is GatewayEffectFailureCause {
  return isVocabularyMember(GATEWAY_EFFECT_FAILURE_CAUSES, value);
}

export function isGatewayIrreconcilableReason(value: unknown): value is GatewayIrreconcilableReason {
  return isVocabularyMember(GATEWAY_IRRECONCILABLE_REASONS, value);
}

function isVocabularyMember<const Values extends readonly string[]>(
  values: Values,
  value: unknown,
): value is Values[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}
