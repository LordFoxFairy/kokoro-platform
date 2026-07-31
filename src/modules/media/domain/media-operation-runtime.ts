import {
  MAXIMUM_MEDIA_DEFINITION_CANDIDATES,
  MAXIMUM_MEDIA_DEFINITION_STEPS,
  rehydrateCompiledOperationDefinitionRevision,
  validateDefinitionKey,
} from "./operation-definition.js";
import {
  assertOpaqueReferenceValue,
  artifactFinalizationReceiptRef,
  artifactVersionRef,
  attemptUsageEvidenceReceiptRef,
  effectBudgetCommitRef,
  gatewayCanonicalOutcomeReceiptRef,
  irreconcilableOutcomeReceiptRef,
  mediaCandidateRef,
  mediaOperationRef,
  mediaReceiptRef,
  mediaStepRef,
  modelInvocationRef,
  operationDefinitionRevisionRef,
  operationInputRevisionRef,
  providerOutputFactRef,
  trustDecisionRef,
} from "./references.js";
import {
  isGatewayEffectFailureCause,
  isGatewayIrreconcilableReason,
  isMediaCandidateFailureCause,
  isMediaCandidatePostOutputFailureCause,
  isMediaCandidateUnknownReason,
  isMediaCancellationCause,
  isMediaOperationReconciliationReason,
  isMediaStepFailureCause,
  isMediaStepReconciliationReason,
  type MediaCandidateFailureCause,
  type MediaCandidatePostOutputFailureCause,
} from "./media-vocabulary.js";
import {
  snapshotDataRecord,
  snapshotDenseArray,
  snapshotExactDataRecord,
} from "./runtime-validation.js";
import type {
  MediaCandidate,
  MediaCandidateState,
  MediaGatewayEffectClosure,
  MediaOperation,
  MediaOperationCanonicalFailureCause,
  MediaOperationClosure,
  MediaOperationNonTerminalState,
  MediaOperationPlanInput,
  MediaOperationState,
  MediaStep,
  MediaStepState,
} from "./media-operation.js";

type UnknownRecord = Readonly<Record<string, unknown>>;
type ReferenceFactory<Reference extends string> = (value: string) => Reference;

export function rehydrateMediaOperationPlanInput(value: unknown): MediaOperationPlanInput {
  const record = strictRecord(value, ["operationRef", "operationInputRevisionRef", "definition", "steps",
    "candidates"], "MEDIA_OPERATION_PLAN_INPUT_INVALID");
  const rawSteps = boundedArray(record.steps, MAXIMUM_MEDIA_DEFINITION_STEPS,
    "MEDIA_OPERATION_PLAN_INPUT_INVALID");
  const rawCandidates = boundedArray(record.candidates, MAXIMUM_MEDIA_DEFINITION_CANDIDATES,
    "MEDIA_OPERATION_PLAN_INPUT_INVALID");
  const steps = rawSteps.map((value) => {
    const allocation = strictRecord(value, ["definitionStepKey", "stepRef"],
      "MEDIA_OPERATION_PLAN_ALLOCATION_INVALID");
    return Object.freeze({
      definitionStepKey: validateDefinitionKey(allocation.definitionStepKey,
        "MEDIA_OPERATION_PLAN_ALLOCATION_INVALID"),
      stepRef: reference(allocation.stepRef, mediaStepRef, "MEDIA_STEP_REF_INVALID"),
    });
  });
  const candidates = rawCandidates.map((value) => {
    const allocation = strictRecord(value, ["definitionStepKey", "outputSlot", "candidateRef"],
      "MEDIA_OPERATION_PLAN_ALLOCATION_INVALID");
    return Object.freeze({
      definitionStepKey: validateDefinitionKey(allocation.definitionStepKey,
        "MEDIA_OPERATION_PLAN_ALLOCATION_INVALID"),
      outputSlot: validateDefinitionKey(allocation.outputSlot, "MEDIA_OPERATION_PLAN_ALLOCATION_INVALID"),
      candidateRef: reference(allocation.candidateRef, mediaCandidateRef, "MEDIA_CANDIDATE_REF_INVALID"),
    });
  });
  return Object.freeze({
    operationRef: reference(record.operationRef, mediaOperationRef, "MEDIA_OPERATION_REF_INVALID"),
    operationInputRevisionRef: reference(record.operationInputRevisionRef, operationInputRevisionRef,
      "MEDIA_INPUT_REVISION_REF_INVALID"),
    definition: rehydrateCompiledOperationDefinitionRevision(record.definition),
    steps: Object.freeze(steps),
    candidates: Object.freeze(candidates),
  });
}

