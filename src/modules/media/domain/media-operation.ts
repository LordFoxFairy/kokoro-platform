import type { CompiledOperationDefinitionRevision } from "./operation-definition.js";
import {
  isGatewayEffectFailureCause,
  isGatewayIrreconcilableReason,
  isMediaCandidateFailureCause,
  isMediaCandidatePostOutputFailureCause,
  isMediaCancellationCause,
  isMediaStepFailureCause,
  type GatewayEffectFailureCause,
  type GatewayIrreconcilableReason,
  type MediaCancellationCause,
  type MediaCandidateFailureCause,
  type MediaCandidatePostOutputFailureCause,
  type MediaCandidatePreOutputFailureCause,
  type MediaCandidateUnknownReason,
  type MediaOperationReconciliationReason,
  type MediaStepFailureCause,
  type MediaStepReconciliationReason,
} from "./media-vocabulary.js";
import {
  mediaCandidateFailureEvidenceValid,
  mediaCandidateFailureRequiresProviderFact,
  rehydrateExpectedVersion,
  rehydrateMediaCandidate,
  rehydrateMediaCandidateState,
  rehydrateMediaOperation,
  rehydrateMediaOperationClosure,
  rehydrateMediaOperationNonTerminalState,
  rehydrateMediaOperationPlanInput,
  rehydrateMediaStep,
  rehydrateMediaStepState,
} from "./media-operation-runtime.js";
import { isOpaqueReferenceValue } from "./references.js";
import type {
  ArtifactFinalizationReceiptRef,
  ArtifactVersionRef,
  AttemptUsageEvidenceReceiptRef,
  EffectBudgetCommitRef,
  GatewayCanonicalOutcomeReceiptRef,
  IrreconcilableOutcomeReceiptRef,
  MediaCandidateRef,
  MediaOperationRef,
  MediaReceiptRef,
  MediaStepRef,
  ModelInvocationRef,
  OperationDefinitionRevisionRef,
  OperationInputRevisionRef,
  ProviderOutputFactRef,
  TrustDecisionRef,
} from "./references.js";

export type MediaOperationNonTerminalState =
  | Readonly<{ kind: "admission_pending" }>
  | Readonly<{ kind: "authorized" }>
  | Readonly<{ kind: "queued" }>
  | Readonly<{ kind: "active" }>
  | Readonly<{ kind: "finalizing" }>
  | Readonly<{ kind: "cancel_requested"; cancelIntentReceiptRef: MediaReceiptRef }>
  | Readonly<{
      kind: "reconciling";
      reason: MediaOperationReconciliationReason;
      unknownReceiptRef: MediaReceiptRef;
    }>;

export type MediaOperationCanonicalFailureCause =
  | Readonly<{
      kind: "gateway_effect_failed";
      modelInvocationRef: ModelInvocationRef;
      gatewayOutcomeReceiptRef: GatewayCanonicalOutcomeReceiptRef;
      failureCause: GatewayEffectFailureCause;
    }>
  | Readonly<{
      kind: "required_step_failed" | "required_step_canceled";
      stepRef: MediaStepRef;
      evidenceReceiptRef: MediaReceiptRef;
    }>
  | Readonly<{
      kind: "required_candidate_unavailable" | "minimum_ready_candidates_not_met";
      candidateRef: MediaCandidateRef;
      candidateState: "restricted" | "failed" | "canceled";
      evidenceReceiptRef: MediaReceiptRef;
    }>;

export type MediaOperationTerminalState =
  | Readonly<{
      kind: "completed" | "partial";
      terminalReceiptRef: MediaReceiptRef;
      outcomeClass: "canonical";
    }>
  | Readonly<{
      kind: "failed";
      terminalReceiptRef: MediaReceiptRef;
      outcomeClass: "canonical";
      cause: MediaOperationCanonicalFailureCause;
    }>
  | Readonly<{
      kind: "canceled";
      terminalReceiptRef: MediaReceiptRef;
      outcomeClass: "canonical";
      cause: Readonly<{
        kind: "gateway_effects_canceled";
        modelInvocationRef: ModelInvocationRef;
        cancellationReceiptRef: MediaReceiptRef;
        gatewayOutcomeReceiptRef: GatewayCanonicalOutcomeReceiptRef;
      }>;
    }>
  | Readonly<{
      kind: "failed";
      terminalReceiptRef: MediaReceiptRef;
      outcomeClass: "irreconcilable";
      cause: Readonly<{
        kind: "gateway_effect_irreconcilable";
        modelInvocationRef: ModelInvocationRef;
        reason: GatewayIrreconcilableReason;
        irreconcilableOutcomeReceiptRef: IrreconcilableOutcomeReceiptRef;
      }>;
    }>;

export type MediaOperationState = MediaOperationNonTerminalState | MediaOperationTerminalState;

export type MediaStepState =
  | Readonly<{ kind: "blocked" }>
  | Readonly<{ kind: "ready" }>
  | Readonly<{ kind: "leased" }>
  | Readonly<{ kind: "running" }>
  | Readonly<{ kind: "provider_async" }>
  | Readonly<{ kind: "finalizing" }>
  | Readonly<{
      kind: "reconciling";
      reason: MediaStepReconciliationReason;
      unknownReceiptRef: MediaReceiptRef;
    }>
  | Readonly<{ kind: "completed"; completionReceiptRef: MediaReceiptRef }>
  | Readonly<{
      kind: "failed";
      failureCause: MediaStepFailureCause;
      failureReceiptRef: MediaReceiptRef;
    }>
  | Readonly<{
      kind: "canceled";
      cancellationCause: MediaCancellationCause;
      cancellationReceiptRef: MediaReceiptRef;
    }>;

