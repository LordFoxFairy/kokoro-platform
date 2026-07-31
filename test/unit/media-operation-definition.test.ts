import { describe, expect, it } from "vitest";
import {
  compiledOperationDefinitionRevision,
  type CallerRequestFingerprint,
  type CanonicalMediaRequestBytes,
  type CompiledOperationDefinitionRevision,
  type MediaDefinitionCanonicalizer,
  type OperationDefinitionRevisionInput,
} from "../../src/modules/media/domain/operation-definition.js";
import {
  operationDefinitionRevisionRef,
} from "../../src/modules/media/domain/references.js";

describe("Compiled Media operation definitions", () => {
  it("lets only compiler-issued Definitions cross compiled-only ports", () => {
    const rawDefinition: OperationDefinitionRevisionInput = {
      definitionRevisionRef: operationDefinitionRevisionRef("image.text_to_image@v1/revision:1"),
      partialCompletion: "allowed",
      minimumReadyCandidates: 1,
      steps: [{
        definitionStepKey: "generate",
        required: true,
        candidateSlots: [{ outputSlot: "image-1", required: true }],
      }],
    };
    const compiledOnlyPort = (_definition: CompiledOperationDefinitionRevision): boolean => true;

    // @ts-expect-error Raw inputs must pass through compiledOperationDefinitionRevision first.
    expect(compiledOnlyPort(rawDefinition)).toBe(true);
    expect(compiledOnlyPort(compiledOperationDefinitionRevision(rawDefinition))).toBe(true);
  });

  it("freezes a closed step and candidate-slot plan", () => {
    const definition = compiledOperationDefinitionRevision({
      definitionRevisionRef: operationDefinitionRevisionRef("image.text_to_image@v1/revision:1"),
      partialCompletion: "allowed",
      minimumReadyCandidates: 1,
      steps: [{
        definitionStepKey: "generate",
        required: true,
        candidateSlots: [
          { outputSlot: "image-1", required: true },
          { outputSlot: "image-2", required: false },
        ],
      }],
    });

    expect(definition.steps[0]).toMatchObject({
      definitionStepKey: "generate",
      required: true,
      candidateSlots: [
        { outputSlot: "image-1", required: true },
        { outputSlot: "image-2", required: false },
      ],
    });
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.steps)).toBe(true);
    expect(Object.isFrozen(definition.steps[0])).toBe(true);
    expect(Object.isFrozen(definition.steps[0]?.candidateSlots)).toBe(true);
    expect(Object.isFrozen(definition.steps[0]?.candidateSlots[0])).toBe(true);
  });

  it("rejects ambiguous or impossible compiled plans", () => {
    const base = {
      definitionRevisionRef: operationDefinitionRevisionRef("image.text_to_image@v1/revision:1"),
      partialCompletion: "allowed" as const,
      minimumReadyCandidates: 1,
    };
    expect(() => compiledOperationDefinitionRevision({ ...base, steps: [] }))
      .toThrow("MEDIA_DEFINITION_STEPS_INVALID");
    expect(() => compiledOperationDefinitionRevision({ ...base, steps: [{
      definitionStepKey: "generate", required: true,
      candidateSlots: [{ outputSlot: "image-1", required: true }],
    }, {
      definitionStepKey: "generate", required: false,
      candidateSlots: [{ outputSlot: "image-2", required: false }],
    }] })).toThrow("MEDIA_DEFINITION_STEP_DUPLICATE");
    expect(() => compiledOperationDefinitionRevision({ ...base, minimumReadyCandidates: 3,
      steps: [{ definitionStepKey: "generate", required: true,
        candidateSlots: [{ outputSlot: "image-1", required: true }] }] }))
      .toThrow("MEDIA_DEFINITION_READY_CANDIDATE_MINIMUM_INVALID");
    expect(() => compiledOperationDefinitionRevision({ ...base, steps: [{
      definitionStepKey: "generate", required: true, candidateSlots: [],
    }] })).toThrow("MEDIA_DEFINITION_READY_CANDIDATE_MINIMUM_INVALID");
    expect(() => compiledOperationDefinitionRevision({ ...base, steps: [{
      definitionStepKey: "generate", required: true,
      candidateSlots: [{ outputSlot: "image-1", required: true }],
    }, {
      definitionStepKey: "validate", required: true,
      candidateSlots: [{ outputSlot: "image-1", required: true }],
    }] })).toThrow("MEDIA_DEFINITION_OUTPUT_SLOT_DUPLICATE");
    expect(() => compiledOperationDefinitionRevision({ ...base,
      partialCompletion: "sometimes" as "allowed", steps: [{
        definitionStepKey: "generate", required: true,
        candidateSlots: [{ outputSlot: "image-1", required: true }],
      }] })).toThrow("MEDIA_DEFINITION_PARTIAL_COMPLETION_INVALID");
    expect(() => compiledOperationDefinitionRevision({ ...base, steps: [{
      definitionStepKey: "generate\tunsafe", required: true,
      candidateSlots: [{ outputSlot: "image-1", required: true }],
    }] })).toThrow("MEDIA_DEFINITION_STEP_KEY_INVALID");
  });

  it("allows non-output steps without pretending they own Candidate slots", () => {
    const definition = compiledOperationDefinitionRevision({
      definitionRevisionRef: operationDefinitionRevisionRef("image.text_to_image@v1/revision:1"),
      partialCompletion: "forbidden",
      minimumReadyCandidates: 1,
      steps: [{
        definitionStepKey: "generate", required: true,
        candidateSlots: [{ outputSlot: "image-1", required: true }],
      }, {
        definitionStepKey: "finalize", required: true, candidateSlots: [],
      }],
    });

    expect(definition.steps[1]).toEqual({
      definitionStepKey: "finalize", required: true, candidateSlots: [],
    });
    expect(Object.isFrozen(definition.steps[1]?.candidateSlots)).toBe(true);
  });

  it("reserves canonicalization for a Root-backed adapter without defining bytes or hashing", () => {
    type TypedRequest = Readonly<{ promptIntent: string }>;
    const calls: string[] = [];
    const canonicalizer: MediaDefinitionCanonicalizer<TypedRequest> = {
      canonicalize(input) {
        calls.push(`${input.definitionRevisionRef}:${input.request.promptIntent}`);
        return {
          canonicalBytes: new Uint8Array([1, 2, 3]) as CanonicalMediaRequestBytes,
          callerRequestFingerprint: "root-owned-fingerprint" as CallerRequestFingerprint,
        };
      },
    };

    const result = canonicalizer.canonicalize({
      definitionRevisionRef: operationDefinitionRevisionRef("image.text_to_image@v1/revision:1"),
      request: { promptIntent: "friendly fox" },
    });

    expect(calls).toEqual(["image.text_to_image@v1/revision:1:friendly fox"]);
    expect([...result.canonicalBytes]).toEqual([1, 2, 3]);
    expect(result.callerRequestFingerprint).toBe("root-owned-fingerprint");
  });
});