export function rehydrateMediaOperation(value: unknown): MediaOperation {
  const record = strictRecord(value, ["operationRef", "definitionRevisionRef", "operationInputRevisionRef",
    "expectedVersion", "state"], "MEDIA_OPERATION_INVALID");
  let state: MediaOperationState;
  try {
    state = rehydrateMediaOperationState(record.state);
  } catch {
    throw new Error("MEDIA_OPERATION_INVALID");
  }
  return Object.freeze({
    operationRef: reference(record.operationRef, mediaOperationRef, "MEDIA_OPERATION_INVALID"),
    definitionRevisionRef: reference(record.definitionRevisionRef, operationDefinitionRevisionRef,
      "MEDIA_OPERATION_INVALID"),
    operationInputRevisionRef: reference(record.operationInputRevisionRef, operationInputRevisionRef,
      "MEDIA_OPERATION_INVALID"),
    expectedVersion: positiveVersion(record.expectedVersion, "MEDIA_OPERATION_INVALID"),
    state,
  });
}

export function rehydrateMediaOperationNonTerminalState(value: unknown): MediaOperationNonTerminalState {
  const state = rehydrateMediaOperationState(value);
  switch (state.kind) {
    case "admission_pending":
    case "authorized":
    case "queued":
    case "active":
    case "finalizing":
    case "cancel_requested":
    case "reconciling": return state;
    case "completed":
    case "partial":
    case "failed":
    case "canceled": throw new Error("MEDIA_OPERATION_STATE_INVALID");
  }
}

export function rehydrateMediaStep(value: unknown): MediaStep {
  const record = strictRecord(value, ["stepRef", "operationRef", "definitionStepKey", "required",
    "expectedVersion", "state"], "MEDIA_STEP_INVALID");
  let state: MediaStepState;
  try {
    state = rehydrateMediaStepState(record.state);
  } catch {
    throw new Error("MEDIA_STEP_INVALID");
  }
  if (typeof record.required !== "boolean") throw new Error("MEDIA_STEP_INVALID");
  return Object.freeze({
    stepRef: reference(record.stepRef, mediaStepRef, "MEDIA_STEP_INVALID"),
    operationRef: reference(record.operationRef, mediaOperationRef, "MEDIA_STEP_INVALID"),
    definitionStepKey: validateDefinitionKey(record.definitionStepKey, "MEDIA_STEP_INVALID"),
    required: record.required,
    expectedVersion: positiveVersion(record.expectedVersion, "MEDIA_STEP_INVALID"),
    state,
  });
}

export function rehydrateMediaStepState(value: unknown): MediaStepState {
  const record = plainRecord(value, "MEDIA_STEP_STATE_INVALID");
  switch (record.kind) {
    case "blocked":
    case "ready":
    case "leased":
    case "running":
    case "provider_async":
    case "finalizing":
      strictRecord(record, ["kind"], "MEDIA_STEP_STATE_INVALID");
      return Object.freeze({ kind: record.kind });
    case "reconciling": {
      const state = strictRecord(record, ["kind", "reason", "unknownReceiptRef"],
        "MEDIA_STEP_STATE_INVALID");
      if (!isMediaStepReconciliationReason(state.reason)) throw new Error("MEDIA_STEP_STATE_INVALID");
      return Object.freeze({ kind: "reconciling", reason: state.reason,
        unknownReceiptRef: reference(state.unknownReceiptRef, mediaReceiptRef, "MEDIA_STEP_STATE_INVALID") });
    }
    case "completed": {
      const state = strictRecord(record, ["kind", "completionReceiptRef"], "MEDIA_STEP_STATE_INVALID");
      return Object.freeze({ kind: "completed", completionReceiptRef: reference(
        state.completionReceiptRef, mediaReceiptRef, "MEDIA_STEP_STATE_INVALID",
      ) });
    }
    case "failed": {
      const state = strictRecord(record, ["kind", "failureCause", "failureReceiptRef"],
        "MEDIA_STEP_STATE_INVALID");
      if (!isMediaStepFailureCause(state.failureCause)) throw new Error("MEDIA_STEP_STATE_INVALID");
      return Object.freeze({ kind: "failed", failureCause: state.failureCause,
        failureReceiptRef: reference(state.failureReceiptRef, mediaReceiptRef, "MEDIA_STEP_STATE_INVALID") });
    }
    case "canceled": {
      const state = strictRecord(record, ["kind", "cancellationCause", "cancellationReceiptRef"],
        "MEDIA_STEP_STATE_INVALID");
      if (!isMediaCancellationCause(state.cancellationCause)) throw new Error("MEDIA_STEP_STATE_INVALID");
      return Object.freeze({ kind: "canceled", cancellationCause: state.cancellationCause,
        cancellationReceiptRef: reference(state.cancellationReceiptRef, mediaReceiptRef,
          "MEDIA_STEP_STATE_INVALID") });
    }
    default: throw new Error("MEDIA_STEP_STATE_INVALID");
  }
}