export type MediaCandidateState =
  | Readonly<{ kind: "allocated" }>
  | Readonly<{ kind: "producing" }>
  | Readonly<{ kind: "output_received"; providerOutputFactRef: ProviderOutputFactRef }>
  | Readonly<{ kind: "validating"; providerOutputFactRef: ProviderOutputFactRef }>
  | Readonly<{
      kind: "ready";
      providerOutputFactRef: ProviderOutputFactRef;
      artifactFinalizationCandidateRef: MediaCandidateRef;
      artifactVersionRef: ArtifactVersionRef;
      artifactFinalizationReceiptRef: ArtifactFinalizationReceiptRef;
      trustDecisionRef: TrustDecisionRef;
      attemptUsageEvidenceReceiptRef: AttemptUsageEvidenceReceiptRef;
      effectBudgetCommitRef: EffectBudgetCommitRef;
    }>
  | Readonly<{
      kind: "restricted";
      providerOutputFactRef: ProviderOutputFactRef;
      restrictionReceiptRef: MediaReceiptRef;
    }>
  | Readonly<{
      kind: "failed";
      providerOutputFactRef: ProviderOutputFactRef;
      failureCause: MediaCandidatePostOutputFailureCause;
      failureReceiptRef: MediaReceiptRef;
    }>
  | Readonly<{
      kind: "failed";
      failureCause: MediaCandidatePreOutputFailureCause;
      failureReceiptRef: MediaReceiptRef;
    }>
  | Readonly<{ kind: "cancel_requested"; cancelIntentReceiptRef: MediaReceiptRef }>
  | Readonly<{
      kind: "canceled";
      cancellationCause: MediaCancellationCause;
      cancellationReceiptRef: MediaReceiptRef;
    }>
  | Readonly<{
      kind: "unknown";
      reason: Exclude<MediaCandidateUnknownReason, "finalization_unknown">;
      unknownReceiptRef: MediaReceiptRef;
    }>
  | Readonly<{
      kind: "unknown";
      reason: "finalization_unknown";
      providerOutputFactRef: ProviderOutputFactRef;
      unknownReceiptRef: MediaReceiptRef;
    }>;

export type MediaGatewayEffectClosure = Readonly<{
  modelInvocationRef: ModelInvocationRef;
  candidateRefs: readonly MediaCandidateRef[];
  providerOutputFactRefs: readonly ProviderOutputFactRef[];
  attemptUsageEvidenceReceiptRef: AttemptUsageEvidenceReceiptRef;
  effectBudgetCommitRef: EffectBudgetCommitRef;
  gatewayOutcome:
    | Readonly<{
        kind: "succeeded";
        gatewayOutcomeReceiptRef: GatewayCanonicalOutcomeReceiptRef;
      }>
    | Readonly<{
        kind: "failed";
        failureCause: GatewayEffectFailureCause;
        gatewayOutcomeReceiptRef: GatewayCanonicalOutcomeReceiptRef;
      }>
    | Readonly<{
        kind: "canceled";
        cancellationReceiptRef: MediaReceiptRef;
        gatewayOutcomeReceiptRef: GatewayCanonicalOutcomeReceiptRef;
      }>
    | Readonly<{
        kind: "irreconcilable";
        reason: GatewayIrreconcilableReason;
        irreconcilableOutcomeReceiptRef: IrreconcilableOutcomeReceiptRef;
      }>;
}>;

export type MediaOperation = Readonly<{
  operationRef: MediaOperationRef;
  definitionRevisionRef: OperationDefinitionRevisionRef;
  operationInputRevisionRef: OperationInputRevisionRef;
  expectedVersion: bigint;
  state: MediaOperationState;
}>;

export type MediaStep = Readonly<{
  stepRef: MediaStepRef;
  operationRef: MediaOperationRef;
  definitionStepKey: string;
  required: boolean;
  expectedVersion: bigint;
  state: MediaStepState;
}>;

export type MediaCandidate = Readonly<{
  candidateRef: MediaCandidateRef;
  operationRef: MediaOperationRef;
  stepRef: MediaStepRef;
  definitionStepKey: string;
  outputSlot: string;
  required: boolean;
  expectedVersion: bigint;
  state: MediaCandidateState;
}>;

export type MediaOperationClosure = Readonly<{
  definition: CompiledOperationDefinitionRevision;
  steps: readonly MediaStep[];
  candidates: readonly MediaCandidate[];
  effects: readonly MediaGatewayEffectClosure[];
}>;

export type MediaOperationPlan = Readonly<{
  operation: MediaOperation;
  steps: readonly MediaStep[];
  candidates: readonly MediaCandidate[];
}>;

export type MediaOperationPlanInput = Readonly<{
  operationRef: MediaOperationRef;
  operationInputRevisionRef: OperationInputRevisionRef;
  definition: CompiledOperationDefinitionRevision;
  steps: readonly Readonly<{ definitionStepKey: string; stepRef: MediaStepRef }>[];
  candidates: readonly Readonly<{
    definitionStepKey: string;
    outputSlot: string;
    candidateRef: MediaCandidateRef;
  }>[];
}>;

