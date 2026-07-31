import { describe, expect, it } from "vitest";
import {
  attemptUsageEvidenceReceiptRef,
  canonicalMediaRequest,
  compiledOperationDefinitionRevision,
  createMediaOperationPlan,
  effectBudgetCommitRef,
  gatewayCanonicalOutcomeReceiptRef,
  mediaCandidateRef,
  mediaOperationRef,
  mediaStepRef,
  modelInvocationRef,
  operationDefinitionRevisionRef,
  operationInputRevisionRef,
  rehydrateCompiledOperationDefinitionRevision,
  rehydrateMediaCandidate,
  rehydrateMediaOperation,
  rehydrateMediaOperationClosure,
  rehydrateMediaOperationPlanInput,
  rehydrateMediaStep,
  type MediaDefinitionCanonicalizer,
  type MediaGatewayEffectClosure,
  type MediaOperationClosure,
  type MediaOperationPlanInput,
} from "../src/modules/media/index.js";

describe("Media public module API", () => {
  it("constructs and rehydrates public values without deep imports or casts", () => {
    const definition = compiledOperationDefinitionRevision({
      definitionRevisionRef: operationDefinitionRevisionRef("image.text_to_image@v1/revision:public"),
      partialCompletion: "forbidden",
      minimumReadyCandidates: 1,
      steps: [{ definitionStepKey: "generate", required: true,
        candidateSlots: [{ outputSlot: "image-1", required: true }] }],
    });
    const input: MediaOperationPlanInput = {
      operationRef: mediaOperationRef("operation:public"),
      operationInputRevisionRef: operationInputRevisionRef("input-revision:public"),
      definition,
      steps: [{ definitionStepKey: "generate", stepRef: mediaStepRef("step:public") }],
      candidates: [{ definitionStepKey: "generate", outputSlot: "image-1",
        candidateRef: mediaCandidateRef("candidate:public") }],
    };
    const plan = createMediaOperationPlan(input);
    const effect: MediaGatewayEffectClosure = {
      modelInvocationRef: modelInvocationRef("model-invocation:public"),
      candidateRefs: [plan.candidates[0]!.candidateRef],
      providerOutputFactRefs: [],
      attemptUsageEvidenceReceiptRef: attemptUsageEvidenceReceiptRef("usage-evidence:public"),
      effectBudgetCommitRef: effectBudgetCommitRef("effect-budget:public"),
      gatewayOutcome: { kind: "succeeded",
        gatewayOutcomeReceiptRef: gatewayCanonicalOutcomeReceiptRef("gateway-outcome:public") },
    };
    const closure: MediaOperationClosure = {
      definition,
      steps: plan.steps,
      candidates: plan.candidates,
      effects: [effect],
    };
    const canonicalizer: MediaDefinitionCanonicalizer<{ prompt: string }> = {
      canonicalize: () => canonicalMediaRequest({ canonicalBytes: new Uint8Array([1, 2, 3]),
        callerRequestFingerprint: "fingerprint:public" }),
    };

    expect(rehydrateCompiledOperationDefinitionRevision(definition)).toEqual(definition);
    expect(rehydrateMediaOperationPlanInput(input).definition).toEqual(definition);
    expect(rehydrateMediaOperation(plan.operation)).toEqual(plan.operation);
    expect(rehydrateMediaStep(plan.steps[0]!)).toEqual(plan.steps[0]);
    expect(rehydrateMediaCandidate(plan.candidates[0]!)).toEqual(plan.candidates[0]);
    expect(rehydrateMediaOperationClosure(closure).effects).toHaveLength(1);
    expect([...canonicalizer.canonicalize({ definitionRevisionRef: definition.definitionRevisionRef,
      request: { prompt: "fox" } }).canonicalBytes]).toEqual([1, 2, 3]);
  });
});