export function rehydrateMediaCandidate(value: unknown): MediaCandidate {
  const record = strictRecord(value, ["candidateRef", "operationRef", "stepRef", "definitionStepKey",
    "outputSlot", "required", "expectedVersion", "state"], "MEDIA_CANDIDATE_INVALID");
  let state: MediaCandidateState;
  try {
    state = rehydrateMediaCandidateState(record.state);
  } catch {
    throw new Error("MEDIA_CANDIDATE_INVALID");
  }
  if (typeof record.required !== "boolean") throw new Error("MEDIA_CANDIDATE_INVALID");
  return Object.freeze({
    candidateRef: reference(record.candidateRef, mediaCandidateRef, "MEDIA_CANDIDATE_INVALID"),
    operationRef: reference(record.operationRef, mediaOperationRef, "MEDIA_CANDIDATE_INVALID"),
    stepRef: reference(record.stepRef, mediaStepRef, "MEDIA_CANDIDATE_INVALID"),
    definitionStepKey: validateDefinitionKey(record.definitionStepKey, "MEDIA_CANDIDATE_INVALID"),
    outputSlot: validateDefinitionKey(record.outputSlot, "MEDIA_CANDIDATE_INVALID"),
    required: record.required,
    expectedVersion: positiveVersion(record.expectedVersion, "MEDIA_CANDIDATE_INVALID"),
    state,
  });
}