export function createMediaOperationPlan(rawInput: MediaOperationPlanInput): MediaOperationPlan {
  const input = rehydrateMediaOperationPlanInput(rawInput);
  const definition = input.definition;
  const expectedStepKeys = new Set(definition.steps.map((step) => step.definitionStepKey));
  const suppliedStepKeys = new Set(input.steps.map((step) => step.definitionStepKey));
  const suppliedStepRefs = new Set(input.steps.map((step) => step.stepRef));
  if (input.steps.length !== definition.steps.length ||
      suppliedStepKeys.size !== input.steps.length || suppliedStepRefs.size !== input.steps.length ||
      !sameSet(expectedStepKeys, suppliedStepKeys)) {
    throw new Error("MEDIA_OPERATION_PLAN_ALLOCATION_MISMATCH");
  }
  const stepRefByKey = new Map(input.steps.map((step) => [step.definitionStepKey, step.stepRef]));
  const expectedCandidates = new Set(definition.steps.flatMap((step) =>
    step.candidateSlots.map((slot) => candidateKey(step.definitionStepKey, slot.outputSlot))));
  const suppliedCandidateKeys = new Set(input.candidates.map((candidate) =>
    candidateKey(candidate.definitionStepKey, candidate.outputSlot)));
  const suppliedCandidateRefs = new Set(input.candidates.map((candidate) => candidate.candidateRef));
  if (input.candidates.length !== expectedCandidates.size ||
      suppliedCandidateKeys.size !== input.candidates.length ||
      suppliedCandidateRefs.size !== input.candidates.length ||
      !sameSet(expectedCandidates, suppliedCandidateKeys)) {
    throw new Error("MEDIA_OPERATION_PLAN_ALLOCATION_MISMATCH");
  }

  const operation = rehydrateMediaOperation({
    operationRef: input.operationRef,
    definitionRevisionRef: definition.definitionRevisionRef,
    operationInputRevisionRef: input.operationInputRevisionRef,
    expectedVersion: 1n,
    state: freezeState<MediaOperationNonTerminalState>({ kind: "admission_pending" }),
  });
  const steps = definition.steps.map((definitionStep) => rehydrateMediaStep({
    stepRef: stepRefByKey.get(definitionStep.definitionStepKey)!,
    operationRef: input.operationRef,
    definitionStepKey: definitionStep.definitionStepKey,
    required: definitionStep.required,
    expectedVersion: 1n,
    state: freezeState<MediaStepState>({ kind: "blocked" }),
  }));
  const allocationByKey = new Map(input.candidates.map((candidate) =>
    [candidateKey(candidate.definitionStepKey, candidate.outputSlot), candidate]));
  const candidates = definition.steps.flatMap((definitionStep) => {
    const stepRef = stepRefByKey.get(definitionStep.definitionStepKey)!;
    return definitionStep.candidateSlots.map((slot) => rehydrateMediaCandidate({
      candidateRef: allocationByKey.get(candidateKey(definitionStep.definitionStepKey, slot.outputSlot))!.candidateRef,
      operationRef: input.operationRef,
      stepRef,
      definitionStepKey: definitionStep.definitionStepKey,
      outputSlot: slot.outputSlot,
      required: slot.required,
      expectedVersion: 1n,
      state: freezeState<MediaCandidateState>({ kind: "allocated" }),
    }));
  });
  return Object.freeze({ operation, steps: Object.freeze(steps), candidates: Object.freeze(candidates) });
}

export function transitionMediaOperation(input: Readonly<{
  operation: MediaOperation;
  expectedVersion: bigint;
  nextState: MediaOperationNonTerminalState;
}>): MediaOperation {
  const operation = rehydrateMediaOperation(input.operation);
  const expectedVersion = rehydrateExpectedVersion(input.expectedVersion);
  const nextState = rehydrateMediaOperationNonTerminalState(input.nextState);
  assertOperationVersion(operation, expectedVersion);
  if (!operationTransitions(operation.state).includes(nextState.kind)) {
    throw new Error("MEDIA_OPERATION_TRANSITION_INVALID");
  }
  return nextOperation(operation, nextState);
}

/**
 * The only terminal transition. The caller supplies evidence and a Media-owned
 * receipt identity; this reducer, never a service branch, derives the outcome.
 */
