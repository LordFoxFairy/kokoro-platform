import { describe, expect, it } from "vitest";
import {
  assertNever,
  createMediaOperationPlan,
  transitionMediaCandidate,
  transitionMediaOperation,
  transitionMediaStep,
  type MediaCandidate,
  type MediaOperationPlan,
  type MediaStep,
} from "../../src/modules/media/domain/media-operation.js";
import {
  compiledOperationDefinitionRevision,
  type CompiledOperationDefinitionRevision,
} from "../../src/modules/media/domain/operation-definition.js";
import {
  artifactFinalizationReceiptRef,
  artifactVersionRef,
  attemptUsageEvidenceReceiptRef,
  effectBudgetCommitRef,
  irreconcilableOutcomeReceiptRef,
  mediaCandidateRef,
  mediaOperationRef,
  mediaReceiptRef,
  mediaStepRef,
  operationDefinitionRevisionRef,
  operationInputRevisionRef,
  providerOutputFactRef,
  trustDecisionRef,
} from "../../src/modules/media/domain/references.js";

describe("Media operation domain plan", () => {
  it("preallocates the exact frozen Step and Candidate identities before any effect", () => {
    const plan = operationPlan();

    expect(plan.operation).toMatchObject({
      operationRef: "operation:01",
      definitionRevisionRef: "image.text_to_image@v1/revision:1",
      operationInputRevisionRef: "input-revision:01",
      expectedVersion: 1n,
      state: { kind: "admission_pending" },
    });
    expect(plan.steps).toMatchObject([
      { stepRef: "step:generate", definitionStepKey: "generate", required: true,
        expectedVersion: 1n, state: { kind: "blocked" } },
    ]);
    expect(plan.candidates).toMatchObject([
      { candidateRef: "candidate:image-1", outputSlot: "image-1", required: true,
        expectedVersion: 1n, state: { kind: "allocated" } },
      { candidateRef: "candidate:image-2", outputSlot: "image-2", required: false,
        expectedVersion: 1n, state: { kind: "allocated" } },
    ]);
    for (const value of [plan, plan.operation, plan.operation.state, plan.steps,
      plan.steps[0], plan.steps[0]?.state, plan.candidates, plan.candidates[0],
      plan.candidates[0]?.state]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it("rejects missing, duplicate, or invented Definition allocations", () => {
    const definition = operationDefinition();
    const base = {
      operationRef: mediaOperationRef("operation:01"),
      operationInputRevisionRef: operationInputRevisionRef("input-revision:01"),
      definition,
      steps: [{ definitionStepKey: "generate", stepRef: mediaStepRef("step:generate") }],
    };
    expect(() => createMediaOperationPlan({ ...base, candidates: [{
      definitionStepKey: "generate", outputSlot: "image-1",
      candidateRef: mediaCandidateRef("candidate:image-1"),
    }] })).toThrow("MEDIA_OPERATION_PLAN_ALLOCATION_MISMATCH");
    expect(() => createMediaOperationPlan({ ...base, candidates: [{
      definitionStepKey: "generate", outputSlot: "image-1",
      candidateRef: mediaCandidateRef("candidate:duplicate"),
    }, {
      definitionStepKey: "generate", outputSlot: "image-1",
      candidateRef: mediaCandidateRef("candidate:duplicate"),
    }] })).toThrow("MEDIA_OPERATION_PLAN_ALLOCATION_MISMATCH");
  });

  it("rejects terminal closures that alias distinct children to the same owner ref", () => {
    const definition = multiStepOperationDefinition();
    const plan = multiStepOperationPlan(definition);
    const finalizing = finalizingOperation(plan);
    const steps = plan.steps.map((step) => completedStep(step));
    const candidates = [readyCandidate(plan.candidates[0]!), failedCandidate(plan.candidates[1]!)];
    const duplicateStepRef = Object.freeze({ ...steps[1]!, stepRef: steps[0]!.stepRef });
    const duplicateCandidateRef = Object.freeze({
      ...candidates[1]!, candidateRef: candidates[0]!.candidateRef,
    });
    const complete = (
      closureSteps: readonly MediaStep[],
      closureCandidates: readonly MediaCandidate[],
    ) => transitionMediaOperation({
      operation: finalizing,
      expectedVersion: finalizing.expectedVersion,
      nextState: { kind: "completed", terminalReceiptRef: mediaReceiptRef("terminal:aliased-child"),
        outcomeClass: "canonical" },
      closure: { definition, steps: closureSteps, candidates: closureCandidates },
    });

    expect(() => complete([steps[0]!, duplicateStepRef], candidates))
      .toThrow("MEDIA_OPERATION_COMPLETION_NOT_READY");
    expect(() => complete(steps, [candidates[0]!, duplicateCandidateRef]))
      .toThrow("MEDIA_OPERATION_COMPLETION_NOT_READY");
  });
});

describe("Media state transitions", () => {
  it("follows the legal Operation, Step, and Candidate success path with monotonic versions", () => {
    const plan = operationPlan();
    const authorized = operationTransition(plan, { kind: "authorized" });
    const queued = operationTransition({ ...plan, operation: authorized }, { kind: "queued" });
    const active = operationTransition({ ...plan, operation: queued }, { kind: "active" });
    const finalizing = operationTransition({ ...plan, operation: active }, { kind: "finalizing" });

    const step = completedStep(plan.steps[0]!);
    const requiredCandidate = readyCandidate(plan.candidates[0]!);
    const optionalCandidate = failedCandidate(plan.candidates[1]!);
    const completed = transitionMediaOperation({
      operation: finalizing,
      expectedVersion: finalizing.expectedVersion,
      nextState: { kind: "completed", terminalReceiptRef: mediaReceiptRef("operation-terminal:01"),
        outcomeClass: "canonical" },
      closure: { definition: operationDefinition(), steps: [step],
        candidates: [requiredCandidate, optionalCandidate] },
    });

    expect(completed).toMatchObject({ expectedVersion: 6n,
      state: { kind: "completed", outcomeClass: "canonical" } });
    expect(step).toMatchObject({ expectedVersion: 6n, state: { kind: "completed" } });
    expect(requiredCandidate).toMatchObject({ expectedVersion: 5n, state: { kind: "ready",
      artifactVersionRef: "artifact-version:01",
      artifactFinalizationReceiptRef: "artifact-finalization:01" } });
    expect(Object.isFrozen(completed)).toBe(true);
    expect(Object.isFrozen(completed.state)).toBe(true);
  });

  it("rejects illegal transitions, stale versions, and every attempt to reopen terminal state", () => {
    const plan = operationPlan();
    expect(() => transitionMediaOperation({ operation: plan.operation, expectedVersion: 9n,
      nextState: { kind: "authorized" } })).toThrow("MEDIA_OPERATION_VERSION_CONFLICT");
    expect(() => transitionMediaOperation({ operation: plan.operation,
      expectedVersion: plan.operation.expectedVersion,
      nextState: { kind: "active" } })).toThrow("MEDIA_OPERATION_TRANSITION_INVALID");
    expect(() => transitionMediaStep({ step: plan.steps[0]!, expectedVersion: 1n,
      nextState: { kind: "running" } })).toThrow("MEDIA_STEP_TRANSITION_INVALID");
    expect(() => transitionMediaCandidate({ candidate: plan.candidates[0]!, expectedVersion: 1n,
      nextState: { kind: "ready", ...readyEvidence() } }))
      .toThrow("MEDIA_CANDIDATE_TRANSITION_INVALID");

    const terminal = terminalFailedOperation(plan);
    expect(() => transitionMediaOperation({ operation: terminal,
      expectedVersion: terminal.expectedVersion,
      nextState: { kind: "reconciling", reason: "outcome_unknown",
        unknownReceiptRef: mediaReceiptRef("unknown:late") } }))
      .toThrow("MEDIA_OPERATION_TRANSITION_INVALID");
  });

  it("requires every child to be terminal before a canonical failed or canceled outcome", () => {
    const plan = operationPlan();
    const finalizing = finalizingOperation(plan);
    const completed = completedStep(plan.steps[0]!);
    const terminalCandidate = failedCandidate(plan.candidates[1]!);
    const nonterminalCandidates = [
      plan.candidates[0]!,
      producingCandidate(plan.candidates[0]!),
      transitionMediaCandidate({ candidate: plan.candidates[0]!, expectedVersion: 1n,
        nextState: { kind: "cancel_requested",
          cancelIntentReceiptRef: mediaReceiptRef("candidate-cancel-intent:01") } }),
      validatingCandidate(plan.candidates[0]!),
    ];
    for (const candidate of nonterminalCandidates) {
      expect(() => transitionMediaOperation({ operation: finalizing,
        expectedVersion: finalizing.expectedVersion,
        nextState: { kind: "failed", terminalReceiptRef: mediaReceiptRef("terminal:failed:unsafe"),
          outcomeClass: "canonical" },
        closure: { definition: operationDefinition(), steps: [completed],
          candidates: [candidate, terminalCandidate] },
      })).toThrow("MEDIA_OPERATION_TERMINAL_EVIDENCE_REQUIRED");
    }
    expect(() => transitionMediaOperation({ operation: finalizing,
      expectedVersion: finalizing.expectedVersion,
      nextState: { kind: "canceled", terminalReceiptRef: mediaReceiptRef("terminal:canceled:unsafe"),
        outcomeClass: "canonical" },
      closure: { definition: operationDefinition(), steps: plan.steps,
        candidates: [failedCandidate(plan.candidates[0]!), terminalCandidate] },
    })).toThrow("MEDIA_OPERATION_TERMINAL_EVIDENCE_REQUIRED");
  });

  it("persists cancel intent without claiming the Provider canceled", () => {
    const plan = operationPlan();
    const authorized = operationTransition(plan, { kind: "authorized" });
    const queued = operationTransition({ ...plan, operation: authorized }, { kind: "queued" });
    const cancelRequested = operationTransition({ ...plan, operation: queued }, {
      kind: "cancel_requested",
      cancelIntentReceiptRef: mediaReceiptRef("cancel-intent:01"),
    });

    expect(cancelRequested.state).toEqual({ kind: "cancel_requested",
      cancelIntentReceiptRef: "cancel-intent:01" });
    expect(() => transitionMediaOperation({ operation: cancelRequested,
      expectedVersion: cancelRequested.expectedVersion,
      nextState: { kind: "canceled", terminalReceiptRef: mediaReceiptRef("terminal-canceled:01"),
        outcomeClass: "canonical" } })).toThrow("MEDIA_OPERATION_TRANSITION_INVALID");

    const reconciling = transitionMediaOperation({ operation: cancelRequested,
      expectedVersion: cancelRequested.expectedVersion,
      nextState: { kind: "reconciling", reason: "submission_unknown",
        unknownReceiptRef: mediaReceiptRef("unknown:cancel:01") } });
    const canceled = transitionMediaOperation({ operation: reconciling,
      expectedVersion: reconciling.expectedVersion,
      nextState: { kind: "canceled",
        irreconcilableOutcomeReceiptRef: irreconcilableOutcomeReceiptRef("irreconcilable:cancel:01"),
        outcomeClass: "irreconcilable" } });
    expect(canceled.state).toMatchObject({ kind: "canceled", outcomeClass: "irreconcilable" });
  });

  it("keeps unknown work reconciling and blocks completion until required finalization receipts exist", () => {
    const plan = operationPlan();
    const active = operationTransition({ ...plan,
      operation: operationTransition({ ...plan,
        operation: operationTransition(plan, { kind: "authorized" }) }, { kind: "queued" }) },
    { kind: "active" });
    const reconciling = operationTransition({ ...plan, operation: active }, {
      kind: "reconciling", reason: "outcome_unknown",
      unknownReceiptRef: mediaReceiptRef("unknown:operation:01"),
    });
    const step = reconcilingStep(plan.steps[0]!);
    const candidate = validatingCandidate(plan.candidates[0]!);
    const optional = failedCandidate(plan.candidates[1]!);

    expect(() => transitionMediaOperation({ operation: reconciling,
      expectedVersion: reconciling.expectedVersion,
      nextState: { kind: "completed", terminalReceiptRef: mediaReceiptRef("terminal:too-early"),
        outcomeClass: "canonical" },
      closure: { definition: operationDefinition(), steps: [step], candidates: [candidate, optional] },
    })).toThrow("MEDIA_OPERATION_COMPLETION_NOT_READY");
    expect(() => transitionMediaOperation({ operation: reconciling,
      expectedVersion: reconciling.expectedVersion,
      nextState: { kind: "failed", terminalReceiptRef: mediaReceiptRef("terminal:unsafe-failure"),
        outcomeClass: "canonical" },
    })).toThrow("MEDIA_OPERATION_TERMINAL_EVIDENCE_REQUIRED");
    expect(() => transitionMediaOperation({ operation: reconciling,
      expectedVersion: reconciling.expectedVersion,
      nextState: { kind: "failed", terminalReceiptRef: mediaReceiptRef("terminal:unsafe-failure"),
        outcomeClass: "canonical" },
      closure: { definition: operationDefinition(), steps: [step], candidates: [candidate, optional] },
    })).toThrow("MEDIA_OPERATION_TERMINAL_EVIDENCE_REQUIRED");
  });

  it("allows partial only when Definition permits it and every effect is canonically closed", () => {
    const definition = partialOperationDefinition();
    const plan = operationPlan(definition);
    const finalizing = finalizingOperation(plan);
    const step = completedStep(plan.steps[0]!);
    const ready = readyCandidate(plan.candidates[0]!);
    const failed = failedCandidate(plan.candidates[1]!);
    const partial = transitionMediaOperation({ operation: finalizing,
      expectedVersion: finalizing.expectedVersion,
      nextState: { kind: "partial", terminalReceiptRef: mediaReceiptRef("terminal:partial:01"),
        outcomeClass: "canonical" },
      closure: { definition, steps: [step], candidates: [ready, failed] },
    });
    expect(partial.state.kind).toBe("partial");

    const forbidden = compiledOperationDefinitionRevision({
      ...definition, partialCompletion: "forbidden",
    });
    expect(() => transitionMediaOperation({ operation: finalizing,
      expectedVersion: finalizing.expectedVersion,
      nextState: { kind: "partial", terminalReceiptRef: mediaReceiptRef("terminal:partial:02"),
        outcomeClass: "canonical" },
      closure: { definition: forbidden, steps: [step], candidates: [ready, failed] },
    })).toThrow("MEDIA_OPERATION_PARTIAL_NOT_ALLOWED");

    const completePlan = operationPlan();
    const completeFinalizing = finalizingOperation(completePlan);
    expect(() => transitionMediaOperation({ operation: completeFinalizing,
      expectedVersion: completeFinalizing.expectedVersion,
      nextState: { kind: "partial", terminalReceiptRef: mediaReceiptRef("terminal:partial:complete"),
        outcomeClass: "canonical" },
      closure: { definition: operationDefinition(), steps: [completedStep(completePlan.steps[0]!)],
        candidates: completePlan.candidates.map((candidate) => readyCandidate(candidate)) },
    })).toThrow("MEDIA_OPERATION_PARTIAL_NOT_APPLICABLE");
  });

  it("makes Step and Candidate reconciliation explicit and terminal children immutable", () => {
    const plan = operationPlan();
    const ready = transitionMediaStep({ step: plan.steps[0]!, expectedVersion: 1n,
      nextState: { kind: "ready" } });
    const leased = transitionMediaStep({ step: ready, expectedVersion: 2n,
      nextState: { kind: "leased" } });
    const reconciling = transitionMediaStep({ step: leased, expectedVersion: 3n,
      nextState: { kind: "reconciling", reason: "lease_lost",
        unknownReceiptRef: mediaReceiptRef("unknown:step:01") } });
    expect(reconciling.state.kind).toBe("reconciling");

    const candidateUnknown = transitionMediaCandidate({ candidate: producingCandidate(plan.candidates[0]!),
      expectedVersion: 2n,
      nextState: { kind: "unknown", reason: "outcome_unknown",
        unknownReceiptRef: mediaReceiptRef("unknown:candidate:01") } });
    const restricted = transitionMediaCandidate({ candidate: candidateUnknown,
      expectedVersion: candidateUnknown.expectedVersion,
      nextState: { kind: "restricted", restrictionReceiptRef: mediaReceiptRef("restricted:01") } });
    expect(() => transitionMediaCandidate({ candidate: restricted,
      expectedVersion: restricted.expectedVersion,
      nextState: { kind: "validating", providerOutputFactRef: providerOutputFactRef("output-fact:01") } }))
      .toThrow("MEDIA_CANDIDATE_TRANSITION_INVALID");
  });

  it("provides an explicit exhaustiveness trap for future union arms", () => {
    expect(() => assertNever("future_state" as never)).toThrow("MEDIA_STATE_NOT_EXHAUSTIVE");
  });
});

function operationDefinition(): CompiledOperationDefinitionRevision {
  return compiledOperationDefinitionRevision({
    definitionRevisionRef: operationDefinitionRevisionRef("image.text_to_image@v1/revision:1"),
    partialCompletion: "allowed",
    minimumReadyCandidates: 1,
    steps: [{ definitionStepKey: "generate", required: true, candidateSlots: [
      { outputSlot: "image-1", required: true },
      { outputSlot: "image-2", required: false },
    ] }],
  });
}

function partialOperationDefinition(): CompiledOperationDefinitionRevision {
  return compiledOperationDefinitionRevision({
    ...operationDefinition(),
    steps: [{ definitionStepKey: "generate", required: true, candidateSlots: [
      { outputSlot: "image-1", required: true },
      { outputSlot: "image-2", required: true },
    ] }],
  });
}

function multiStepOperationDefinition(): CompiledOperationDefinitionRevision {
  return compiledOperationDefinitionRevision({
    ...operationDefinition(),
    steps: [{ definitionStepKey: "generate", required: true, candidateSlots: [
      { outputSlot: "image-1", required: true },
      { outputSlot: "image-2", required: false },
    ] }, {
      definitionStepKey: "finalize", required: true, candidateSlots: [],
    }],
  });
}

function operationPlan(
  definition: CompiledOperationDefinitionRevision = operationDefinition(),
): MediaOperationPlan {
  return createMediaOperationPlan({
    operationRef: mediaOperationRef("operation:01"),
    operationInputRevisionRef: operationInputRevisionRef("input-revision:01"),
    definition,
    steps: [{ definitionStepKey: "generate", stepRef: mediaStepRef("step:generate") }],
    candidates: [
      { definitionStepKey: "generate", outputSlot: "image-1",
        candidateRef: mediaCandidateRef("candidate:image-1") },
      { definitionStepKey: "generate", outputSlot: "image-2",
        candidateRef: mediaCandidateRef("candidate:image-2") },
    ],
  });
}

function multiStepOperationPlan(
  definition: CompiledOperationDefinitionRevision = multiStepOperationDefinition(),
): MediaOperationPlan {
  return createMediaOperationPlan({
    operationRef: mediaOperationRef("operation:multi-step"),
    operationInputRevisionRef: operationInputRevisionRef("input-revision:multi-step"),
    definition,
    steps: [
      { definitionStepKey: "generate", stepRef: mediaStepRef("step:generate") },
      { definitionStepKey: "finalize", stepRef: mediaStepRef("step:finalize") },
    ],
    candidates: [
      { definitionStepKey: "generate", outputSlot: "image-1",
        candidateRef: mediaCandidateRef("candidate:image-1") },
      { definitionStepKey: "generate", outputSlot: "image-2",
        candidateRef: mediaCandidateRef("candidate:image-2") },
    ],
  });
}

function operationTransition(
  plan: MediaOperationPlan,
  nextState: Parameters<typeof transitionMediaOperation>[0]["nextState"],
) {
  return transitionMediaOperation({ operation: plan.operation,
    expectedVersion: plan.operation.expectedVersion, nextState });
}

function finalizingOperation(plan: MediaOperationPlan) {
  const authorized = operationTransition(plan, { kind: "authorized" });
  const queued = operationTransition({ ...plan, operation: authorized }, { kind: "queued" });
  const active = operationTransition({ ...plan, operation: queued }, { kind: "active" });
  return operationTransition({ ...plan, operation: active }, { kind: "finalizing" });
}

function terminalFailedOperation(plan: MediaOperationPlan) {
  const finalizing = finalizingOperation(plan);
  const step = failedStep(plan.steps[0]!);
  const candidates = plan.candidates.map((candidate) => failedCandidate(candidate));
  return transitionMediaOperation({ operation: finalizing, expectedVersion: finalizing.expectedVersion,
    nextState: { kind: "failed", terminalReceiptRef: mediaReceiptRef("terminal:failed:01"),
      outcomeClass: "canonical" },
    closure: { definition: operationDefinition(), steps: [step], candidates } });
}

function completedStep(step: MediaStep): MediaStep {
  const ready = transitionMediaStep({ step, expectedVersion: step.expectedVersion,
    nextState: { kind: "ready" } });
  const leased = transitionMediaStep({ step: ready, expectedVersion: ready.expectedVersion,
    nextState: { kind: "leased" } });
  const running = transitionMediaStep({ step: leased, expectedVersion: leased.expectedVersion,
    nextState: { kind: "running" } });
  const finalizing = transitionMediaStep({ step: running, expectedVersion: running.expectedVersion,
    nextState: { kind: "finalizing" } });
  return transitionMediaStep({ step: finalizing, expectedVersion: finalizing.expectedVersion,
    nextState: { kind: "completed", completionReceiptRef: mediaReceiptRef("step-completed:01") } });
}

function failedStep(step: MediaStep): MediaStep {
  const ready = transitionMediaStep({ step, expectedVersion: step.expectedVersion,
    nextState: { kind: "ready" } });
  const leased = transitionMediaStep({ step: ready, expectedVersion: ready.expectedVersion,
    nextState: { kind: "leased" } });
  const running = transitionMediaStep({ step: leased, expectedVersion: leased.expectedVersion,
    nextState: { kind: "running" } });
  return transitionMediaStep({ step: running, expectedVersion: running.expectedVersion,
    nextState: { kind: "failed", failureReceiptRef: mediaReceiptRef("step-failed:01") } });
}

function reconcilingStep(step: MediaStep): MediaStep {
  const ready = transitionMediaStep({ step, expectedVersion: step.expectedVersion,
    nextState: { kind: "ready" } });
  const leased = transitionMediaStep({ step: ready, expectedVersion: ready.expectedVersion,
    nextState: { kind: "leased" } });
  return transitionMediaStep({ step: leased, expectedVersion: leased.expectedVersion,
    nextState: { kind: "reconciling", reason: "outcome_unknown",
      unknownReceiptRef: mediaReceiptRef("unknown:step:01") } });
}

function producingCandidate(candidate: MediaCandidate): MediaCandidate {
  return transitionMediaCandidate({ candidate, expectedVersion: candidate.expectedVersion,
    nextState: { kind: "producing" } });
}

function validatingCandidate(candidate: MediaCandidate): MediaCandidate {
  const producing = producingCandidate(candidate);
  const outputReceived = transitionMediaCandidate({ candidate: producing,
    expectedVersion: producing.expectedVersion,
    nextState: { kind: "output_received", providerOutputFactRef: providerOutputFactRef("output-fact:01") } });
  return transitionMediaCandidate({ candidate: outputReceived,
    expectedVersion: outputReceived.expectedVersion,
    nextState: { kind: "validating", providerOutputFactRef: providerOutputFactRef("output-fact:01") } });
}

function readyCandidate(candidate: MediaCandidate): MediaCandidate {
  const validating = validatingCandidate(candidate);
  return transitionMediaCandidate({ candidate: validating,
    expectedVersion: validating.expectedVersion,
    nextState: { kind: "ready", ...readyEvidence() } });
}

function failedCandidate(candidate: MediaCandidate): MediaCandidate {
  const validating = validatingCandidate(candidate);
  return transitionMediaCandidate({ candidate: validating,
    expectedVersion: validating.expectedVersion,
    nextState: { kind: "failed", failureReceiptRef: mediaReceiptRef("candidate-failed:01") } });
}

function readyEvidence() {
  return {
    providerOutputFactRef: providerOutputFactRef("output-fact:01"),
    artifactVersionRef: artifactVersionRef("artifact-version:01"),
    artifactFinalizationReceiptRef: artifactFinalizationReceiptRef("artifact-finalization:01"),
    trustDecisionRef: trustDecisionRef("trust-decision:01"),
    attemptUsageEvidenceReceiptRef: attemptUsageEvidenceReceiptRef("usage-evidence:01"),
    effectBudgetCommitRef: effectBudgetCommitRef("effect-budget:01"),
  } as const;
}