export function rehydrateMediaCandidateState(value: unknown): MediaCandidateState {
  const record = plainRecord(value, "MEDIA_CANDIDATE_STATE_INVALID");
  switch (record.kind) {
    case "allocated":
    case "producing":
      strictRecord(record, ["kind"], "MEDIA_CANDIDATE_STATE_INVALID");
      return Object.freeze({ kind: record.kind });
    case "output_received":
    case "validating": {
      const state = strictRecord(record, ["kind", "providerOutputFactRef"],
        "MEDIA_CANDIDATE_STATE_INVALID");
      return Object.freeze({ kind: record.kind, providerOutputFactRef: reference(
        state.providerOutputFactRef, providerOutputFactRef, "MEDIA_CANDIDATE_STATE_INVALID",
      ) });
    }
    case "ready": {
      const state = strictRecord(record, ["kind", "providerOutputFactRef", "artifactFinalizationCandidateRef",
        "artifactVersionRef", "artifactFinalizationReceiptRef", "trustDecisionRef",
        "attemptUsageEvidenceReceiptRef", "effectBudgetCommitRef"], "MEDIA_CANDIDATE_STATE_INVALID");
      return Object.freeze({
        kind: "ready",
        providerOutputFactRef: reference(state.providerOutputFactRef, providerOutputFactRef,
          "MEDIA_CANDIDATE_STATE_INVALID"),
        artifactFinalizationCandidateRef: reference(state.artifactFinalizationCandidateRef, mediaCandidateRef,
          "MEDIA_CANDIDATE_STATE_INVALID"),
        artifactVersionRef: reference(state.artifactVersionRef, artifactVersionRef,
          "MEDIA_CANDIDATE_STATE_INVALID"),
        artifactFinalizationReceiptRef: reference(state.artifactFinalizationReceiptRef,
          artifactFinalizationReceiptRef, "MEDIA_CANDIDATE_STATE_INVALID"),
        trustDecisionRef: reference(state.trustDecisionRef, trustDecisionRef, "MEDIA_CANDIDATE_STATE_INVALID"),
        attemptUsageEvidenceReceiptRef: reference(state.attemptUsageEvidenceReceiptRef,
          attemptUsageEvidenceReceiptRef, "MEDIA_CANDIDATE_STATE_INVALID"),
        effectBudgetCommitRef: reference(state.effectBudgetCommitRef, effectBudgetCommitRef,
          "MEDIA_CANDIDATE_STATE_INVALID"),
      });
    }
    case "restricted": {
      const state = strictRecord(record, ["kind", "providerOutputFactRef", "restrictionReceiptRef"],
        "MEDIA_CANDIDATE_STATE_INVALID");
      return Object.freeze({ kind: "restricted",
        providerOutputFactRef: reference(state.providerOutputFactRef, providerOutputFactRef,
          "MEDIA_CANDIDATE_STATE_INVALID"),
        restrictionReceiptRef: reference(state.restrictionReceiptRef, mediaReceiptRef,
          "MEDIA_CANDIDATE_STATE_INVALID") });
    }
    case "failed": {
      const withProviderFact = Object.hasOwn(record, "providerOutputFactRef");
      const state = strictRecord(record, withProviderFact
        ? ["kind", "providerOutputFactRef", "failureCause", "failureReceiptRef"]
        : ["kind", "failureCause", "failureReceiptRef"], "MEDIA_CANDIDATE_STATE_INVALID");
      if (!isMediaCandidateFailureCause(state.failureCause)) throw new Error("MEDIA_CANDIDATE_STATE_INVALID");
      const failureReceiptRef = reference(state.failureReceiptRef, mediaReceiptRef,
        "MEDIA_CANDIDATE_STATE_INVALID");
      if (mediaCandidateFailureRequiresProviderFact(state.failureCause)) {
        if (!withProviderFact) throw new Error("MEDIA_CANDIDATE_STATE_INVALID");
        return Object.freeze({ kind: "failed",
          providerOutputFactRef: reference(state.providerOutputFactRef, providerOutputFactRef,
            "MEDIA_CANDIDATE_STATE_INVALID"),
          failureCause: state.failureCause, failureReceiptRef });
      }
      if (withProviderFact) throw new Error("MEDIA_CANDIDATE_STATE_INVALID");
      return Object.freeze({ kind: "failed", failureCause: state.failureCause, failureReceiptRef });
    }
    case "cancel_requested": {
      const state = strictRecord(record, ["kind", "cancelIntentReceiptRef"],
        "MEDIA_CANDIDATE_STATE_INVALID");
      return Object.freeze({ kind: "cancel_requested", cancelIntentReceiptRef: reference(
        state.cancelIntentReceiptRef, mediaReceiptRef, "MEDIA_CANDIDATE_STATE_INVALID",
      ) });
    }
    case "canceled": {
      const state = strictRecord(record, ["kind", "cancellationCause", "cancellationReceiptRef"],
        "MEDIA_CANDIDATE_STATE_INVALID");
      if (!isMediaCancellationCause(state.cancellationCause)) throw new Error("MEDIA_CANDIDATE_STATE_INVALID");
      return Object.freeze({ kind: "canceled", cancellationCause: state.cancellationCause,
        cancellationReceiptRef: reference(state.cancellationReceiptRef, mediaReceiptRef,
          "MEDIA_CANDIDATE_STATE_INVALID") });
    }
    case "unknown": {
      if (record.reason === "finalization_unknown") {
        const state = strictRecord(record, ["kind", "reason", "providerOutputFactRef", "unknownReceiptRef"],
          "MEDIA_CANDIDATE_STATE_INVALID");
        return Object.freeze({ kind: "unknown", reason: "finalization_unknown",
          providerOutputFactRef: reference(state.providerOutputFactRef, providerOutputFactRef,
            "MEDIA_CANDIDATE_STATE_INVALID"),
          unknownReceiptRef: reference(state.unknownReceiptRef, mediaReceiptRef,
            "MEDIA_CANDIDATE_STATE_INVALID") });
      }
      const state = strictRecord(record, ["kind", "reason", "unknownReceiptRef"],
        "MEDIA_CANDIDATE_STATE_INVALID");
      if (!isMediaCandidateUnknownReason(state.reason) || state.reason === "finalization_unknown") {
        throw new Error("MEDIA_CANDIDATE_STATE_INVALID");
      }
      return Object.freeze({ kind: "unknown", reason: state.reason,
        unknownReceiptRef: reference(state.unknownReceiptRef, mediaReceiptRef,
          "MEDIA_CANDIDATE_STATE_INVALID") });
    }
    default: throw new Error("MEDIA_CANDIDATE_STATE_INVALID");
  }
}