export function reduceMediaOperationTerminal(input: Readonly<{
  operation: MediaOperation;
  expectedVersion: bigint;
  terminalReceiptRef: MediaReceiptRef;
  closure: MediaOperationClosure;
}>): MediaOperation {
  const operation = rehydrateMediaOperation(input.operation);
  const expectedVersion = rehydrateExpectedVersion(input.expectedVersion);
  assertOperationVersion(operation, expectedVersion);
  if (!opaqueReferencePresent(input.terminalReceiptRef)) {
    throw new Error("MEDIA_OPERATION_TERMINAL_RECEIPT_INVALID");
  }
  if (operation.state.kind !== "finalizing" && operation.state.kind !== "reconciling") {
    throw new Error("MEDIA_OPERATION_TERMINAL_TRANSITION_INVALID");
  }
  const closure = rehydrateMediaOperationClosure(input.closure);
  if (!closureMatches(operation, closure) || !allChildrenCanonicallyClosed(closure)) {
    throw new Error("MEDIA_OPERATION_TERMINAL_EVIDENCE_REQUIRED");
  }
  assertArtifactEvidenceNotAliased(closure.candidates);
  const effectByCandidate = validateEffectClosure(closure);
  assertReadyEvidenceBoundToEffect(closure.candidates, effectByCandidate);

  const irreconcilable = orderedEffects(closure.effects).find(
    (effect) => effect.gatewayOutcome.kind === "irreconcilable",
  );
  if (irreconcilable !== undefined) {
    if (operation.state.kind !== "reconciling" ||
        irreconcilable.gatewayOutcome.kind !== "irreconcilable") {
      throw new Error("MEDIA_OPERATION_IRRECONCILABLE_OUTCOME_INVALID");
    }
    return nextOperation(operation, freezeState<MediaOperationTerminalState>({
      kind: "failed",
      terminalReceiptRef: input.terminalReceiptRef,
      outcomeClass: "irreconcilable",
      cause: Object.freeze({
        kind: "gateway_effect_irreconcilable",
        modelInvocationRef: irreconcilable.modelInvocationRef,
        reason: irreconcilable.gatewayOutcome.reason,
        irreconcilableOutcomeReceiptRef: irreconcilable.gatewayOutcome.irreconcilableOutcomeReceiptRef,
      }),
    }));
  }

  if (completionReady(closure)) {
    return nextOperation(operation, freezeState<MediaOperationTerminalState>({
      kind: "completed",
      terminalReceiptRef: input.terminalReceiptRef,
      outcomeClass: "canonical",
    }));
  }
  if (partialReady(closure)) {
    return nextOperation(operation, freezeState<MediaOperationTerminalState>({
      kind: "partial",
      terminalReceiptRef: input.terminalReceiptRef,
      outcomeClass: "canonical",
    }));
  }

  const effects = orderedEffects(closure.effects);
  if (effects.every((effect) => effect.gatewayOutcome.kind === "canceled") &&
      closure.steps.every((step) => step.state.kind === "canceled") &&
      closure.candidates.every((candidate) => candidate.state.kind === "canceled")) {
    const first = effects[0]!;
    if (first.gatewayOutcome.kind !== "canceled") {
      throw new Error("MEDIA_OPERATION_TERMINAL_REDUCER_INVALID");
    }
    return nextOperation(operation, freezeState<MediaOperationTerminalState>({
      kind: "canceled",
      terminalReceiptRef: input.terminalReceiptRef,
      outcomeClass: "canonical",
      cause: Object.freeze({
        kind: "gateway_effects_canceled",
        modelInvocationRef: first.modelInvocationRef,
        cancellationReceiptRef: first.gatewayOutcome.cancellationReceiptRef,
        gatewayOutcomeReceiptRef: first.gatewayOutcome.gatewayOutcomeReceiptRef,
      }),
    }));
  }

  return nextOperation(operation, freezeState<MediaOperationTerminalState>({
    kind: "failed",
    terminalReceiptRef: input.terminalReceiptRef,
    outcomeClass: "canonical",
    cause: canonicalFailureCause(closure),
  }));
}

export function transitionMediaStep(input: Readonly<{
  step: MediaStep;
  expectedVersion: bigint;
  nextState: MediaStepState;
}>): MediaStep {
  const step = rehydrateMediaStep(input.step);
  const expectedVersion = rehydrateExpectedVersion(input.expectedVersion);
  const nextState = rehydrateMediaStepState(input.nextState);
  if (step.expectedVersion !== expectedVersion) throw new Error("MEDIA_STEP_VERSION_CONFLICT");
  if (!stepTransitions(step.state).includes(nextState.kind)) {
    throw new Error("MEDIA_STEP_TRANSITION_INVALID");
  }
  return rehydrateMediaStep({ stepRef: step.stepRef, operationRef: step.operationRef,
    definitionStepKey: step.definitionStepKey, required: step.required,
    expectedVersion: nextVersion(step.expectedVersion), state: nextState });
}

export function transitionMediaCandidate(input: Readonly<{
  candidate: MediaCandidate;
  expectedVersion: bigint;
  nextState: MediaCandidateState;
}>): MediaCandidate {
  const candidate = rehydrateMediaCandidate(input.candidate);
  const expectedVersion = rehydrateExpectedVersion(input.expectedVersion);
  const nextState = rehydrateMediaCandidateState(input.nextState);
  if (candidate.expectedVersion !== expectedVersion) {
    throw new Error("MEDIA_CANDIDATE_VERSION_CONFLICT");
  }
  if (!candidateTransitions(candidate.state).includes(nextState.kind)) {
    throw new Error("MEDIA_CANDIDATE_TRANSITION_INVALID");
  }
  const currentFact = candidateProviderOutputFact(candidate.state);
  const nextFact = candidateProviderOutputFact(nextState);
  if (nextState.kind === "failed" && !mediaCandidateFailureEvidenceValid(nextState)) {
    throw new Error("MEDIA_CANDIDATE_STATE_INVALID");
  }
  if ((currentFact !== undefined && currentFact !== nextFact) ||
      (nextState.kind === "failed" &&
        mediaCandidateFailureRequiresProviderFact(nextState.failureCause) && currentFact === undefined)) {
    throw new Error("MEDIA_CANDIDATE_PROVIDER_OUTPUT_FACT_MISMATCH");
  }
  if (nextState.kind === "ready" &&
      nextState.artifactFinalizationCandidateRef !== candidate.candidateRef) {
    throw new Error("MEDIA_CANDIDATE_ARTIFACT_FINALIZATION_BINDING_MISMATCH");
  }
  return rehydrateMediaCandidate({ candidateRef: candidate.candidateRef, operationRef: candidate.operationRef,
    stepRef: candidate.stepRef, definitionStepKey: candidate.definitionStepKey, outputSlot: candidate.outputSlot,
    required: candidate.required, expectedVersion: nextVersion(candidate.expectedVersion), state: nextState });
}

function assertNever(_value: never, code = "MEDIA_STATE_NOT_EXHAUSTIVE"): never {
  throw new Error(code);
}

