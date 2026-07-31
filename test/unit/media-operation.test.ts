import { describe, expect, it } from "vitest";
import {
  createMediaOperationPlan,
  reduceMediaOperationTerminal,
  transitionMediaCandidate,
  transitionMediaOperation,
  transitionMediaStep,
  type MediaCandidate,
  type MediaGatewayEffectClosure,
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
} from "../../src/modules/media/domain/references.js";
import { rehydrateMediaOperationClosure } from
  "../../src/modules/media/domain/media-operation-runtime.js";

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

  it("fails closed on cast-corrupt plan input, allocation shapes, and opaque refs", () => {
    const definition = operationDefinition();
    const base = {
      operationRef: mediaOperationRef("operation:create:strict"),
      operationInputRevisionRef: operationInputRevisionRef("input-revision:create:strict"),
      definition,
      steps: [{ definitionStepKey: "generate", stepRef: mediaStepRef("step:create:strict") }],
      candidates: [
        { definitionStepKey: "generate", outputSlot: "image-1",
          candidateRef: mediaCandidateRef("candidate:create:image-1") },
        { definitionStepKey: "generate", outputSlot: "image-2",
          candidateRef: mediaCandidateRef("candidate:create:image-2") },
      ],
    };
    const create = (value: unknown) => createMediaOperationPlan(value as Parameters<
      typeof createMediaOperationPlan
    >[0]);

    expect(() => create({ ...base, operationRef: 7 })).toThrow();
    expect(() => create({ ...base, operationInputRevisionRef: new Date(0) })).toThrow();
    expect(() => create({ ...base, steps: [{ definitionStepKey: "generate", stepRef: new Map() }] }))
      .toThrow();
    class CustomAllocationList<Value> extends Array<Value> {}
    expect(() => create({ ...base, steps: new CustomAllocationList(...base.steps) })).toThrow();
    expect(() => create(Object.assign(Object.create({ inherited: true }), base))).toThrow();
    const customAllocation = Object.assign(Object.create({ inherited: true }), base.candidates[0]!);
    expect(() => create({ ...base, candidates: [customAllocation, base.candidates[1]!] })).toThrow();
    expect(() => create({ ...base, injected: true })).toThrow();
    expect(() => create({ ...base, candidates: [
      { ...base.candidates[0]!, injected: true }, base.candidates[1]!,
    ] })).toThrow();
    expect(() => create({ ...base, candidates: [
      { ...base.candidates[0]!, candidateRef: "candidate:\ud800" }, base.candidates[1]!,
    ] })).toThrow();
  });

  it("accepts well-formed Unicode allocation keys and rejects lone surrogates", () => {
    const definitionStepKey = "générer:图像";
    const outputSlot = "image:e\u0301:🎨";
    const definition = compiledOperationDefinitionRevision({
      definitionRevisionRef: operationDefinitionRevisionRef("image.text_to_image@v1/revision:unicode"),
      partialCompletion: "allowed",
      minimumReadyCandidates: 1,
      steps: [{ definitionStepKey, required: true,
        candidateSlots: [{ outputSlot, required: true }] }],
    });
    const base = {
      operationRef: mediaOperationRef("operation:unicode"),
      operationInputRevisionRef: operationInputRevisionRef("input-revision:unicode"),
      definition,
      steps: [{ definitionStepKey, stepRef: mediaStepRef("step:unicode") }],
      candidates: [{ definitionStepKey, outputSlot,
        candidateRef: mediaCandidateRef("candidate:unicode") }],
    };
    expect(createMediaOperationPlan(base).candidates[0]).toMatchObject({ definitionStepKey, outputSlot });

    const create = (value: unknown) => createMediaOperationPlan(value as Parameters<
      typeof createMediaOperationPlan
    >[0]);
    for (const malformed of ["key:\ud800x", "key:\udc00", "key:\ud800"]) {
      expect(() => create({ ...base, steps: [{ ...base.steps[0]!, definitionStepKey: malformed }] }))
        .toThrow("MEDIA_OPERATION_PLAN_ALLOCATION_INVALID");
      expect(() => create({ ...base, candidates: [{ ...base.candidates[0]!,
        definitionStepKey: malformed }] }))
        .toThrow("MEDIA_OPERATION_PLAN_ALLOCATION_INVALID");
      expect(() => create({ ...base, candidates: [{ ...base.candidates[0]!, outputSlot: malformed }] }))
        .toThrow("MEDIA_OPERATION_PLAN_ALLOCATION_INVALID");
    }
  });

  it("snapshots create inputs and rejects accessors without invoking them", () => {
    const definition = operationDefinition();
    const steps = [{ definitionStepKey: "generate", stepRef: mediaStepRef("step:accessor") }];
    const candidates = [
      { definitionStepKey: "generate", outputSlot: "image-1",
        candidateRef: mediaCandidateRef("candidate:accessor:image-1") },
      { definitionStepKey: "generate", outputSlot: "image-2",
        candidateRef: mediaCandidateRef("candidate:accessor:image-2") },
    ];
    const input = {
      operationRef: mediaOperationRef("operation:accessor"),
      operationInputRevisionRef: operationInputRevisionRef("input-revision:accessor"),
      definition,
      candidates,
    } as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(input, "steps", { enumerable: true,
      get: () => { reads += 1; return steps; } });

    expect(() => createMediaOperationPlan(input as unknown as Parameters<
      typeof createMediaOperationPlan
    >[0])).toThrowError(new Error("MEDIA_OPERATION_PLAN_INPUT_INVALID"));
    expect(reads).toBe(0);

    const accessorSteps = new Array(1);
    let indexReads = 0;
    Object.defineProperty(accessorSteps, 0, { enumerable: true,
      get: () => { indexReads += 1; return steps[0]; } });
    expect(() => createMediaOperationPlan({
      operationRef: mediaOperationRef("operation:accessor-index"),
      operationInputRevisionRef: operationInputRevisionRef("input-revision:accessor-index"),
      definition,
      steps: accessorSteps,
      candidates,
    })).toThrowError(new Error("MEDIA_OPERATION_PLAN_INPUT_INVALID"));
    expect(indexReads).toBe(0);
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
    ) => reduceMediaOperationTerminal({
      operation: finalizing,
      expectedVersion: finalizing.expectedVersion,
      terminalReceiptRef: mediaReceiptRef("terminal:aliased-child"),
      closure: terminalClosure(definition, closureSteps, closureCandidates),
    });

    expect(() => complete([steps[0]!, duplicateStepRef], candidates))
      .toThrow("MEDIA_OPERATION_TERMINAL_EVIDENCE_REQUIRED");
    expect(() => complete(steps, [candidates[0]!, duplicateCandidateRef]))
      .toThrow("MEDIA_OPERATION_TERMINAL_EVIDENCE_REQUIRED");
  });

  it("does not let distinct Candidates share Artifact identities or finalization receipts", () => {
    const plan = operationPlan();
    const finalizing = finalizingOperation(plan);
    const step = completedStep(plan.steps[0]!);
    const first = readyCandidate(plan.candidates[0]!);
    const secondReady = readyCandidate(plan.candidates[1]!);
    if (first.state.kind !== "ready" || secondReady.state.kind !== "ready") {
      throw new Error("TEST_READY_CANDIDATE_REQUIRED");
    }
    const second = Object.freeze({ ...secondReady, state: Object.freeze({
      ...secondReady.state,
      artifactVersionRef: first.state.artifactVersionRef,
      artifactFinalizationReceiptRef: first.state.artifactFinalizationReceiptRef,
    }) });

    expect(() => reduceMediaOperationTerminal({
      operation: finalizing,
      expectedVersion: finalizing.expectedVersion,
      terminalReceiptRef: mediaReceiptRef("terminal:aliased-artifact"),
      closure: terminalClosure(operationDefinition(), [step], [first, second]),
    })).toThrow("MEDIA_OPERATION_ARTIFACT_EVIDENCE_ALIASED");
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
    const completed = reduceMediaOperationTerminal({
      operation: finalizing,
      expectedVersion: finalizing.expectedVersion,
      terminalReceiptRef: mediaReceiptRef("operation-terminal:01"),
      closure: terminalClosure(operationDefinition(), [step], [requiredCandidate, optionalCandidate]),
    });

    expect(completed).toMatchObject({ expectedVersion: 6n,
      state: { kind: "completed", outcomeClass: "canonical" } });
    expect(step).toMatchObject({ expectedVersion: 6n, state: { kind: "completed" } });
    expect(requiredCandidate).toMatchObject({ expectedVersion: 5n, state: { kind: "ready",
      artifactVersionRef: "artifact-version:candidate:image-1",
      artifactFinalizationReceiptRef: "artifact-finalization:candidate:image-1" } });
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
      nextState: { kind: "ready", ...readyEvidence(plan.candidates[0]!) } }))
      .toThrow("MEDIA_CANDIDATE_TRANSITION_INVALID");

    const terminal = terminalFailedOperation(plan);
    expect(terminal.state).toMatchObject({ kind: "failed", outcomeClass: "canonical",
      cause: { kind: "gateway_effect_failed", failureCause: "provider_failed" } });
    expect(() => transitionMediaOperation({ operation: terminal,
      expectedVersion: terminal.expectedVersion,
      nextState: { kind: "reconciling", reason: "outcome_unknown",
        unknownReceiptRef: mediaReceiptRef("unknown:late") } }))
      .toThrow("MEDIA_OPERATION_TRANSITION_INVALID");
  });

  it("fails closed on corrupt Operation aggregates and requested states", () => {
    const plan = operationPlan();
    const corruptOperation = Object.freeze({ ...plan.operation,
      operationRef: undefined }) as unknown as Parameters<
        typeof transitionMediaOperation
      >[0]["operation"];
    expect(() => transitionMediaOperation({
      operation: corruptOperation,
      expectedVersion: corruptOperation.expectedVersion,
      nextState: { kind: "authorized" },
    })).toThrow("MEDIA_OPERATION_INVALID");

    const authorized = operationTransition(plan, { kind: "authorized" });
    const queued = operationTransition({ ...plan, operation: authorized }, { kind: "queued" });
    const active = operationTransition({ ...plan, operation: queued }, { kind: "active" });
    expect(() => transitionMediaOperation({
      operation: active,
      expectedVersion: active.expectedVersion,
      nextState: { kind: "reconciling", reason: "invented", unknownReceiptRef: undefined } as unknown as
        Parameters<typeof transitionMediaOperation>[0]["nextState"],
    })).toThrow("MEDIA_OPERATION_STATE_INVALID");
    expect(() => transitionMediaOperation({
      operation: plan.operation,
      expectedVersion: 1 as unknown as bigint,
      nextState: { kind: "authorized" },
    })).toThrow("MEDIA_EXPECTED_VERSION_INVALID");
    const corruptVersion = Object.freeze({ ...plan.operation,
      expectedVersion: 0n }) as unknown as Parameters<typeof transitionMediaOperation>[0]["operation"];
    expect(() => transitionMediaOperation({
      operation: corruptVersion,
      expectedVersion: 1n,
      nextState: { kind: "authorized" },
    })).toThrow("MEDIA_OPERATION_INVALID");
    expect(() => transitionMediaOperation({
      operation: plan.operation,
      expectedVersion: plan.operation.expectedVersion,
      nextState: { kind: "authorized", injected: true } as unknown as
        Parameters<typeof transitionMediaOperation>[0]["nextState"],
    })).toThrow("MEDIA_OPERATION_STATE_INVALID");
  });

  it("rejects stateful aggregate and state accessors with stable error codes", () => {
    const plan = operationPlan();
    const operation = { ...plan.operation } as Record<string, unknown>;
    delete operation.state;
    let aggregateReads = 0;
    Object.defineProperty(operation, "state", { enumerable: true,
      get: () => { aggregateReads += 1; return { kind: "admission_pending" }; } });
    expect(() => transitionMediaOperation({
      operation: operation as unknown as Parameters<typeof transitionMediaOperation>[0]["operation"],
      expectedVersion: 1n,
      nextState: { kind: "authorized" },
    })).toThrowError(new Error("MEDIA_OPERATION_INVALID"));
    expect(aggregateReads).toBe(0);

    let stateReads = 0;
    const nextState = {} as Record<string, unknown>;
    Object.defineProperty(nextState, "kind", { enumerable: true,
      get: () => { stateReads += 1; return stateReads === 1 ? "authorized" : "active"; } });
    expect(() => transitionMediaOperation({
      operation: plan.operation,
      expectedVersion: 1n,
      nextState: nextState as unknown as Parameters<typeof transitionMediaOperation>[0]["nextState"],
    })).toThrowError(new Error("MEDIA_OPERATION_STATE_INVALID"));
    expect(stateReads).toBe(0);
  });

  it("rejects accessor indexes in closure arrays without invoking them", () => {
    const plan = operationPlan();
    const effects = new Array(1);
    let reads = 0;
    Object.defineProperty(effects, 0, { enumerable: true,
      get: () => { reads += 1; return effectClosure(plan.candidates, "succeeded"); } });

    expect(() => rehydrateMediaOperationClosure({
      definition: operationDefinition(),
      steps: plan.steps,
      candidates: plan.candidates,
      effects,
    })).toThrowError(new Error("MEDIA_OPERATION_CLOSURE_INVALID"));
    expect(reads).toBe(0);
  });

  it("fails closed on corrupt Step aggregates and requested terminal evidence", () => {
    const plan = operationPlan();
    const corruptStep = Object.freeze({ ...plan.steps[0]!, state: Object.freeze({
      kind: "completed",
      completionReceiptRef: undefined,
    }) }) as unknown as MediaStep;
    expect(() => transitionMediaStep({
      step: corruptStep,
      expectedVersion: corruptStep.expectedVersion,
      nextState: { kind: "ready" },
    })).toThrow("MEDIA_STEP_INVALID");

    const ready = transitionMediaStep({ step: plan.steps[0]!, expectedVersion: 1n,
      nextState: { kind: "ready" } });
    const leased = transitionMediaStep({ step: ready, expectedVersion: 2n,
      nextState: { kind: "leased" } });
    const running = transitionMediaStep({ step: leased, expectedVersion: 3n,
      nextState: { kind: "running" } });
    expect(() => transitionMediaStep({
      step: running,
      expectedVersion: running.expectedVersion,
      nextState: { kind: "failed", failureCause: "invented", failureReceiptRef: undefined } as unknown as
        Parameters<typeof transitionMediaStep>[0]["nextState"],
    })).toThrow("MEDIA_STEP_STATE_INVALID");
  });

  it("fails closed on corrupt Candidate aggregates and requested reconciliation evidence", () => {
    const plan = operationPlan();
    const corruptCandidate = Object.freeze({ ...plan.candidates[0]!, candidateRef: undefined,
      state: Object.freeze({ kind: "allocated" }) }) as unknown as MediaCandidate;
    expect(() => transitionMediaCandidate({
      candidate: corruptCandidate,
      expectedVersion: corruptCandidate.expectedVersion,
      nextState: { kind: "producing" },
    })).toThrow("MEDIA_CANDIDATE_INVALID");

    const producing = producingCandidate(plan.candidates[0]!);
    expect(() => transitionMediaCandidate({
      candidate: producing,
      expectedVersion: producing.expectedVersion,
      nextState: { kind: "unknown", reason: "invented", unknownReceiptRef: undefined } as unknown as
        Parameters<typeof transitionMediaCandidate>[0]["nextState"],
    })).toThrow("MEDIA_CANDIDATE_STATE_INVALID");
  });

  it("rehydrates terminal closure Definitions and child identities before reducing", () => {
    const plan = operationPlan();
    const finalizing = finalizingOperation(plan);
    const step = failedStep(plan.steps[0]!);
    const candidates = plan.candidates.map((candidate) => gatewayFailedCandidate(candidate));
    const corruptOperation = Object.freeze({ ...finalizing,
      operationInputRevisionRef: undefined }) as unknown as Parameters<
        typeof reduceMediaOperationTerminal
      >[0]["operation"];
    expect(() => reduceMediaOperationTerminal({
      operation: corruptOperation,
      expectedVersion: corruptOperation.expectedVersion,
      terminalReceiptRef: mediaReceiptRef("terminal:corrupt-operation"),
      closure: terminalClosure(operationDefinition(), [step], candidates, "failed"),
    })).toThrow("MEDIA_OPERATION_INVALID");

    const corruptDefinition = Object.freeze({ ...operationDefinition(), steps: Object.freeze([{
      definitionStepKey: "generate",
      required: "yes",
      candidateSlots: operationDefinition().steps[0]!.candidateSlots,
    }]) }) as unknown as CompiledOperationDefinitionRevision;
    expect(() => reduceMediaOperationTerminal({
      operation: finalizing,
      expectedVersion: finalizing.expectedVersion,
      terminalReceiptRef: mediaReceiptRef("terminal:corrupt-definition"),
      closure: terminalClosure(corruptDefinition, [step], candidates, "failed"),
    })).toThrow("MEDIA_DEFINITION_STEP_REQUIRED_INVALID");

    const corruptStep = Object.freeze({ ...step, stepRef: undefined }) as unknown as MediaStep;
    const corruptCandidates = candidates.map((candidate) => Object.freeze({
      ...candidate,
      stepRef: undefined,
    }) as unknown as MediaCandidate);
    expect(() => reduceMediaOperationTerminal({
      operation: finalizing,
      expectedVersion: finalizing.expectedVersion,
      terminalReceiptRef: mediaReceiptRef("terminal:corrupt-child-identity"),
      closure: terminalClosure(operationDefinition(), [corruptStep], corruptCandidates, "failed"),
    })).toThrow("MEDIA_STEP_INVALID");
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
      expect(() => reduceMediaOperationTerminal({ operation: finalizing,
        expectedVersion: finalizing.expectedVersion,
        terminalReceiptRef: mediaReceiptRef("terminal:failed:unsafe"),
        closure: terminalClosure(operationDefinition(), [completed], [candidate, terminalCandidate], "failed"),
      })).toThrow("MEDIA_OPERATION_TERMINAL_EVIDENCE_REQUIRED");
    }
    expect(() => reduceMediaOperationTerminal({ operation: finalizing,
      expectedVersion: finalizing.expectedVersion,
      terminalReceiptRef: mediaReceiptRef("terminal:canceled:unsafe"),
      closure: terminalClosure(operationDefinition(), plan.steps,
        [failedCandidate(plan.candidates[0]!), terminalCandidate], "canceled"),
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
      nextState: { kind: "canceled" } as unknown as Parameters<
        typeof transitionMediaOperation
      >[0]["nextState"],
    })).toThrow("MEDIA_OPERATION_STATE_INVALID");

    const reconciling = transitionMediaOperation({ operation: cancelRequested,
      expectedVersion: cancelRequested.expectedVersion,
      nextState: { kind: "reconciling", reason: "submission_unknown",
        unknownReceiptRef: mediaReceiptRef("unknown:cancel:01") } });
    const irreconcilable = reduceMediaOperationTerminal({ operation: reconciling,
      expectedVersion: reconciling.expectedVersion,
      terminalReceiptRef: mediaReceiptRef("terminal:irreconcilable:01"),
      closure: terminalClosure(operationDefinition(), [failedStep(plan.steps[0]!)],
        plan.candidates.map((candidate) => gatewayIrreconcilableCandidate(candidate)), "irreconcilable"),
    });
    expect(irreconcilable.state).toMatchObject({ kind: "failed", outcomeClass: "irreconcilable",
      cause: { kind: "gateway_effect_irreconcilable",
        irreconcilableOutcomeReceiptRef: "irreconcilable:effect:01" } });
  });

  it("derives a canonical canceled outcome only from closed cancellation evidence", () => {
    const plan = operationPlan();
    const finalizing = finalizingOperation(plan);
    const canceled = reduceMediaOperationTerminal({
      operation: finalizing,
      expectedVersion: finalizing.expectedVersion,
      terminalReceiptRef: mediaReceiptRef("terminal:canceled:01"),
      closure: terminalClosure(operationDefinition(), [canceledStep(plan.steps[0]!)],
        plan.candidates.map((candidate) => canceledCandidate(candidate)), "canceled"),
    });

    expect(canceled.state).toMatchObject({ kind: "canceled", outcomeClass: "canonical",
      cause: { kind: "gateway_effects_canceled", cancellationReceiptRef: "gateway-canceled:01",
        gatewayOutcomeReceiptRef: "gateway-outcome:canceled:01" } });
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

    expect(() => reduceMediaOperationTerminal({ operation: reconciling,
      expectedVersion: reconciling.expectedVersion,
      terminalReceiptRef: mediaReceiptRef("terminal:too-early"),
      closure: terminalClosure(operationDefinition(), [step], [candidate, optional]),
    })).toThrow("MEDIA_OPERATION_TERMINAL_EVIDENCE_REQUIRED");
  });

  it("allows partial only when Definition permits it and every effect is canonically closed", () => {
    const definition = partialOperationDefinition();
    const plan = operationPlan(definition);
    const finalizing = finalizingOperation(plan);
    const step = completedStep(plan.steps[0]!);
    const ready = readyCandidate(plan.candidates[0]!);
    const failed = failedCandidate(plan.candidates[1]!);
    const partial = reduceMediaOperationTerminal({ operation: finalizing,
      expectedVersion: finalizing.expectedVersion,
      terminalReceiptRef: mediaReceiptRef("terminal:partial:01"),
      closure: terminalClosure(definition, [step], [ready, failed]),
    });
    expect(partial.state.kind).toBe("partial");

    const forbidden = compiledOperationDefinitionRevision({
      ...definition, partialCompletion: "forbidden",
    });
    const forbiddenOutcome = reduceMediaOperationTerminal({ operation: finalizing,
      expectedVersion: finalizing.expectedVersion,
      terminalReceiptRef: mediaReceiptRef("terminal:partial:02"),
      closure: terminalClosure(forbidden, [step], [ready, failed]),
    });
    expect(forbiddenOutcome.state).toMatchObject({ kind: "failed", outcomeClass: "canonical",
      cause: { kind: "required_candidate_unavailable" } });

    const completePlan = operationPlan();
    const completeFinalizing = finalizingOperation(completePlan);
    const complete = reduceMediaOperationTerminal({ operation: completeFinalizing,
      expectedVersion: completeFinalizing.expectedVersion,
      terminalReceiptRef: mediaReceiptRef("terminal:partial:complete"),
      closure: terminalClosure(operationDefinition(), [completedStep(completePlan.steps[0]!)],
        completePlan.candidates.map((candidate) => readyCandidate(candidate))),
    });
    expect(complete.state.kind).toBe("completed");
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
    const recovered = transitionMediaCandidate({ candidate: candidateUnknown,
      expectedVersion: candidateUnknown.expectedVersion,
      nextState: { kind: "validating", providerOutputFactRef: providerOutputFactRef("output-fact:01") } });
    const restricted = transitionMediaCandidate({ candidate: recovered,
      expectedVersion: recovered.expectedVersion,
      nextState: { kind: "restricted", providerOutputFactRef: providerOutputFactRef("output-fact:01"),
        restrictionReceiptRef: mediaReceiptRef("restricted:01") } });
    expect(() => transitionMediaCandidate({ candidate: restricted,
      expectedVersion: restricted.expectedVersion,
      nextState: { kind: "validating", providerOutputFactRef: providerOutputFactRef("output-fact:01") } }))
      .toThrow("MEDIA_CANDIDATE_TRANSITION_INVALID");
  });

  it("carries the exact Provider output fact through validation and terminal evidence", () => {
    const candidate = operationPlan().candidates[0]!;
    const producing = producingCandidate(candidate);
    const outputReceived = transitionMediaCandidate({
      candidate: producing,
      expectedVersion: producing.expectedVersion,
      nextState: { kind: "output_received", providerOutputFactRef: providerOutputFactRef("output-fact:A") },
    });
    expect(() => transitionMediaCandidate({
      candidate: outputReceived,
      expectedVersion: outputReceived.expectedVersion,
      nextState: { kind: "validating", providerOutputFactRef: providerOutputFactRef("output-fact:B") },
    })).toThrow("MEDIA_CANDIDATE_PROVIDER_OUTPUT_FACT_MISMATCH");

    const validating = transitionMediaCandidate({
      candidate: outputReceived,
      expectedVersion: outputReceived.expectedVersion,
      nextState: { kind: "validating", providerOutputFactRef: providerOutputFactRef("output-fact:A") },
    });
    expect(() => transitionMediaCandidate({
      candidate: validating,
      expectedVersion: validating.expectedVersion,
      nextState: {
        kind: "failed",
        providerOutputFactRef: providerOutputFactRef("output-fact:B"),
        failureCause: "provider_output_invalid",
        failureReceiptRef: mediaReceiptRef("candidate-failed:fact-swap"),
      },
    })).toThrow("MEDIA_CANDIDATE_PROVIDER_OUTPUT_FACT_MISMATCH");
    expect(() => transitionMediaCandidate({
      candidate: validating,
      expectedVersion: validating.expectedVersion,
      nextState: {
        kind: "ready",
        ...readyEvidence(candidate),
        providerOutputFactRef: providerOutputFactRef("output-fact:B"),
      },
    })).toThrow("MEDIA_CANDIDATE_PROVIDER_OUTPUT_FACT_MISMATCH");
  });

  it("enforces the closed Candidate failure-cause and Provider-fact matrix", () => {
    const candidate = operationPlan().candidates[0]!;
    const validating = validatingCandidate(candidate);
    expect(() => transitionMediaCandidate({
      candidate: validating,
      expectedVersion: validating.expectedVersion,
      nextState: {
        kind: "failed",
        providerOutputFactRef: providerOutputFactRef("output-fact:01"),
        failureCause: "gateway_effect_failed",
        failureReceiptRef: mediaReceiptRef("candidate-failed:gateway-after-output"),
      } as unknown as Parameters<typeof transitionMediaCandidate>[0]["nextState"],
    })).toThrow("MEDIA_CANDIDATE_STATE_INVALID");

    const producing = producingCandidate(candidate);
    const unknown = transitionMediaCandidate({ candidate: producing,
      expectedVersion: producing.expectedVersion,
      nextState: { kind: "unknown", reason: "outcome_unknown",
        unknownReceiptRef: mediaReceiptRef("candidate-unknown:no-output") } });
    expect(() => transitionMediaCandidate({
      candidate: unknown,
      expectedVersion: unknown.expectedVersion,
      nextState: { kind: "failed", failureCause: "provider_output_invalid",
        failureReceiptRef: mediaReceiptRef("candidate-failed:post-output-without-fact") } as unknown as
        Parameters<typeof transitionMediaCandidate>[0]["nextState"],
    })).toThrow("MEDIA_CANDIDATE_STATE_INVALID");
    expect(() => transitionMediaCandidate({
      candidate: unknown,
      expectedVersion: unknown.expectedVersion,
      nextState: { kind: "failed", providerOutputFactRef: providerOutputFactRef("output-fact:introduced"),
        failureCause: "provider_output_invalid",
        failureReceiptRef: mediaReceiptRef("candidate-failed:introduced-fact") },
    })).toThrow("MEDIA_CANDIDATE_PROVIDER_OUTPUT_FACT_MISMATCH");

    const corruptGatewayFact = Object.freeze({ ...candidate, state: Object.freeze({
      kind: "failed",
      providerOutputFactRef: providerOutputFactRef("output-fact:corrupt"),
      failureCause: "gateway_effect_failed",
      failureReceiptRef: mediaReceiptRef("candidate-failed:corrupt-gateway-fact"),
    }) }) as unknown as MediaCandidate;
    expect(() => transitionMediaCandidate({ candidate: corruptGatewayFact,
      expectedVersion: corruptGatewayFact.expectedVersion,
      nextState: { kind: "producing" } })).toThrow("MEDIA_CANDIDATE_INVALID");

    const corruptPostOutput = Object.freeze({ ...candidate, state: Object.freeze({
      kind: "failed",
      failureCause: "provider_output_invalid",
      failureReceiptRef: mediaReceiptRef("candidate-failed:corrupt-missing-fact"),
    }) }) as unknown as MediaCandidate;
    expect(() => transitionMediaCandidate({ candidate: corruptPostOutput,
      expectedVersion: corruptPostOutput.expectedVersion,
      nextState: { kind: "producing" } })).toThrow("MEDIA_CANDIDATE_INVALID");
  });

  it("derives minimum-ready failure evidence independently of closure Candidate order", () => {
    const definition = minimumFailureDefinition();
    const plan = operationPlan(definition);
    const finalizing = finalizingOperation(plan);
    const step = completedStep(plan.steps[0]!);
    const first = failedCandidate(plan.candidates[0]!);
    const second = failedCandidate(plan.candidates[1]!);
    const reduce = (candidates: readonly MediaCandidate[]) => reduceMediaOperationTerminal({
      operation: finalizing,
      expectedVersion: finalizing.expectedVersion,
      terminalReceiptRef: mediaReceiptRef("terminal:minimum-ready-order"),
      closure: terminalClosure(definition, [step], candidates),
    });

    const canonical = reduce([first, second]);
    const permuted = reduce([second, first]);
    expect(canonical.state).toMatchObject({ kind: "failed", outcomeClass: "canonical",
      cause: { kind: "minimum_ready_candidates_not_met", candidateRef: first.candidateRef } });
    expect(permuted.state).toEqual(canonical.state);
  });

  it("binds Artifact finalization evidence to the exact Candidate", () => {
    const candidate = operationPlan().candidates[0]!;
    const validating = validatingCandidate(candidate);
    expect(() => transitionMediaCandidate({
      candidate: validating,
      expectedVersion: validating.expectedVersion,
      nextState: {
        kind: "ready",
        ...readyEvidence(candidate),
        artifactFinalizationCandidateRef: mediaCandidateRef("candidate:image-2"),
      },
    })).toThrow("MEDIA_CANDIDATE_ARTIFACT_FINALIZATION_BINDING_MISMATCH");
  });

  it("does not let a caller choose an Operation terminal outcome", () => {
    const plan = operationPlan();
    const finalizing = finalizingOperation(plan);
    const candidates = plan.candidates.map((candidate) => readyCandidate(candidate));
    const completed = reduceMediaOperationTerminal({
      operation: finalizing,
      expectedVersion: finalizing.expectedVersion,
      terminalReceiptRef: mediaReceiptRef("terminal:derived-completion"),
      closure: terminalClosure(operationDefinition(), [completedStep(plan.steps[0]!)], candidates),
    });
    expect(completed.state.kind).toBe("completed");

    const nonTerminalOnly = (state: Parameters<typeof transitionMediaOperation>[0]["nextState"]) => state;
    // @ts-expect-error Terminal outcomes are available only through reduceMediaOperationTerminal.
    expect(nonTerminalOnly({ kind: "failed" }).kind).toBe("failed");
  });

  it("requires Gateway outcome, Attempt Usage, and budget closure before terminal", () => {
    const plan = operationPlan();
    const finalizing = finalizingOperation(plan);
    expect(() => reduceMediaOperationTerminal({
      operation: finalizing,
      expectedVersion: finalizing.expectedVersion,
      terminalReceiptRef: mediaReceiptRef("terminal:no-effect-closure"),
      closure: {
        definition: operationDefinition(),
        steps: [failedStep(plan.steps[0]!)],
        candidates: plan.candidates.map((candidate) => failedCandidate(candidate)),
        effects: [],
      },
    })).toThrow("MEDIA_OPERATION_EFFECT_CLOSURE_REQUIRED");
  });

  it("rejects Provider, Usage, and Gateway receipt aliasing across invocations", () => {
    const plan = operationPlan();
    const finalizing = finalizingOperation(plan);
    const first = readyCandidate(plan.candidates[0]!);
    const secondReady = readyCandidate(plan.candidates[1]!);
    if (secondReady.state.kind !== "ready") throw new Error("TEST_READY_CANDIDATE_REQUIRED");
    const second = Object.freeze({ ...secondReady, state: Object.freeze({
      ...secondReady.state,
      effectBudgetCommitRef: effectBudgetCommitRef("effect-budget:02"),
    }) });
    const sharedFact = providerOutputFactRef("output-fact:01");
    const sharedUsage = attemptUsageEvidenceReceiptRef("usage-evidence:01");
    const sharedOutcome = gatewayCanonicalOutcomeReceiptRef("gateway-outcome:succeeded:01");
    const effects = [{
      modelInvocationRef: modelInvocationRef("model-invocation:01"),
      candidateRefs: [first.candidateRef],
      providerOutputFactRefs: [sharedFact],
      attemptUsageEvidenceReceiptRef: sharedUsage,
      effectBudgetCommitRef: effectBudgetCommitRef("effect-budget:01"),
      gatewayOutcome: { kind: "succeeded", gatewayOutcomeReceiptRef: sharedOutcome },
    }, {
      modelInvocationRef: modelInvocationRef("model-invocation:02"),
      candidateRefs: [second.candidateRef],
      providerOutputFactRefs: [sharedFact],
      attemptUsageEvidenceReceiptRef: sharedUsage,
      effectBudgetCommitRef: effectBudgetCommitRef("effect-budget:02"),
      gatewayOutcome: { kind: "succeeded", gatewayOutcomeReceiptRef: sharedOutcome },
    }] as unknown as readonly MediaGatewayEffectClosure[];

    expect(() => reduceMediaOperationTerminal({
      operation: finalizing,
      expectedVersion: finalizing.expectedVersion,
      terminalReceiptRef: mediaReceiptRef("terminal:aliased-effect-evidence"),
      closure: {
        definition: operationDefinition(),
        steps: [completedStep(plan.steps[0]!)],
        candidates: [first, second],
        effects,
      },
    })).toThrow("MEDIA_OPERATION_EFFECT_EVIDENCE_ALIASED");
  });

  it("rejects Gateway receipt identity aliasing across evidence types and invocations", () => {
    const plan = operationPlan();
    const finalizing = finalizingOperation(plan);
    const reconciling = reconcilingOperation(plan);
    const step = failedStep(plan.steps[0]!);

    const ready = readyCandidate(plan.candidates[0]!);
    const canceled = canceledCandidate(plan.candidates[1]!);
    const succeededEffect = effectClosure([ready], "succeeded", "01");
    if (succeededEffect.gatewayOutcome.kind !== "succeeded") {
      throw new Error("TEST_SUCCEEDED_EFFECT_REQUIRED");
    }
    const canceledEffect = effectClosure([canceled], "canceled", "02");
    if (canceledEffect.gatewayOutcome.kind !== "canceled") {
      throw new Error("TEST_CANCELED_EFFECT_REQUIRED");
    }
    const canonicalAsCancellation = Object.freeze({ ...canceledEffect, gatewayOutcome: Object.freeze({
      ...canceledEffect.gatewayOutcome,
      cancellationReceiptRef: mediaReceiptRef(succeededEffect.gatewayOutcome.gatewayOutcomeReceiptRef),
    }) });
    expect(() => reduceMediaOperationTerminal({
      operation: finalizing,
      expectedVersion: finalizing.expectedVersion,
      terminalReceiptRef: mediaReceiptRef("terminal:cross-type-canonical-cancellation"),
      closure: Object.freeze({ definition: operationDefinition(), steps: Object.freeze([step]),
        candidates: Object.freeze([ready, canceled]),
        effects: Object.freeze([succeededEffect, canonicalAsCancellation]) }),
    })).toThrow("MEDIA_OPERATION_EFFECT_EVIDENCE_ALIASED");

    const irreconcilable = gatewayIrreconcilableCandidate(plan.candidates[1]!);
    const irreconcilableEffect = effectClosure([irreconcilable], "irreconcilable", "02");
    if (irreconcilableEffect.gatewayOutcome.kind !== "irreconcilable") {
      throw new Error("TEST_IRRECONCILABLE_EFFECT_REQUIRED");
    }
    const canonicalAsIrreconcilable = Object.freeze({ ...irreconcilableEffect,
      gatewayOutcome: Object.freeze({ ...irreconcilableEffect.gatewayOutcome,
        irreconcilableOutcomeReceiptRef: irreconcilableOutcomeReceiptRef(
          succeededEffect.gatewayOutcome.gatewayOutcomeReceiptRef,
        ) }) });
    expect(() => reduceMediaOperationTerminal({
      operation: reconciling,
      expectedVersion: reconciling.expectedVersion,
      terminalReceiptRef: mediaReceiptRef("terminal:cross-type-canonical-irreconcilable"),
      closure: Object.freeze({ definition: operationDefinition(), steps: Object.freeze([step]),
        candidates: Object.freeze([ready, irreconcilable]),
        effects: Object.freeze([succeededEffect, canonicalAsIrreconcilable]) }),
    })).toThrow("MEDIA_OPERATION_EFFECT_EVIDENCE_ALIASED");

    const firstCanceled = canceledCandidate(plan.candidates[0]!);
    const firstCanceledEffect = effectClosure([firstCanceled], "canceled", "03");
    if (firstCanceledEffect.gatewayOutcome.kind !== "canceled") {
      throw new Error("TEST_CANCELED_EFFECT_REQUIRED");
    }
    const cancellationAsIrreconcilable = Object.freeze({ ...irreconcilableEffect,
      gatewayOutcome: Object.freeze({ ...irreconcilableEffect.gatewayOutcome,
        irreconcilableOutcomeReceiptRef: irreconcilableOutcomeReceiptRef(
          firstCanceledEffect.gatewayOutcome.cancellationReceiptRef,
        ) }) });
    expect(() => reduceMediaOperationTerminal({
      operation: reconciling,
      expectedVersion: reconciling.expectedVersion,
      terminalReceiptRef: mediaReceiptRef("terminal:cross-type-cancellation-irreconcilable"),
      closure: Object.freeze({ definition: operationDefinition(), steps: Object.freeze([step]),
        candidates: Object.freeze([firstCanceled, irreconcilable]),
        effects: Object.freeze([firstCanceledEffect, cancellationAsIrreconcilable]) }),
    })).toThrow("MEDIA_OPERATION_EFFECT_EVIDENCE_ALIASED");
  });

  it("rejects Candidate terminal evidence that contradicts its Gateway outcome", () => {
    const plan = operationPlan();
    const finalizing = finalizingOperation(plan);
    const failed = plan.candidates.map((candidate) => failedCandidate(candidate));
    const artifactFailed = failed.map((candidate) => {
      if (candidate.state.kind !== "failed" || !("providerOutputFactRef" in candidate.state)) {
        throw new Error("TEST_POST_OUTPUT_FAILED_CANDIDATE_REQUIRED");
      }
      return Object.freeze({ ...candidate, state: Object.freeze({ ...candidate.state,
        failureCause: "artifact_finalization_failed" as const }) });
    });
    expect(() => reduceMediaOperationTerminal({
      operation: finalizing,
      expectedVersion: finalizing.expectedVersion,
      terminalReceiptRef: mediaReceiptRef("terminal:contradictory-cancel"),
      closure: terminalClosure(operationDefinition(), [failedStep(plan.steps[0]!)],
        artifactFailed, "canceled"),
    })).toThrow("MEDIA_OPERATION_CANDIDATE_OUTCOME_MISMATCH");

    const canceled = plan.candidates.map((candidate) => canceledCandidate(candidate));
    expect(() => reduceMediaOperationTerminal({
      operation: finalizing,
      expectedVersion: finalizing.expectedVersion,
      terminalReceiptRef: mediaReceiptRef("terminal:contradictory-success"),
      closure: terminalClosure(operationDefinition(), [canceledStep(plan.steps[0]!)], canceled),
    })).toThrow("MEDIA_OPERATION_CANDIDATE_OUTCOME_MISMATCH");
  });

  it("rejects corrupt effect closures with absent typed receipts", () => {
    const plan = operationPlan();
    const finalizing = finalizingOperation(plan);
    const candidates = plan.candidates.map((candidate) => gatewayFailedCandidate(candidate));
    const valid = effectClosure(candidates, "failed");
    const corrupt = Object.freeze({
      ...valid,
      attemptUsageEvidenceReceiptRef: undefined,
      effectBudgetCommitRef: undefined,
      gatewayOutcome: Object.freeze({ ...valid.gatewayOutcome, gatewayOutcomeReceiptRef: undefined }),
    }) as unknown as MediaGatewayEffectClosure;

    expect(() => reduceMediaOperationTerminal({
      operation: finalizing,
      expectedVersion: finalizing.expectedVersion,
      terminalReceiptRef: mediaReceiptRef("terminal:corrupt-effect"),
      closure: {
        definition: operationDefinition(),
        steps: [failedStep(plan.steps[0]!)],
        candidates,
        effects: [corrupt],
      },
    })).toThrow("MEDIA_OPERATION_EFFECT_CLOSURE_INVALID");
  });

  it("selects deterministic failure evidence without process locale ordering", () => {
    const plan = operationPlan();
    const finalizing = finalizingOperation(plan);
    const first = gatewayFailedCandidate(plan.candidates[0]!);
    const second = gatewayFailedCandidate(plan.candidates[1]!);
    const umlaut = Object.freeze({ ...effectClosure([first], "failed", "umlaut"),
      modelInvocationRef: modelInvocationRef("model-invocation:ä") });
    const ascii = Object.freeze({ ...effectClosure([second], "failed", "ascii"),
      modelInvocationRef: modelInvocationRef("model-invocation:z") });
    const terminal = reduceMediaOperationTerminal({
      operation: finalizing,
      expectedVersion: finalizing.expectedVersion,
      terminalReceiptRef: mediaReceiptRef("terminal:deterministic-order"),
      closure: {
        definition: operationDefinition(),
        steps: [failedStep(plan.steps[0]!)],
        candidates: [first, second],
        effects: [umlaut, ascii],
      },
    });

    expect(terminal.state).toMatchObject({ kind: "failed",
      cause: { kind: "gateway_effect_failed", modelInvocationRef: "model-invocation:z" } });
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

function minimumFailureDefinition(): CompiledOperationDefinitionRevision {
  return compiledOperationDefinitionRevision({
    ...operationDefinition(),
    partialCompletion: "forbidden",
    minimumReadyCandidates: 1,
    steps: [{ definitionStepKey: "generate", required: true, candidateSlots: [
      { outputSlot: "image-1", required: false },
      { outputSlot: "image-2", required: false },
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

function reconcilingOperation(plan: MediaOperationPlan) {
  const authorized = operationTransition(plan, { kind: "authorized" });
  const queued = operationTransition({ ...plan, operation: authorized }, { kind: "queued" });
  const active = operationTransition({ ...plan, operation: queued }, { kind: "active" });
  return operationTransition({ ...plan, operation: active }, { kind: "reconciling",
    reason: "outcome_unknown", unknownReceiptRef: mediaReceiptRef("unknown:operation:reducer") });
}

function terminalFailedOperation(plan: MediaOperationPlan) {
  const finalizing = finalizingOperation(plan);
  const step = failedStep(plan.steps[0]!);
  const candidates = plan.candidates.map((candidate) => gatewayFailedCandidate(candidate));
  return reduceMediaOperationTerminal({ operation: finalizing, expectedVersion: finalizing.expectedVersion,
    terminalReceiptRef: mediaReceiptRef("terminal:failed:01"),
    closure: terminalClosure(operationDefinition(), [step], candidates, "failed") });
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
    nextState: { kind: "failed", failureCause: "gateway_effect_failed",
      failureReceiptRef: mediaReceiptRef("step-failed:01") } });
}

function canceledStep(step: MediaStep): MediaStep {
  const ready = transitionMediaStep({ step, expectedVersion: step.expectedVersion,
    nextState: { kind: "ready" } });
  const leased = transitionMediaStep({ step: ready, expectedVersion: ready.expectedVersion,
    nextState: { kind: "leased" } });
  const running = transitionMediaStep({ step: leased, expectedVersion: leased.expectedVersion,
    nextState: { kind: "running" } });
  return transitionMediaStep({ step: running, expectedVersion: running.expectedVersion,
    nextState: { kind: "canceled", cancellationCause: "gateway_effect_canceled",
      cancellationReceiptRef: mediaReceiptRef(`step-canceled:${step.stepRef}`) } });
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
    nextState: { kind: "ready", ...readyEvidence(candidate) } });
}

function failedCandidate(candidate: MediaCandidate): MediaCandidate {
  const validating = validatingCandidate(candidate);
  return transitionMediaCandidate({ candidate: validating,
    expectedVersion: validating.expectedVersion,
    nextState: { kind: "failed", providerOutputFactRef: providerOutputFactRef("output-fact:01"),
      failureCause: "provider_output_invalid",
      failureReceiptRef: mediaReceiptRef(`candidate-failed:${candidate.candidateRef}`) } });
}

function gatewayFailedCandidate(candidate: MediaCandidate): MediaCandidate {
  const producing = producingCandidate(candidate);
  const unknown = transitionMediaCandidate({ candidate: producing,
    expectedVersion: producing.expectedVersion,
    nextState: { kind: "unknown", reason: "outcome_unknown",
      unknownReceiptRef: mediaReceiptRef(`candidate-unknown:${candidate.candidateRef}`) } });
  return transitionMediaCandidate({ candidate: unknown, expectedVersion: unknown.expectedVersion,
    nextState: { kind: "failed", failureCause: "gateway_effect_failed",
      failureReceiptRef: mediaReceiptRef(`candidate-gateway-failed:${candidate.candidateRef}`) } });
}

function gatewayIrreconcilableCandidate(candidate: MediaCandidate): MediaCandidate {
  const producing = producingCandidate(candidate);
  const unknown = transitionMediaCandidate({ candidate: producing,
    expectedVersion: producing.expectedVersion,
    nextState: { kind: "unknown", reason: "outcome_unknown",
      unknownReceiptRef: mediaReceiptRef(`candidate-unknown:${candidate.candidateRef}`) } });
  return transitionMediaCandidate({ candidate: unknown, expectedVersion: unknown.expectedVersion,
    nextState: { kind: "failed", failureCause: "gateway_outcome_irreconcilable",
      failureReceiptRef: mediaReceiptRef(`candidate-irreconcilable:${candidate.candidateRef}`) } });
}

function canceledCandidate(candidate: MediaCandidate): MediaCandidate {
  const requested = transitionMediaCandidate({ candidate, expectedVersion: candidate.expectedVersion,
    nextState: { kind: "cancel_requested",
      cancelIntentReceiptRef: mediaReceiptRef(`candidate-cancel-intent:${candidate.candidateRef}`) } });
  return transitionMediaCandidate({ candidate: requested, expectedVersion: requested.expectedVersion,
    nextState: { kind: "canceled", cancellationCause: "gateway_effect_canceled",
      cancellationReceiptRef: mediaReceiptRef(`candidate-canceled:${candidate.candidateRef}`) } });
}

function readyEvidence(candidate: MediaCandidate) {
  return {
    providerOutputFactRef: providerOutputFactRef("output-fact:01"),
    artifactFinalizationCandidateRef: candidate.candidateRef,
    artifactVersionRef: artifactVersionRef(`artifact-version:${candidate.candidateRef}`),
    artifactFinalizationReceiptRef: artifactFinalizationReceiptRef(
      `artifact-finalization:${candidate.candidateRef}`,
    ),
    trustDecisionRef: trustDecisionRef(`trust-decision:${candidate.candidateRef}`),
    attemptUsageEvidenceReceiptRef: attemptUsageEvidenceReceiptRef("usage-evidence:01"),
    effectBudgetCommitRef: effectBudgetCommitRef("effect-budget:01"),
  } as const;
}

function terminalClosure(
  definition: CompiledOperationDefinitionRevision,
  steps: readonly MediaStep[],
  candidates: readonly MediaCandidate[],
  outcome: "succeeded" | "failed" | "canceled" | "irreconcilable" = "succeeded",
) {
  return Object.freeze({
    definition,
    steps: Object.freeze([...steps]),
    candidates: Object.freeze([...candidates]),
    effects: Object.freeze([effectClosure(candidates, outcome)]),
  });
}

function effectClosure(
  candidates: readonly MediaCandidate[],
  outcome: "succeeded" | "failed" | "canceled" | "irreconcilable",
  suffix = "01",
): MediaGatewayEffectClosure {
  const common = {
    modelInvocationRef: modelInvocationRef(`model-invocation:${suffix}`),
    candidateRefs: Object.freeze(candidates.map((candidate) => candidate.candidateRef)),
    providerOutputFactRefs: Object.freeze(candidateProviderFacts(candidates)),
    attemptUsageEvidenceReceiptRef: attemptUsageEvidenceReceiptRef(`usage-evidence:${suffix}`),
    effectBudgetCommitRef: effectBudgetCommitRef(`effect-budget:${suffix}`),
  } as const;
  if (outcome === "succeeded") return Object.freeze({ ...common, gatewayOutcome: Object.freeze({
    kind: "succeeded" as const,
    gatewayOutcomeReceiptRef: gatewayCanonicalOutcomeReceiptRef(`gateway-outcome:succeeded:${suffix}`),
  }) });
  if (outcome === "failed") return Object.freeze({ ...common, gatewayOutcome: Object.freeze({
    kind: "failed" as const,
    failureCause: "provider_failed" as const,
    gatewayOutcomeReceiptRef: gatewayCanonicalOutcomeReceiptRef(`gateway-outcome:failed:${suffix}`),
  }) });
  if (outcome === "canceled") return Object.freeze({ ...common, gatewayOutcome: Object.freeze({
    kind: "canceled" as const,
    cancellationReceiptRef: mediaReceiptRef(`gateway-canceled:${suffix}`),
    gatewayOutcomeReceiptRef: gatewayCanonicalOutcomeReceiptRef(`gateway-outcome:canceled:${suffix}`),
  }) });
  return Object.freeze({ ...common, gatewayOutcome: Object.freeze({
    kind: "irreconcilable" as const,
    reason: "outcome_deadline_exceeded" as const,
    irreconcilableOutcomeReceiptRef: irreconcilableOutcomeReceiptRef(`irreconcilable:effect:${suffix}`),
  }) });
}

function candidateProviderFacts(candidates: readonly MediaCandidate[]) {
  const facts = new Set<ReturnType<typeof providerOutputFactRef>>();
  for (const candidate of candidates) {
    const state = candidate.state;
    if ("providerOutputFactRef" in state && state.providerOutputFactRef !== undefined) {
      facts.add(state.providerOutputFactRef);
    }
  }
  return [...facts];
}