export function rehydrateMediaOperationClosure(value: unknown): MediaOperationClosure {
  const record = strictRecord(value, ["definition", "steps", "candidates", "effects"],
    "MEDIA_OPERATION_CLOSURE_INVALID");
  const rawSteps = boundedArray(record.steps, MAXIMUM_MEDIA_DEFINITION_STEPS,
    "MEDIA_OPERATION_CLOSURE_INVALID");
  const rawCandidates = boundedArray(record.candidates, MAXIMUM_MEDIA_DEFINITION_CANDIDATES,
    "MEDIA_OPERATION_CLOSURE_INVALID");
  const rawEffects = boundedArray(record.effects, MAXIMUM_MEDIA_DEFINITION_CANDIDATES,
    "MEDIA_OPERATION_CLOSURE_INVALID");
  return Object.freeze({
    definition: rehydrateCompiledOperationDefinitionRevision(record.definition),
    steps: Object.freeze(rawSteps.map(rehydrateMediaStep)),
    candidates: Object.freeze(rawCandidates.map(rehydrateMediaCandidate)),
    effects: Object.freeze(rawEffects.map(rehydrateMediaGatewayEffectClosure)),
  });
}

export function mediaCandidateFailureRequiresProviderFact(
  cause: MediaCandidateFailureCause,
): cause is MediaCandidatePostOutputFailureCause {
  return isMediaCandidatePostOutputFailureCause(cause);
}

export function mediaCandidateFailureEvidenceValid(
  state: Extract<MediaCandidateState, { kind: "failed" }>,
): boolean {
  return mediaCandidateFailureRequiresProviderFact(state.failureCause) ===
    ("providerOutputFactRef" in state && state.providerOutputFactRef !== undefined);
}

export function rehydrateExpectedVersion(value: unknown): bigint {
  return positiveVersion(value, "MEDIA_EXPECTED_VERSION_INVALID");
}