function assertOperationVersion(operation: MediaOperation, expectedVersion: bigint): void {
  if (operation.expectedVersion !== expectedVersion) throw new Error("MEDIA_OPERATION_VERSION_CONFLICT");
}

function nextOperation(operation: MediaOperation, state: MediaOperationState): MediaOperation {
  return rehydrateMediaOperation({ operationRef: operation.operationRef,
    definitionRevisionRef: operation.definitionRevisionRef,
    operationInputRevisionRef: operation.operationInputRevisionRef,
    expectedVersion: nextVersion(operation.expectedVersion), state });
}

function operationTransitions(state: MediaOperationState): readonly MediaOperationNonTerminalState["kind"][] {
  switch (state.kind) {
    case "admission_pending": return ["authorized"];
    case "authorized": return ["queued"];
    case "queued": return ["active", "cancel_requested"];
    case "active": return ["finalizing", "cancel_requested", "reconciling"];
    case "finalizing": return ["reconciling"];
    case "cancel_requested": return ["reconciling"];
    case "reconciling": return ["active", "finalizing"];
    case "completed":
    case "partial":
    case "failed":
    case "canceled": return [];
    default: return assertNever(state);
  }
}

function stepTransitions(state: MediaStepState): readonly MediaStepState["kind"][] {
  switch (state.kind) {
    case "blocked": return ["ready"];
    case "ready": return ["leased"];
    case "leased": return ["running", "reconciling"];
    case "running": return ["provider_async", "finalizing", "completed", "failed", "canceled", "reconciling"];
    case "provider_async": return ["finalizing", "completed", "failed", "canceled", "reconciling"];
    case "finalizing": return ["completed", "failed", "canceled"];
    case "reconciling": return ["running", "provider_async", "finalizing", "completed", "failed", "canceled"];
    case "completed":
    case "failed":
    case "canceled": return [];
    default: return assertNever(state);
  }
}

function candidateTransitions(state: MediaCandidateState): readonly MediaCandidateState["kind"][] {
  switch (state.kind) {
    case "allocated": return ["producing", "cancel_requested"];
    case "producing": return ["output_received", "cancel_requested", "unknown"];
    case "output_received": return ["validating", "unknown"];
    case "validating": return ["ready", "restricted", "failed", "unknown"];
    case "unknown": return ["validating", "restricted", "failed"];
    case "cancel_requested": return ["canceled", "output_received", "unknown", "ready", "restricted"];
    case "ready":
    case "restricted":
    case "failed":
    case "canceled": return [];
    default: return assertNever(state);
  }
}

function completionReady(closure: MediaOperationClosure): boolean {
  return closure.definition.steps.every((definitionStep) => {
    const step = closure.steps.find((value) => value.definitionStepKey === definitionStep.definitionStepKey);
    return !definitionStep.required || step?.state.kind === "completed";
  }) && closure.definition.steps.every((definitionStep) =>
    definitionStep.candidateSlots.every((slot) => {
      const candidate = closure.candidates.find((value) =>
        value.definitionStepKey === definitionStep.definitionStepKey && value.outputSlot === slot.outputSlot);
      return !slot.required || candidate?.state.kind === "ready";
    })) && closure.candidates.every((candidate) => candidate.state.kind !== "restricted") &&
    readyCandidateCount(closure.candidates) >= closure.definition.minimumReadyCandidates;
}

function partialReady(closure: MediaOperationClosure): boolean {
  return closure.definition.partialCompletion === "allowed" &&
    readyCandidateCount(closure.candidates) >= closure.definition.minimumReadyCandidates;
}

function closureMatches(operation: MediaOperation, closure: MediaOperationClosure): boolean {
  if (operation.definitionRevisionRef !== closure.definition.definitionRevisionRef ||
      closure.steps.length !== closure.definition.steps.length ||
      closure.candidates.length !== closure.definition.steps.reduce(
        (total, step) => total + step.candidateSlots.length, 0)) return false;
  const steps = new Map<string, MediaStep>();
  const stepRefs = new Set<MediaStepRef>();
  for (const step of closure.steps) {
    if (step.operationRef !== operation.operationRef || steps.has(step.definitionStepKey) ||
        stepRefs.has(step.stepRef)) return false;
    steps.set(step.definitionStepKey, step);
    stepRefs.add(step.stepRef);
  }
  const candidates = new Map<string, MediaCandidate>();
  const candidateRefs = new Set<MediaCandidateRef>();
  for (const candidate of closure.candidates) {
    const key = candidateKey(candidate.definitionStepKey, candidate.outputSlot);
    if (candidate.operationRef !== operation.operationRef || candidates.has(key) ||
        candidateRefs.has(candidate.candidateRef)) return false;
    candidates.set(key, candidate);
    candidateRefs.add(candidate.candidateRef);
  }
  return closure.definition.steps.every((definitionStep) => {
    const step = steps.get(definitionStep.definitionStepKey);
    if (step === undefined || step.required !== definitionStep.required) return false;
    return definitionStep.candidateSlots.every((slot) => {
      const candidate = candidates.get(candidateKey(definitionStep.definitionStepKey, slot.outputSlot));
      return candidate !== undefined && candidate.stepRef === step.stepRef && candidate.required === slot.required;
    });
  });
}

function allChildrenCanonicallyClosed(closure: MediaOperationClosure): boolean {
  return closure.steps.every((step) => stepTerminalEvidencePresent(step.state)) &&
    closure.candidates.every((candidate) => candidateTerminalEvidencePresent(candidate.state));
}

