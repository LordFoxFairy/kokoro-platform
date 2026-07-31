import type { CompiledOperationDefinitionRevision } from "./operation-definition.js";
import type {
  ArtifactFinalizationReceiptRef,
  ArtifactVersionRef,
  AttemptUsageEvidenceReceiptRef,
  EffectBudgetCommitRef,
  IrreconcilableOutcomeReceiptRef,
  MediaCandidateRef,
  MediaOperationRef,
  MediaReceiptRef,
  MediaStepRef,
  OperationDefinitionRevisionRef,
  OperationInputRevisionRef,
  ProviderOutputFactRef,
  TrustDecisionRef,
} from "./references.js";

export type MediaOperationState =
  | Readonly<{ kind: "admission_pending" }>
  | Readonly<{ kind: "authorized" }>
  | Readonly<{ kind: "queued" }>
  | Readonly<{ kind: "active" }>
  | Readonly<{ kind: "finalizing" }>
  | Readonly<{ kind: "cancel_requested"; cancelIntentReceiptRef: MediaReceiptRef }>
  | Readonly<{
      kind: "reconciling";
      reason: "submission_unknown" | "outcome_unknown" | "finalization_unknown";
      unknownReceiptRef: MediaReceiptRef;
    }>
  | Readonly<{
      kind: "completed" | "partial";
      terminalReceiptRef: MediaReceiptRef;
      outcomeClass: "canonical";
    }>
  | Readonly<{
      kind: "failed" | "canceled";
      terminalReceiptRef: MediaReceiptRef;
      outcomeClass: "canonical";
    }>
  | Readonly<{
      kind: "failed" | "canceled";
      irreconcilableOutcomeReceiptRef: IrreconcilableOutcomeReceiptRef;
      outcomeClass: "irreconcilable";
    }>;

export type MediaStepState =
  | Readonly<{ kind: "blocked" }>
  | Readonly<{ kind: "ready" }>
  | Readonly<{ kind: "leased" }>
  | Readonly<{ kind: "running" }>
  | Readonly<{ kind: "provider_async" }>
  | Readonly<{ kind: "finalizing" }>
  | Readonly<{
      kind: "reconciling";
      reason: "submission_unknown" | "outcome_unknown" | "lease_lost";
      unknownReceiptRef: MediaReceiptRef;
    }>
  | Readonly<{ kind: "completed"; completionReceiptRef: MediaReceiptRef }>
  | Readonly<{ kind: "failed"; failureReceiptRef: MediaReceiptRef }>
  | Readonly<{ kind: "canceled"; cancellationReceiptRef: MediaReceiptRef }>;