function rehydrateMediaOperationState(value: unknown): MediaOperationState {
  const record = plainRecord(value, "MEDIA_OPERATION_STATE_INVALID");
  switch (record.kind) {
    case "admission_pending":
    case "authorized":
    case "queued":
    case "active":
    case "finalizing":
      strictRecord(record, ["kind"], "MEDIA_OPERATION_STATE_INVALID");
      return Object.freeze({ kind: record.kind });
    case "cancel_requested": {
      const state = strictRecord(record, ["kind", "cancelIntentReceiptRef"],
        "MEDIA_OPERATION_STATE_INVALID");
      return Object.freeze({ kind: "cancel_requested", cancelIntentReceiptRef: reference(
        state.cancelIntentReceiptRef, mediaReceiptRef, "MEDIA_OPERATION_STATE_INVALID",
      ) });
    }
    case "reconciling": {
      const state = strictRecord(record, ["kind", "reason", "unknownReceiptRef"],
        "MEDIA_OPERATION_STATE_INVALID");
      if (!isMediaOperationReconciliationReason(state.reason)) {
        throw new Error("MEDIA_OPERATION_STATE_INVALID");
      }
      return Object.freeze({ kind: "reconciling", reason: state.reason,
        unknownReceiptRef: reference(state.unknownReceiptRef, mediaReceiptRef,
          "MEDIA_OPERATION_STATE_INVALID") });
    }
    case "completed":
    case "partial": {
      const state = strictRecord(record, ["kind", "terminalReceiptRef", "outcomeClass"],
        "MEDIA_OPERATION_STATE_INVALID");
      if (state.outcomeClass !== "canonical") throw new Error("MEDIA_OPERATION_STATE_INVALID");
      return Object.freeze({ kind: record.kind, terminalReceiptRef: reference(
        state.terminalReceiptRef, mediaReceiptRef, "MEDIA_OPERATION_STATE_INVALID",
      ), outcomeClass: "canonical" });
    }
    case "canceled": {
      const state = strictRecord(record, ["kind", "terminalReceiptRef", "outcomeClass", "cause"],
        "MEDIA_OPERATION_STATE_INVALID");
      if (state.outcomeClass !== "canonical") throw new Error("MEDIA_OPERATION_STATE_INVALID");
      const cause = strictRecord(state.cause, ["kind", "modelInvocationRef", "cancellationReceiptRef",
        "gatewayOutcomeReceiptRef"], "MEDIA_OPERATION_STATE_INVALID");
      if (cause.kind !== "gateway_effects_canceled") throw new Error("MEDIA_OPERATION_STATE_INVALID");
      return Object.freeze({ kind: "canceled", terminalReceiptRef: reference(
        state.terminalReceiptRef, mediaReceiptRef, "MEDIA_OPERATION_STATE_INVALID",
      ), outcomeClass: "canonical", cause: Object.freeze({ kind: "gateway_effects_canceled",
        modelInvocationRef: reference(cause.modelInvocationRef, modelInvocationRef,
          "MEDIA_OPERATION_STATE_INVALID"),
        cancellationReceiptRef: reference(cause.cancellationReceiptRef, mediaReceiptRef,
          "MEDIA_OPERATION_STATE_INVALID"),
        gatewayOutcomeReceiptRef: reference(cause.gatewayOutcomeReceiptRef, gatewayCanonicalOutcomeReceiptRef,
          "MEDIA_OPERATION_STATE_INVALID") }) });
    }
    case "failed": return rehydrateFailedOperationState(record);
    default: throw new Error("MEDIA_OPERATION_STATE_INVALID");
  }
}

function rehydrateFailedOperationState(record: UnknownRecord): MediaOperationState {
  const state = strictRecord(record, ["kind", "terminalReceiptRef", "outcomeClass", "cause"],
    "MEDIA_OPERATION_STATE_INVALID");
  const terminalReceiptRef = reference(state.terminalReceiptRef, mediaReceiptRef,
    "MEDIA_OPERATION_STATE_INVALID");
  if (state.outcomeClass === "canonical") {
    return Object.freeze({ kind: "failed", terminalReceiptRef, outcomeClass: "canonical",
      cause: rehydrateCanonicalFailureCause(state.cause) });
  }
  if (state.outcomeClass !== "irreconcilable") throw new Error("MEDIA_OPERATION_STATE_INVALID");
  const cause = strictRecord(state.cause, ["kind", "modelInvocationRef", "reason",
    "irreconcilableOutcomeReceiptRef"], "MEDIA_OPERATION_STATE_INVALID");
  if (cause.kind !== "gateway_effect_irreconcilable" || !isGatewayIrreconcilableReason(cause.reason)) {
    throw new Error("MEDIA_OPERATION_STATE_INVALID");
  }
  return Object.freeze({ kind: "failed", terminalReceiptRef, outcomeClass: "irreconcilable",
    cause: Object.freeze({ kind: "gateway_effect_irreconcilable",
      modelInvocationRef: reference(cause.modelInvocationRef, modelInvocationRef,
        "MEDIA_OPERATION_STATE_INVALID"), reason: cause.reason,
      irreconcilableOutcomeReceiptRef: reference(cause.irreconcilableOutcomeReceiptRef,
        irreconcilableOutcomeReceiptRef, "MEDIA_OPERATION_STATE_INVALID") }) });
}