function stepTerminalEvidencePresent(state: MediaStepState): boolean {
  switch (state.kind) {
    case "completed": return opaqueReferencePresent(state.completionReceiptRef);
    case "failed": return isMediaStepFailureCause(state.failureCause) &&
      opaqueReferencePresent(state.failureReceiptRef);
    case "canceled": return isMediaCancellationCause(state.cancellationCause) &&
      opaqueReferencePresent(state.cancellationReceiptRef);
    case "blocked":
    case "ready":
    case "leased":
    case "running":
    case "provider_async":
    case "finalizing":
    case "reconciling": return false;
    default: return assertNever(state);
  }
}

function candidateTerminalEvidencePresent(state: MediaCandidateState): boolean {
  switch (state.kind) {
    case "ready": return readyEvidencePresent(state);
    case "restricted": return opaqueReferencePresent(state.providerOutputFactRef) &&
      opaqueReferencePresent(state.restrictionReceiptRef);
    case "failed": return candidateFailureCausePresent(state.failureCause) &&
      mediaCandidateFailureEvidenceValid(state) &&
      opaqueReferencePresent(state.failureReceiptRef) &&
      (!("providerOutputFactRef" in state) || opaqueReferencePresent(state.providerOutputFactRef));
    case "canceled": return isMediaCancellationCause(state.cancellationCause) &&
      opaqueReferencePresent(state.cancellationReceiptRef);
    case "allocated":
    case "producing":
    case "output_received":
    case "validating":
    case "cancel_requested":
    case "unknown": return false;
    default: return assertNever(state);
  }
}

function validateEffectClosure(
  closure: MediaOperationClosure,
): ReadonlyMap<MediaCandidateRef, MediaGatewayEffectClosure> {
  if (!Array.isArray(closure.effects) || closure.effects.length < 1 ||
      closure.effects.length > closure.candidates.length) {
    throw new Error("MEDIA_OPERATION_EFFECT_CLOSURE_REQUIRED");
  }
  const effectRefs = new Set<ModelInvocationRef>();
  const evidenceOwnerByRef = new Map<string, ModelInvocationRef>();
  const candidateRefs = new Set<MediaCandidateRef>();
  const effectByCandidate = new Map<MediaCandidateRef, MediaGatewayEffectClosure>();
  for (const effect of closure.effects) {
    if (!effectClosureStructurallyValid(effect) || effectRefs.has(effect.modelInvocationRef)) {
      throw new Error("MEDIA_OPERATION_EFFECT_CLOSURE_INVALID");
    }
    const evidenceRefs = [effect.effectBudgetCommitRef, effect.attemptUsageEvidenceReceiptRef,
      ...effect.providerOutputFactRefs, ...gatewayEvidenceRefs(effect)];
    evidenceRefs.forEach((reference) => claimEvidenceOwnership(
      evidenceOwnerByRef, reference, effect.modelInvocationRef,
    ));
    effectRefs.add(effect.modelInvocationRef);
    for (const candidateRef of effect.candidateRefs) {
      if (candidateRefs.has(candidateRef)) throw new Error("MEDIA_OPERATION_EFFECT_CANDIDATE_ALIASED");
      candidateRefs.add(candidateRef);
      effectByCandidate.set(candidateRef, effect);
    }
  }
  if (candidateRefs.size !== closure.candidates.length ||
      closure.candidates.some((candidate) => !candidateRefs.has(candidate.candidateRef))) {
    throw new Error("MEDIA_OPERATION_EFFECT_CLOSURE_REQUIRED");
  }
  return effectByCandidate;
}

function assertReadyEvidenceBoundToEffect(
  candidates: readonly MediaCandidate[],
  effectByCandidate: ReadonlyMap<MediaCandidateRef, MediaGatewayEffectClosure>,
): void {
  for (const candidate of candidates) {
    const effect = effectByCandidate.get(candidate.candidateRef);
    const providerOutputFact = candidateProviderOutputFact(candidate.state);
    if (effect === undefined || (providerOutputFact !== undefined &&
        !effect.providerOutputFactRefs.includes(providerOutputFact))) {
      throw new Error("MEDIA_OPERATION_READY_EFFECT_EVIDENCE_MISMATCH");
    }
    if (candidate.state.kind === "ready" &&
        (candidate.state.attemptUsageEvidenceReceiptRef !== effect.attemptUsageEvidenceReceiptRef ||
        candidate.state.effectBudgetCommitRef !== effect.effectBudgetCommitRef ||
        effect.gatewayOutcome.kind !== "succeeded")) {
      throw new Error("MEDIA_OPERATION_READY_EFFECT_EVIDENCE_MISMATCH");
    }
  }
  for (const effect of effectByCandidateValues(effectByCandidate)) {
    const expectedFacts = new Set(candidates
      .filter((candidate) => effect.candidateRefs.includes(candidate.candidateRef))
      .map((candidate) => candidateProviderOutputFact(candidate.state))
      .filter((reference): reference is ProviderOutputFactRef => reference !== undefined));
    if (!sameSet(expectedFacts, new Set(effect.providerOutputFactRefs))) {
      throw new Error("MEDIA_OPERATION_READY_EFFECT_EVIDENCE_MISMATCH");
    }
    if (!candidateOutcomeCompatible(effect, candidates)) {
      throw new Error("MEDIA_OPERATION_CANDIDATE_OUTCOME_MISMATCH");
    }
  }
}