export type MediaCandidateState =
  | Readonly<{ kind: "allocated" }>
  | Readonly<{ kind: "producing" }>
  | Readonly<{ kind: "output_received"; providerOutputFactRef: ProviderOutputFactRef }>
  | Readonly<{ kind: "validating"; providerOutputFactRef: ProviderOutputFactRef }>
  | Readonly<{
      kind: "ready";
      providerOutputFactRef: ProviderOutputFactRef;
      artifactVersionRef: ArtifactVersionRef;
      artifactFinalizationReceiptRef: ArtifactFinalizationReceiptRef;
      trustDecisionRef: TrustDecisionRef;
      attemptUsageEvidenceReceiptRef: AttemptUsageEvidenceReceiptRef;
      effectBudgetCommitRef: EffectBudgetCommitRef;
    }>
  | Readonly<{ kind: "restricted"; restrictionReceiptRef: MediaReceiptRef }>
  | Readonly<{ kind: "failed"; failureReceiptRef: MediaReceiptRef }>
  | Readonly<{ kind: "cancel_requested"; cancelIntentReceiptRef: MediaReceiptRef }>
  | Readonly<{ kind: "canceled"; cancellationReceiptRef: MediaReceiptRef }>
  | Readonly<{
      kind: "unknown";
      reason: "submission_unknown" | "outcome_unknown" | "finalization_unknown";
      unknownReceiptRef: MediaReceiptRef;
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

export type MediaOperationPlan = Readonly<{
  operation: MediaOperation;
  steps: readonly MediaStep[];
  candidates: readonly MediaCandidate[];
}>;

export function createMediaOperationPlan(input: Readonly<{
  operationRef: MediaOperationRef;
  operationInputRevisionRef: OperationInputRevisionRef;
  definition: CompiledOperationDefinitionRevision;
  steps: readonly Readonly<{ definitionStepKey: string; stepRef: MediaStepRef }>[];
  candidates: readonly Readonly<{
    definitionStepKey: string;
    outputSlot: string;
    candidateRef: MediaCandidateRef;
  }>[];
}>): MediaOperationPlan {
  const expectedStepKeys = new Set(input.definition.steps.map((step) => step.definitionStepKey));
  const suppliedStepKeys = new Set(input.steps.map((step) => step.definitionStepKey));
  const suppliedStepRefs = new Set(input.steps.map((step) => step.stepRef));
  if (input.steps.length !== input.definition.steps.length ||
      suppliedStepKeys.size !== input.steps.length || suppliedStepRefs.size !== input.steps.length ||
      !sameSet(expectedStepKeys, suppliedStepKeys)) {
    throw new Error("MEDIA_OPERATION_PLAN_ALLOCATION_MISMATCH");
  }
  const stepRefByKey = new Map(input.steps.map((step) => [step.definitionStepKey, step.stepRef]));
  const expectedCandidates = new Set(input.definition.steps.flatMap((step) =>
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

  const operation = Object.freeze({
    operationRef: input.operationRef,
    definitionRevisionRef: input.definition.definitionRevisionRef,
    operationInputRevisionRef: input.operationInputRevisionRef,
    expectedVersion: 1n,
    state: freezeState<MediaOperationState>({ kind: "admission_pending" }),
  });
  const steps = input.definition.steps.map((definitionStep) => Object.freeze({
    stepRef: stepRefByKey.get(definitionStep.definitionStepKey)!,
    operationRef: input.operationRef,
    definitionStepKey: definitionStep.definitionStepKey,
    required: definitionStep.required,
    expectedVersion: 1n,
    state: freezeState<MediaStepState>({ kind: "blocked" }),
  }));
  const allocationByKey = new Map(input.candidates.map((candidate) =>
    [candidateKey(candidate.definitionStepKey, candidate.outputSlot), candidate]));
  const candidates = input.definition.steps.flatMap((definitionStep) => {
    const stepRef = stepRefByKey.get(definitionStep.definitionStepKey)!;
    return definitionStep.candidateSlots.map((slot) => Object.freeze({
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
  nextState: MediaOperationState;
  closure?: Readonly<{
    definition: CompiledOperationDefinitionRevision;
    steps: readonly MediaStep[];
    candidates: readonly MediaCandidate[];
  }>;
}>): MediaOperation {
  if (input.operation.expectedVersion !== input.expectedVersion) {
    throw new Error("MEDIA_OPERATION_VERSION_CONFLICT");
  }
  if (!operationTransitions(input.operation.state).includes(input.nextState.kind)) {
    throw new Error("MEDIA_OPERATION_TRANSITION_INVALID");
  }
  if (input.nextState.kind === "completed") {
    if (input.closure === undefined || !completionReady(input.operation, input.closure)) {
      throw new Error("MEDIA_OPERATION_COMPLETION_NOT_READY");
    }
  } else if (input.nextState.kind === "partial") {
    if (input.closure?.definition.partialCompletion !== "allowed") {
      throw new Error("MEDIA_OPERATION_PARTIAL_NOT_ALLOWED");
    }
    if (completionReady(input.operation, input.closure)) {
      throw new Error("MEDIA_OPERATION_PARTIAL_NOT_APPLICABLE");
    }
    if (!partialReady(input.operation, input.closure)) {
      throw new Error("MEDIA_OPERATION_COMPLETION_NOT_READY");
    }
  } else if (input.nextState.kind === "failed" || input.nextState.kind === "canceled") {
    if (input.nextState.outcomeClass === "irreconcilable") {
      if (input.operation.state.kind !== "reconciling") {
        throw new Error("MEDIA_OPERATION_IRRECONCILABLE_OUTCOME_INVALID");
      }
    } else if (input.closure === undefined || !terminalEvidenceReady(input.operation, input.closure)) {
      throw new Error("MEDIA_OPERATION_TERMINAL_EVIDENCE_REQUIRED");
    }
  }
  return Object.freeze({ ...input.operation,
    expectedVersion: nextVersion(input.operation.expectedVersion),
    state: freezeState(input.nextState) });
}

export function transitionMediaStep(input: Readonly<{
  step: MediaStep;
  expectedVersion: bigint;
  nextState: MediaStepState;
}>): MediaStep {
  if (input.step.expectedVersion !== input.expectedVersion) throw new Error("MEDIA_STEP_VERSION_CONFLICT");
  if (!stepTransitions(input.step.state).includes(input.nextState.kind)) {
    throw new Error("MEDIA_STEP_TRANSITION_INVALID");
  }
  return Object.freeze({ ...input.step, expectedVersion: nextVersion(input.step.expectedVersion),
    state: freezeState(input.nextState) });
}

export function transitionMediaCandidate(input: Readonly<{
  candidate: MediaCandidate;
  expectedVersion: bigint;
  nextState: MediaCandidateState;
}>): MediaCandidate {
  if (input.candidate.expectedVersion !== input.expectedVersion) {
    throw new Error("MEDIA_CANDIDATE_VERSION_CONFLICT");
  }
  if (!candidateTransitions(input.candidate.state).includes(input.nextState.kind)) {
    throw new Error("MEDIA_CANDIDATE_TRANSITION_INVALID");
  }
  return Object.freeze({ ...input.candidate,
    expectedVersion: nextVersion(input.candidate.expectedVersion),
    state: freezeState(input.nextState) });
}

export function assertNever(_value: never, code = "MEDIA_STATE_NOT_EXHAUSTIVE"): never {
  throw new Error(code);
}

function operationTransitions(state: MediaOperationState): readonly MediaOperationState["kind"][] {
  switch (state.kind) {
    case "admission_pending": return ["authorized"];
    case "authorized": return ["queued"];
    case "queued": return ["active", "cancel_requested"];
    case "active": return ["finalizing", "cancel_requested", "reconciling"];
    case "finalizing": return ["completed", "partial", "failed", "canceled", "reconciling"];
    case "cancel_requested": return ["reconciling"];
    case "reconciling": return ["active", "finalizing", "completed", "partial", "failed", "canceled"];
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

function completionReady(
  operation: MediaOperation,
  closure: NonNullable<Parameters<typeof transitionMediaOperation>[0]["closure"]>,
): boolean {
  return closureMatches(operation, closure) && allChildrenCanonicallyClosed(closure) &&
    closure.definition.steps.every((definitionStep) => {
      const step = closure.steps.find((candidate) => candidate.definitionStepKey === definitionStep.definitionStepKey);
      return !definitionStep.required || step?.state.kind === "completed";
    }) && closure.definition.steps.every((definitionStep) =>
    definitionStep.candidateSlots.every((slot) => {
      const candidate = closure.candidates.find((value) =>
        value.definitionStepKey === definitionStep.definitionStepKey && value.outputSlot === slot.outputSlot);
      return !slot.required || candidate?.state.kind === "ready";
    })) && readyCandidateCount(closure.candidates) >= closure.definition.minimumReadyCandidates;
}

function partialReady(
  operation: MediaOperation,
  closure: NonNullable<Parameters<typeof transitionMediaOperation>[0]["closure"]>,
): boolean {
  return closureMatches(operation, closure) && allChildrenCanonicallyClosed(closure) &&
    readyCandidateCount(closure.candidates) >= closure.definition.minimumReadyCandidates;
}

function terminalEvidenceReady(
  operation: MediaOperation,
  closure: NonNullable<Parameters<typeof transitionMediaOperation>[0]["closure"]>,
): boolean {
  return closureMatches(operation, closure) && allChildrenCanonicallyClosed(closure);
}

function closureMatches(
  operation: MediaOperation,
  closure: NonNullable<Parameters<typeof transitionMediaOperation>[0]["closure"]>,
): boolean {
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

function allChildrenCanonicallyClosed(
  closure: NonNullable<Parameters<typeof transitionMediaOperation>[0]["closure"]>,
): boolean {
  return closure.steps.every((step) =>
    step.state.kind === "completed" || step.state.kind === "failed" || step.state.kind === "canceled") &&
    closure.candidates.every((candidate) => {
      switch (candidate.state.kind) {
        case "ready": return readyEvidencePresent(candidate.state);
        case "restricted":
        case "failed":
        case "canceled": return true;
        case "allocated":
        case "producing":
        case "output_received":
        case "validating":
        case "cancel_requested":
        case "unknown": return false;
        default: return assertNever(candidate.state);
      }
    });
}

function readyEvidencePresent(state: Extract<MediaCandidateState, { kind: "ready" }>): boolean {
  return [state.providerOutputFactRef, state.artifactVersionRef, state.artifactFinalizationReceiptRef,
    state.trustDecisionRef, state.attemptUsageEvidenceReceiptRef, state.effectBudgetCommitRef]
    .every((value) => typeof value === "string" && value.length > 0);
}

function readyCandidateCount(candidates: readonly MediaCandidate[]): number {
  return candidates.filter((candidate) => candidate.state.kind === "ready" &&
    readyEvidencePresent(candidate.state)).length;
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