function rehydrateCanonicalFailureCause(value: unknown): MediaOperationCanonicalFailureCause {
  const record = plainRecord(value, "MEDIA_OPERATION_STATE_INVALID");
  switch (record.kind) {
    case "gateway_effect_failed": {
      const cause = strictRecord(record, ["kind", "modelInvocationRef", "gatewayOutcomeReceiptRef",
        "failureCause"], "MEDIA_OPERATION_STATE_INVALID");
      if (!isGatewayEffectFailureCause(cause.failureCause)) throw new Error("MEDIA_OPERATION_STATE_INVALID");
      return Object.freeze({ kind: "gateway_effect_failed",
        modelInvocationRef: reference(cause.modelInvocationRef, modelInvocationRef,
          "MEDIA_OPERATION_STATE_INVALID"),
        gatewayOutcomeReceiptRef: reference(cause.gatewayOutcomeReceiptRef,
          gatewayCanonicalOutcomeReceiptRef, "MEDIA_OPERATION_STATE_INVALID"),
        failureCause: cause.failureCause });
    }
    case "required_step_failed":
    case "required_step_canceled": {
      const cause = strictRecord(record, ["kind", "stepRef", "evidenceReceiptRef"],
        "MEDIA_OPERATION_STATE_INVALID");
      return Object.freeze({ kind: record.kind, stepRef: reference(cause.stepRef, mediaStepRef,
        "MEDIA_OPERATION_STATE_INVALID"), evidenceReceiptRef: reference(cause.evidenceReceiptRef,
        mediaReceiptRef, "MEDIA_OPERATION_STATE_INVALID") });
    }
    case "required_candidate_unavailable":
    case "minimum_ready_candidates_not_met": {
      const cause = strictRecord(record, ["kind", "candidateRef", "candidateState", "evidenceReceiptRef"],
        "MEDIA_OPERATION_STATE_INVALID");
      if (cause.candidateState !== "restricted" && cause.candidateState !== "failed" &&
          cause.candidateState !== "canceled") throw new Error("MEDIA_OPERATION_STATE_INVALID");
      return Object.freeze({ kind: record.kind, candidateRef: reference(cause.candidateRef, mediaCandidateRef,
        "MEDIA_OPERATION_STATE_INVALID"), candidateState: cause.candidateState,
      evidenceReceiptRef: reference(cause.evidenceReceiptRef, mediaReceiptRef,
        "MEDIA_OPERATION_STATE_INVALID") });
    }
    default: throw new Error("MEDIA_OPERATION_STATE_INVALID");
  }
}