function effectClosureStructurallyValid(effect: MediaGatewayEffectClosure): boolean {
  if (effect === null || typeof effect !== "object" ||
      !opaqueReferencePresent(effect.modelInvocationRef) ||
      !Array.isArray(effect.candidateRefs) || effect.candidateRefs.length < 1 ||
      effect.candidateRefs.some((reference) => !opaqueReferencePresent(reference)) ||
      !Array.isArray(effect.providerOutputFactRefs) ||
      effect.providerOutputFactRefs.some((reference) => !opaqueReferencePresent(reference)) ||
      new Set(effect.providerOutputFactRefs).size !== effect.providerOutputFactRefs.length ||
      !opaqueReferencePresent(effect.attemptUsageEvidenceReceiptRef) ||
      !opaqueReferencePresent(effect.effectBudgetCommitRef) ||
      effect.gatewayOutcome === null || typeof effect.gatewayOutcome !== "object") return false;
  switch (effect.gatewayOutcome.kind) {
    case "succeeded": return opaqueReferencePresent(effect.gatewayOutcome.gatewayOutcomeReceiptRef);
    case "failed": return isGatewayEffectFailureCause(effect.gatewayOutcome.failureCause) &&
      opaqueReferencePresent(effect.gatewayOutcome.gatewayOutcomeReceiptRef);
    case "canceled": return opaqueReferencePresent(effect.gatewayOutcome.cancellationReceiptRef) &&
      opaqueReferencePresent(effect.gatewayOutcome.gatewayOutcomeReceiptRef);
    case "irreconcilable": return isGatewayIrreconcilableReason(effect.gatewayOutcome.reason) &&
      opaqueReferencePresent(effect.gatewayOutcome.irreconcilableOutcomeReceiptRef);
    default: return false;
  }
}

function candidateOutcomeCompatible(
  effect: MediaGatewayEffectClosure,
  candidates: readonly MediaCandidate[],
): boolean {
  const bound = candidates.filter((candidate) => effect.candidateRefs.includes(candidate.candidateRef));
  switch (effect.gatewayOutcome.kind) {
    case "succeeded": return bound.every((candidate) => {
      if (candidate.state.kind === "ready" || candidate.state.kind === "restricted") return true;
      return candidate.state.kind === "failed" && "providerOutputFactRef" in candidate.state &&
        candidate.state.providerOutputFactRef !== undefined &&
        isMediaCandidatePostOutputFailureCause(candidate.state.failureCause);
    });
    case "failed": return bound.every((candidate) => candidate.state.kind === "failed" &&
      candidate.state.failureCause === "gateway_effect_failed" &&
      !("providerOutputFactRef" in candidate.state));
    case "canceled": return bound.every((candidate) => candidate.state.kind === "canceled");
    case "irreconcilable": return bound.every((candidate) => candidate.state.kind === "failed" &&
      candidate.state.failureCause === "gateway_outcome_irreconcilable" &&
      !("providerOutputFactRef" in candidate.state));
    default: return assertNever(effect.gatewayOutcome);
  }
}

function gatewayEvidenceRefs(effect: MediaGatewayEffectClosure): readonly string[] {
  switch (effect.gatewayOutcome.kind) {
    case "succeeded":
    case "failed": return [effect.gatewayOutcome.gatewayOutcomeReceiptRef];
    case "canceled": return [effect.gatewayOutcome.gatewayOutcomeReceiptRef,
      effect.gatewayOutcome.cancellationReceiptRef];
    case "irreconcilable": return [effect.gatewayOutcome.irreconcilableOutcomeReceiptRef];
    default: return assertNever(effect.gatewayOutcome);
  }
}

function claimEvidenceOwnership(
  ownerByRef: Map<string, ModelInvocationRef>,
  reference: string,
  modelInvocationRef: ModelInvocationRef,
): void {
  const owner = ownerByRef.get(reference);
  if (owner !== undefined && owner !== modelInvocationRef) {
    throw new Error("MEDIA_OPERATION_EFFECT_EVIDENCE_ALIASED");
  }
  ownerByRef.set(reference, modelInvocationRef);
}

function effectByCandidateValues(
  effectByCandidate: ReadonlyMap<MediaCandidateRef, MediaGatewayEffectClosure>,
): readonly MediaGatewayEffectClosure[] {
  return [...new Map([...effectByCandidate.values()].map((effect) =>
    [effect.modelInvocationRef, effect])).values()];
}

function assertArtifactEvidenceNotAliased(candidates: readonly MediaCandidate[]): void {
  const artifactVersions = new Set<ArtifactVersionRef>();
  const finalizationReceipts = new Set<ArtifactFinalizationReceiptRef>();
  for (const candidate of candidates) {
    if (candidate.state.kind !== "ready") continue;
    if (candidate.state.artifactFinalizationCandidateRef !== candidate.candidateRef ||
        artifactVersions.has(candidate.state.artifactVersionRef) ||
        finalizationReceipts.has(candidate.state.artifactFinalizationReceiptRef)) {
      throw new Error("MEDIA_OPERATION_ARTIFACT_EVIDENCE_ALIASED");
    }
    artifactVersions.add(candidate.state.artifactVersionRef);
    finalizationReceipts.add(candidate.state.artifactFinalizationReceiptRef);
  }
}

