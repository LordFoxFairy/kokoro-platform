import { hasControlCharacter, isWellFormedUtf16 } from "./text-validation.js";

declare const mediaOperationRefBrand: unique symbol;
declare const mediaStepRefBrand: unique symbol;
declare const mediaCandidateRefBrand: unique symbol;
declare const operationDefinitionRevisionRefBrand: unique symbol;
declare const operationInputRevisionRefBrand: unique symbol;
declare const mediaReceiptRefBrand: unique symbol;
declare const providerOutputFactRefBrand: unique symbol;
declare const artifactVersionRefBrand: unique symbol;
declare const artifactFinalizationReceiptRefBrand: unique symbol;
declare const trustDecisionRefBrand: unique symbol;
declare const attemptUsageEvidenceReceiptRefBrand: unique symbol;
declare const effectBudgetCommitRefBrand: unique symbol;
declare const irreconcilableOutcomeReceiptRefBrand: unique symbol;
declare const modelInvocationRefBrand: unique symbol;
declare const gatewayCanonicalOutcomeReceiptRefBrand: unique symbol;

export type MediaOperationRef = string & Readonly<{ [mediaOperationRefBrand]: true }>;
export type MediaStepRef = string & Readonly<{ [mediaStepRefBrand]: true }>;
export type MediaCandidateRef = string & Readonly<{ [mediaCandidateRefBrand]: true }>;
export type OperationDefinitionRevisionRef = string & Readonly<{
  [operationDefinitionRevisionRefBrand]: true;
}>;
export type OperationInputRevisionRef = string & Readonly<{ [operationInputRevisionRefBrand]: true }>;
export type MediaReceiptRef = string & Readonly<{ [mediaReceiptRefBrand]: true }>;
export type ProviderOutputFactRef = string & Readonly<{ [providerOutputFactRefBrand]: true }>;
export type ArtifactVersionRef = string & Readonly<{ [artifactVersionRefBrand]: true }>;
export type ArtifactFinalizationReceiptRef = string & Readonly<{
  [artifactFinalizationReceiptRefBrand]: true;
}>;
export type TrustDecisionRef = string & Readonly<{ [trustDecisionRefBrand]: true }>;
export type AttemptUsageEvidenceReceiptRef = string & Readonly<{
  [attemptUsageEvidenceReceiptRefBrand]: true;
}>;
export type EffectBudgetCommitRef = string & Readonly<{ [effectBudgetCommitRefBrand]: true }>;
export type IrreconcilableOutcomeReceiptRef = string & Readonly<{
  [irreconcilableOutcomeReceiptRefBrand]: true;
}>;
export type ModelInvocationRef = string & Readonly<{ [modelInvocationRefBrand]: true }>;
export type GatewayCanonicalOutcomeReceiptRef = string & Readonly<{
  [gatewayCanonicalOutcomeReceiptRefBrand]: true;
}>;

export function mediaOperationRef(value: string): MediaOperationRef {
  return opaqueReference(value, "MEDIA_OPERATION_REF_INVALID") as MediaOperationRef;
}

export function mediaStepRef(value: string): MediaStepRef {
  return opaqueReference(value, "MEDIA_STEP_REF_INVALID") as MediaStepRef;
}

export function mediaCandidateRef(value: string): MediaCandidateRef {
  return opaqueReference(value, "MEDIA_CANDIDATE_REF_INVALID") as MediaCandidateRef;
}

export function operationDefinitionRevisionRef(value: string): OperationDefinitionRevisionRef {
  return opaqueReference(value, "MEDIA_DEFINITION_REVISION_REF_INVALID") as OperationDefinitionRevisionRef;
}

export function operationInputRevisionRef(value: string): OperationInputRevisionRef {
  return opaqueReference(value, "MEDIA_INPUT_REVISION_REF_INVALID") as OperationInputRevisionRef;
}

export function mediaReceiptRef(value: string): MediaReceiptRef {
  return opaqueReference(value, "MEDIA_RECEIPT_REF_INVALID") as MediaReceiptRef;
}

export function providerOutputFactRef(value: string): ProviderOutputFactRef {
  return opaqueReference(value, "MEDIA_PROVIDER_OUTPUT_FACT_REF_INVALID") as ProviderOutputFactRef;
}

export function artifactVersionRef(value: string): ArtifactVersionRef {
  return opaqueReference(value, "MEDIA_ARTIFACT_VERSION_REF_INVALID") as ArtifactVersionRef;
}

export function artifactFinalizationReceiptRef(value: string): ArtifactFinalizationReceiptRef {
  return opaqueReference(value, "MEDIA_ARTIFACT_FINALIZATION_RECEIPT_REF_INVALID") as ArtifactFinalizationReceiptRef;
}

export function trustDecisionRef(value: string): TrustDecisionRef {
  return opaqueReference(value, "MEDIA_TRUST_DECISION_REF_INVALID") as TrustDecisionRef;
}

export function attemptUsageEvidenceReceiptRef(value: string): AttemptUsageEvidenceReceiptRef {
  return opaqueReference(value, "MEDIA_USAGE_EVIDENCE_RECEIPT_REF_INVALID") as AttemptUsageEvidenceReceiptRef;
}

export function effectBudgetCommitRef(value: string): EffectBudgetCommitRef {
  return opaqueReference(value, "MEDIA_EFFECT_BUDGET_COMMIT_REF_INVALID") as EffectBudgetCommitRef;
}

export function irreconcilableOutcomeReceiptRef(value: string): IrreconcilableOutcomeReceiptRef {
  return opaqueReference(value, "MEDIA_IRRECONCILABLE_OUTCOME_RECEIPT_REF_INVALID") as
    IrreconcilableOutcomeReceiptRef;
}

export function modelInvocationRef(value: string): ModelInvocationRef {
  return opaqueReference(value, "MEDIA_MODEL_INVOCATION_REF_INVALID") as ModelInvocationRef;
}

export function gatewayCanonicalOutcomeReceiptRef(value: string): GatewayCanonicalOutcomeReceiptRef {
  return opaqueReference(value, "MEDIA_GATEWAY_CANONICAL_OUTCOME_RECEIPT_REF_INVALID") as
    GatewayCanonicalOutcomeReceiptRef;
}

function opaqueReference(value: string, code: string): string {
  assertOpaqueReferenceValue(value, code);
  return value;
}

export function isOpaqueReferenceValue(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 &&
    isWellFormedUtf16(value) && !hasControlCharacter(value);
}

export function assertOpaqueReferenceValue(value: unknown, code: string): asserts value is string {
  if (!isOpaqueReferenceValue(value)) throw new Error(code);
}