function rehydrateMediaGatewayEffectClosure(value: unknown): MediaGatewayEffectClosure {
  const record = strictRecord(value, ["modelInvocationRef", "candidateRefs", "providerOutputFactRefs",
    "attemptUsageEvidenceReceiptRef", "effectBudgetCommitRef", "gatewayOutcome"],
  "MEDIA_OPERATION_EFFECT_CLOSURE_INVALID");
  const rawCandidateRefs = boundedNonEmptyArray(record.candidateRefs, MAXIMUM_MEDIA_DEFINITION_CANDIDATES,
    "MEDIA_OPERATION_EFFECT_CLOSURE_INVALID");
  const rawProviderOutputFactRefs = boundedArray(record.providerOutputFactRefs,
    MAXIMUM_MEDIA_DEFINITION_CANDIDATES, "MEDIA_OPERATION_EFFECT_CLOSURE_INVALID");
  const common = {
    modelInvocationRef: reference(record.modelInvocationRef, modelInvocationRef,
      "MEDIA_OPERATION_EFFECT_CLOSURE_INVALID"),
    candidateRefs: Object.freeze(rawCandidateRefs.map((candidateRefValue) => reference(
      candidateRefValue, mediaCandidateRef, "MEDIA_OPERATION_EFFECT_CLOSURE_INVALID",
    ))),
    providerOutputFactRefs: Object.freeze(rawProviderOutputFactRefs.map((providerFactValue) => reference(
      providerFactValue, providerOutputFactRef, "MEDIA_OPERATION_EFFECT_CLOSURE_INVALID",
    ))),
    attemptUsageEvidenceReceiptRef: reference(record.attemptUsageEvidenceReceiptRef,
      attemptUsageEvidenceReceiptRef, "MEDIA_OPERATION_EFFECT_CLOSURE_INVALID"),
    effectBudgetCommitRef: reference(record.effectBudgetCommitRef, effectBudgetCommitRef,
      "MEDIA_OPERATION_EFFECT_CLOSURE_INVALID"),
  } as const;
  if (new Set(common.providerOutputFactRefs).size !== common.providerOutputFactRefs.length) {
    throw new Error("MEDIA_OPERATION_EFFECT_CLOSURE_INVALID");
  }
  const outcome = plainRecord(record.gatewayOutcome, "MEDIA_OPERATION_EFFECT_CLOSURE_INVALID");
  switch (outcome.kind) {
    case "succeeded": {
      const state = strictRecord(outcome, ["kind", "gatewayOutcomeReceiptRef"],
        "MEDIA_OPERATION_EFFECT_CLOSURE_INVALID");
      return Object.freeze({ ...common, gatewayOutcome: Object.freeze({ kind: "succeeded",
        gatewayOutcomeReceiptRef: reference(state.gatewayOutcomeReceiptRef,
          gatewayCanonicalOutcomeReceiptRef, "MEDIA_OPERATION_EFFECT_CLOSURE_INVALID") }) });
    }
    case "failed": {
      const state = strictRecord(outcome, ["kind", "failureCause", "gatewayOutcomeReceiptRef"],
        "MEDIA_OPERATION_EFFECT_CLOSURE_INVALID");
      if (!isGatewayEffectFailureCause(state.failureCause)) {
        throw new Error("MEDIA_OPERATION_EFFECT_CLOSURE_INVALID");
      }
      return Object.freeze({ ...common, gatewayOutcome: Object.freeze({ kind: "failed",
        failureCause: state.failureCause, gatewayOutcomeReceiptRef: reference(state.gatewayOutcomeReceiptRef,
          gatewayCanonicalOutcomeReceiptRef, "MEDIA_OPERATION_EFFECT_CLOSURE_INVALID") }) });
    }
    case "canceled": {
      const state = strictRecord(outcome, ["kind", "cancellationReceiptRef", "gatewayOutcomeReceiptRef"],
        "MEDIA_OPERATION_EFFECT_CLOSURE_INVALID");
      return Object.freeze({ ...common, gatewayOutcome: Object.freeze({ kind: "canceled",
        cancellationReceiptRef: reference(state.cancellationReceiptRef, mediaReceiptRef,
          "MEDIA_OPERATION_EFFECT_CLOSURE_INVALID"),
        gatewayOutcomeReceiptRef: reference(state.gatewayOutcomeReceiptRef,
          gatewayCanonicalOutcomeReceiptRef, "MEDIA_OPERATION_EFFECT_CLOSURE_INVALID") }) });
    }
    case "irreconcilable": {
      const state = strictRecord(outcome, ["kind", "reason", "irreconcilableOutcomeReceiptRef"],
        "MEDIA_OPERATION_EFFECT_CLOSURE_INVALID");
      if (!isGatewayIrreconcilableReason(state.reason)) {
        throw new Error("MEDIA_OPERATION_EFFECT_CLOSURE_INVALID");
      }
      return Object.freeze({ ...common, gatewayOutcome: Object.freeze({ kind: "irreconcilable",
        reason: state.reason, irreconcilableOutcomeReceiptRef: reference(
          state.irreconcilableOutcomeReceiptRef, irreconcilableOutcomeReceiptRef,
          "MEDIA_OPERATION_EFFECT_CLOSURE_INVALID",
        ) }) });
    }
    default: throw new Error("MEDIA_OPERATION_EFFECT_CLOSURE_INVALID");
  }
}

function strictRecord(value: unknown, keys: readonly string[], code: string): UnknownRecord {
  return snapshotExactDataRecord(value, keys, code);
}

function plainRecord(value: unknown, code: string): UnknownRecord {
  return snapshotDataRecord(value, code);
}

function reference<Reference extends string>(
  value: unknown,
  factory: ReferenceFactory<Reference>,
  code: string,
): Reference {
  assertOpaqueReferenceValue(value, code);
  return factory(value);
}

function positiveVersion(value: unknown, code: string): bigint {
  if (typeof value !== "bigint" || value < 1n) throw new Error(code);
  return value;
}

function boundedArray(value: unknown, maximum: number, code: string): readonly unknown[] {
  return snapshotDenseArray(value, maximum, code);
}

function boundedNonEmptyArray(value: unknown, maximum: number, code: string): readonly unknown[] {
  const snapshot = boundedArray(value, maximum, code);
  if (snapshot.length < 1) throw new Error(code);
  return snapshot;
}
