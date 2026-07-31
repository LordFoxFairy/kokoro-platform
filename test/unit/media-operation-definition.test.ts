import { describe, expect, it } from "vitest";
import {
  compiledOperationDefinitionRevision,
  type CompiledOperationDefinitionRevision,
  type OperationDefinitionRevisionInput,
} from "../../src/modules/media/domain/operation-definition.js";
import { canonicalMediaRequest } from "../../src/modules/media/domain/canonical-media-request.js";
import type {
  MediaDefinitionCanonicalizer,
} from "../../src/modules/media/application/contracts/media-definition-canonicalizer.js";
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

  it("accepts well-formed Unicode Definition keys and rejects lone surrogates", () => {
    const base = {
      definitionRevisionRef: operationDefinitionRevisionRef("image.text_to_image@v1/revision:unicode"),
      partialCompletion: "allowed" as const,
      minimumReadyCandidates: 1,
    };
    const composedStepKey = "générer:图像";
    const decomposedOutputSlot = "image:e\u0301:🎨";
    expect(compiledOperationDefinitionRevision({ ...base, steps: [{
      definitionStepKey: composedStepKey,
      required: true,
      candidateSlots: [{ outputSlot: decomposedOutputSlot, required: true }],
    }] }).steps[0]).toMatchObject({
      definitionStepKey: composedStepKey,
      candidateSlots: [{ outputSlot: decomposedOutputSlot }],
    });

    for (const definitionStepKey of ["generate:\ud800x", "generate:\udc00", "generate:\ud800"]) {
      expect(() => compiledOperationDefinitionRevision({ ...base, steps: [{
        definitionStepKey,
        required: true,
        candidateSlots: [{ outputSlot: "image-1", required: true }],
      }] })).toThrow("MEDIA_DEFINITION_STEP_KEY_INVALID");
    }
    for (const outputSlot of ["image:\ud800x", "image:\udc00", "image:\ud800"]) {
      expect(() => compiledOperationDefinitionRevision({ ...base, steps: [{
        definitionStepKey: "generate",
        required: true,
        candidateSlots: [{ outputSlot, required: true }],
      }] })).toThrow("MEDIA_DEFINITION_OUTPUT_SLOT_INVALID");
    }
  });

  it("rejects corrupted persistence values instead of branding them as compiled", () => {
    const base = {
      definitionRevisionRef: operationDefinitionRevisionRef("image.text_to_image@v1/revision:1"),
      partialCompletion: "allowed" as const,
      minimumReadyCandidates: 1,
    };
    expect(() => compiledOperationDefinitionRevision({ ...base, steps: [{
      definitionStepKey: "generate",
      required: "yes" as unknown as boolean,
      candidateSlots: [{ outputSlot: "image-1", required: true }],
    }] })).toThrow("MEDIA_DEFINITION_STEP_REQUIRED_INVALID");
    expect(() => compiledOperationDefinitionRevision({ ...base, steps: [{
      definitionStepKey: "generate",
      required: true,
      candidateSlots: [{ outputSlot: "image-1", required: 1 as unknown as boolean }],
    }] })).toThrow("MEDIA_DEFINITION_OUTPUT_SLOT_REQUIRED_INVALID");
    expect(() => compiledOperationDefinitionRevision({
      ...base,
      definitionRevisionRef: 7 as unknown as OperationDefinitionRevisionInput["definitionRevisionRef"],
      steps: [{ definitionStepKey: "generate", required: true,
        candidateSlots: [{ outputSlot: "image-1", required: true }] }],
    })).toThrow("MEDIA_DEFINITION_REVISION_REF_INVALID");
    class CustomList<Value> extends Array<Value> {}
    const step = { definitionStepKey: "generate", required: true,
      candidateSlots: [{ outputSlot: "image-1", required: true }] };
    expect(() => compiledOperationDefinitionRevision({ ...base,
      steps: new CustomList(step) as unknown as OperationDefinitionRevisionInput["steps"],
    })).toThrow("MEDIA_DEFINITION_STEPS_INVALID");
    expect(() => compiledOperationDefinitionRevision({ ...base, steps: [{ ...step,
      candidateSlots: new CustomList(...step.candidateSlots),
    }] })).toThrow("MEDIA_DEFINITION_CANDIDATES_INVALID");
  });

  it("rejects accessor records and accessor array indexes without invoking them", () => {
    const base = {
      definitionRevisionRef: operationDefinitionRevisionRef("image.text_to_image@v1/revision:accessor"),
      partialCompletion: "allowed" as const,
      minimumReadyCandidates: 1,
    };
    const step = { definitionStepKey: "generate", required: true,
      candidateSlots: [{ outputSlot: "image-1", required: true }] };
    let recordReads = 0;
    const accessorDefinition = { ...base } as Record<string, unknown>;
    Object.defineProperty(accessorDefinition, "steps", { enumerable: true,
      get: () => { recordReads += 1; return [step]; } });
    expect(() => compiledOperationDefinitionRevision(accessorDefinition as unknown as
      OperationDefinitionRevisionInput)).toThrowError(new Error("MEDIA_DEFINITION_INPUT_INVALID"));
    expect(recordReads).toBe(0);

    let indexReads = 0;
    const accessorSteps = new Array(1);
    Object.defineProperty(accessorSteps, 0, { enumerable: true,
      get: () => { indexReads += 1; return step; } });
    expect(() => compiledOperationDefinitionRevision({ ...base,
      steps: accessorSteps })).toThrowError(new Error("MEDIA_DEFINITION_STEPS_INVALID"));
    expect(indexReads).toBe(0);
  });

  it("bounds step, per-step slot, and total Candidate cardinality", () => {
    const base = {
      definitionRevisionRef: operationDefinitionRevisionRef("image.text_to_image@v1/revision:1"),
      partialCompletion: "allowed" as const,
      minimumReadyCandidates: 1,
    };
    expect(() => compiledOperationDefinitionRevision({ ...base,
      steps: Array.from({ length: 33 }, (_, index) => ({
        definitionStepKey: `step-${index}`,
        required: true,
        candidateSlots: index === 0 ? [{ outputSlot: "image-1", required: true }] : [],
      })),
    })).toThrow("MEDIA_DEFINITION_STEP_COUNT_EXCEEDED");
    expect(() => compiledOperationDefinitionRevision({ ...base, steps: [{
      definitionStepKey: "generate",
      required: true,
      candidateSlots: Array.from({ length: 17 }, (_, index) => ({
        outputSlot: `image-${index}`,
        required: index === 0,
      })),
    }] })).toThrow("MEDIA_DEFINITION_STEP_CANDIDATE_COUNT_EXCEEDED");
    expect(() => compiledOperationDefinitionRevision({ ...base,
      steps: Array.from({ length: 5 }, (_, stepIndex) => ({
        definitionStepKey: `step-${stepIndex}`,
        required: true,
        candidateSlots: Array.from({ length: 13 }, (_, slotIndex) => ({
          outputSlot: `image-${stepIndex}-${slotIndex}`,
          required: stepIndex === 0 && slotIndex === 0,
        })),
      })),
    })).toThrow("MEDIA_DEFINITION_CANDIDATE_COUNT_EXCEEDED");
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
    const sourceBytes = new Uint8Array([1, 2, 3]);
    const canonicalizer: MediaDefinitionCanonicalizer<TypedRequest> = {
      canonicalize(input) {
        calls.push(`${input.definitionRevisionRef}:${input.request.promptIntent}`);
        return canonicalMediaRequest({ canonicalBytes: sourceBytes,
          callerRequestFingerprint: "root-owned-fingerprint" });
      },
    };

    const result = canonicalizer.canonicalize({
      definitionRevisionRef: operationDefinitionRevisionRef("image.text_to_image@v1/revision:1"),
      request: { promptIntent: "friendly fox" },
    });

    expect(calls).toEqual(["image.text_to_image@v1/revision:1:friendly fox"]);
    sourceBytes[0] = 9;
    expect([...result.canonicalBytes]).toEqual([1, 2, 3]);
    const returnedBytes = result.canonicalBytes;
    returnedBytes[1] = 9;
    expect([...result.canonicalBytes]).toEqual([1, 2, 3]);
    expect(result.callerRequestFingerprint).toBe("root-owned-fingerprint");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rejects exotic canonical byte views and closes the returned value prototype", () => {
    let proxyTraps = 0;
    const proxyBytes = new Proxy(new Uint8Array([1, 2, 3]), {
      get: (target, key, receiver) => {
        proxyTraps += 1;
        return Reflect.get(target, key, receiver);
      },
      getOwnPropertyDescriptor: (target, key) => {
        proxyTraps += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      getPrototypeOf: (target) => {
        proxyTraps += 1;
        return Reflect.getPrototypeOf(target);
      },
    });
    expect(() => canonicalMediaRequest({ canonicalBytes: proxyBytes,
      callerRequestFingerprint: "fingerprint:proxy" }))
      .toThrowError(new Error("MEDIA_CANONICAL_REQUEST_BYTES_INVALID"));
    expect(proxyTraps).toBe(0);

    const sharedBytes = new Uint8Array(new SharedArrayBuffer(3));
    expect(() => canonicalMediaRequest({ canonicalBytes: sharedBytes,
      callerRequestFingerprint: "fingerprint:shared" }))
      .toThrowError(new Error("MEDIA_CANONICAL_REQUEST_BYTES_INVALID"));
    class CustomBytes extends Uint8Array {}
    expect(() => canonicalMediaRequest({ canonicalBytes: new CustomBytes([1, 2, 3]),
      callerRequestFingerprint: "fingerprint:subclass" }))
      .toThrowError(new Error("MEDIA_CANONICAL_REQUEST_BYTES_INVALID"));
    const detachedBytes = new Uint8Array([1, 2, 3]);
    structuredClone(detachedBytes.buffer, { transfer: [detachedBytes.buffer] });
    expect(() => canonicalMediaRequest({ canonicalBytes: detachedBytes,
      callerRequestFingerprint: "fingerprint:detached" }))
      .toThrowError(new Error("MEDIA_CANONICAL_REQUEST_BYTES_INVALID"));

    const value = canonicalMediaRequest({ canonicalBytes: new Uint8Array([4, 5, 6]),
      callerRequestFingerprint: "fingerprint:prototype" });
    const propertyOwner = Object.getPrototypeOf(value) ?? value;
    const originalDescriptor = Object.getOwnPropertyDescriptor(propertyOwner, "canonicalBytes");
    let redefineError: unknown;
    try {
      Object.defineProperty(propertyOwner, "canonicalBytes", { configurable: true,
        get: () => new Uint8Array([9]) });
    } catch (error) {
      redefineError = error;
    } finally {
      if (!Object.isFrozen(propertyOwner) && originalDescriptor !== undefined) {
        Object.defineProperty(propertyOwner, "canonicalBytes", originalDescriptor);
      }
    }
    expect(Object.isFrozen(propertyOwner)).toBe(true);
    expect(redefineError).toBeInstanceOf(TypeError);
    expect([...value.canonicalBytes]).toEqual([4, 5, 6]);
  });
});