function canonicalFailureCause(closure: MediaOperationClosure): MediaOperationCanonicalFailureCause {
  const failedEffect = orderedEffects(closure.effects).find((effect) => effect.gatewayOutcome.kind === "failed");
  if (failedEffect !== undefined && failedEffect.gatewayOutcome.kind === "failed") {
    return Object.freeze({
      kind: "gateway_effect_failed",
      modelInvocationRef: failedEffect.modelInvocationRef,
      gatewayOutcomeReceiptRef: failedEffect.gatewayOutcome.gatewayOutcomeReceiptRef,
      failureCause: failedEffect.gatewayOutcome.failureCause,
    });
  }
  for (const definitionStep of closure.definition.steps) {
    if (!definitionStep.required) continue;
    const step = closure.steps.find((value) => value.definitionStepKey === definitionStep.definitionStepKey)!;
    if (step.state.kind === "failed") {
      return Object.freeze({ kind: "required_step_failed", stepRef: step.stepRef,
        evidenceReceiptRef: step.state.failureReceiptRef });
    }
    if (step.state.kind === "canceled") {
      return Object.freeze({ kind: "required_step_canceled", stepRef: step.stepRef,
        evidenceReceiptRef: step.state.cancellationReceiptRef });
    }
  }
  for (const definitionStep of closure.definition.steps) {
    for (const slot of definitionStep.candidateSlots) {
      if (!slot.required) continue;
      const candidate = closure.candidates.find((value) =>
        value.definitionStepKey === definitionStep.definitionStepKey && value.outputSlot === slot.outputSlot)!;
      if (candidate.state.kind !== "ready") {
        return candidateFailureCause("required_candidate_unavailable", candidate);
      }
    }
  }
  for (const definitionStep of closure.definition.steps) {
    for (const slot of definitionStep.candidateSlots) {
      const candidate = closure.candidates.find((value) =>
        value.definitionStepKey === definitionStep.definitionStepKey && value.outputSlot === slot.outputSlot)!;
      if (candidate.state.kind !== "ready") {
        return candidateFailureCause("minimum_ready_candidates_not_met", candidate);
      }
    }
  }
  throw new Error("MEDIA_OPERATION_TERMINAL_REDUCER_INVALID");
}

function candidateFailureCause(
  kind: "required_candidate_unavailable" | "minimum_ready_candidates_not_met",
  candidate: MediaCandidate,
): MediaOperationCanonicalFailureCause {
  switch (candidate.state.kind) {
    case "restricted": return Object.freeze({ kind, candidateRef: candidate.candidateRef,
      candidateState: "restricted", evidenceReceiptRef: candidate.state.restrictionReceiptRef });
    case "failed": return Object.freeze({ kind, candidateRef: candidate.candidateRef,
      candidateState: "failed", evidenceReceiptRef: candidate.state.failureReceiptRef });
    case "canceled": return Object.freeze({ kind, candidateRef: candidate.candidateRef,
      candidateState: "canceled", evidenceReceiptRef: candidate.state.cancellationReceiptRef });
    case "ready": throw new Error("MEDIA_OPERATION_TERMINAL_REDUCER_INVALID");
    case "allocated":
    case "producing":
    case "output_received":
    case "validating":
    case "cancel_requested":
    case "unknown": throw new Error("MEDIA_OPERATION_TERMINAL_EVIDENCE_REQUIRED");
    default: return assertNever(candidate.state);
  }
}

function candidateProviderOutputFact(state: MediaCandidateState): ProviderOutputFactRef | undefined {
  switch (state.kind) {
    case "output_received":
    case "validating":
    case "ready":
    case "restricted": return state.providerOutputFactRef;
    case "failed": return "providerOutputFactRef" in state ? state.providerOutputFactRef : undefined;
    case "unknown": return state.reason === "finalization_unknown" ? state.providerOutputFactRef : undefined;
    case "allocated":
    case "producing":
    case "cancel_requested":
    case "canceled": return undefined;
    default: return assertNever(state);
  }
}

function readyEvidencePresent(state: Extract<MediaCandidateState, { kind: "ready" }>): boolean {
  return [state.providerOutputFactRef, state.artifactFinalizationCandidateRef, state.artifactVersionRef,
    state.artifactFinalizationReceiptRef, state.trustDecisionRef,
    state.attemptUsageEvidenceReceiptRef, state.effectBudgetCommitRef]
    .every(opaqueReferencePresent);
}

function readyCandidateCount(candidates: readonly MediaCandidate[]): number {
  return candidates.filter((candidate) => candidate.state.kind === "ready" &&
    readyEvidencePresent(candidate.state)).length;
}

function orderedEffects(effects: readonly MediaGatewayEffectClosure[]): readonly MediaGatewayEffectClosure[] {
  return [...effects].sort((left, right) => left.modelInvocationRef < right.modelInvocationRef
    ? -1
    : left.modelInvocationRef > right.modelInvocationRef ? 1 : 0);
}

function candidateFailureCausePresent(value: unknown): value is MediaCandidateFailureCause {
  return isMediaCandidateFailureCause(value);
}

export type {
  GatewayEffectFailureCause,
  GatewayIrreconcilableReason,
  MediaCandidateFailureCause,
  MediaCandidatePostOutputFailureCause,
  MediaCandidatePreOutputFailureCause,
};

function opaqueReferencePresent(value: unknown): value is string {
  return isOpaqueReferenceValue(value);
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function candidateKey(definitionStepKey: string, outputSlot: string): string {
  return `${definitionStepKey}\0${outputSlot}`;
}

function freezeState<State extends object>(state: State): Readonly<State> {
  return Object.freeze({ ...state });
}

function nextVersion(value: bigint): bigint {
  if (value < 1n) throw new Error("MEDIA_EXPECTED_VERSION_INVALID");
  return value + 1n;
}
