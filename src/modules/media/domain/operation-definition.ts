import {
  operationDefinitionRevisionRef,
  type OperationDefinitionRevisionRef,
} from "./references.js";
import { snapshotDenseArray, snapshotExactDataRecord } from "./runtime-validation.js";
import { hasControlCharacter, isWellFormedUtf16 } from "./text-validation.js";

declare const compiledOperationDefinitionRevisionBrand: unique symbol;

export const MAXIMUM_MEDIA_DEFINITION_STEPS = 32;
export const MAXIMUM_MEDIA_CANDIDATE_SLOTS_PER_STEP = 16;
export const MAXIMUM_MEDIA_DEFINITION_CANDIDATES = 64;

export type DefinitionCandidateSlot = Readonly<{
  outputSlot: string;
  required: boolean;
}>;

export type DefinitionStep = Readonly<{
  definitionStepKey: string;
  required: boolean;
  candidateSlots: readonly DefinitionCandidateSlot[];
}>;

export type OperationDefinitionRevisionInput = Readonly<{
  definitionRevisionRef: OperationDefinitionRevisionRef;
  partialCompletion: "allowed" | "forbidden";
  minimumReadyCandidates: number;
  steps: readonly DefinitionStep[];
}>;

export type CompiledOperationDefinitionRevision = OperationDefinitionRevisionInput & Readonly<{
  [compiledOperationDefinitionRevisionBrand]: true;
}>;

export function compiledOperationDefinitionRevision(
  input: OperationDefinitionRevisionInput,
): CompiledOperationDefinitionRevision {
  return rehydrateCompiledOperationDefinitionRevision(input);
}

export function rehydrateCompiledOperationDefinitionRevision(
  input: unknown,
): CompiledOperationDefinitionRevision {
  const definition = snapshotExactDataRecord(input, ["definitionRevisionRef", "partialCompletion",
    "minimumReadyCandidates", "steps"], "MEDIA_DEFINITION_INPUT_INVALID");
  if (typeof definition.definitionRevisionRef !== "string") {
    throw new Error("MEDIA_DEFINITION_REVISION_REF_INVALID");
  }
  const definitionRevisionRef = operationDefinitionRevisionRef(definition.definitionRevisionRef);
  if (definition.partialCompletion !== "allowed" && definition.partialCompletion !== "forbidden") {
    throw new Error("MEDIA_DEFINITION_PARTIAL_COMPLETION_INVALID");
  }
  const rawSteps = snapshotDenseArray(definition.steps, MAXIMUM_MEDIA_DEFINITION_STEPS,
    "MEDIA_DEFINITION_STEPS_INVALID", "MEDIA_DEFINITION_STEP_COUNT_EXCEEDED");
  if (rawSteps.length < 1) throw new Error("MEDIA_DEFINITION_STEPS_INVALID");
  const stepKeys = new Set<string>();
  const outputSlots = new Set<string>();
  const steps = rawSteps.map((rawStep) => {
    const step = snapshotExactDataRecord(rawStep, ["definitionStepKey", "required", "candidateSlots"],
      "MEDIA_DEFINITION_STEP_INVALID");
    const definitionStepKey = validateDefinitionKey(step.definitionStepKey,
      "MEDIA_DEFINITION_STEP_KEY_INVALID");
    if (typeof step.required !== "boolean") throw new Error("MEDIA_DEFINITION_STEP_REQUIRED_INVALID");
    const rawCandidateSlots = snapshotDenseArray(step.candidateSlots,
      MAXIMUM_MEDIA_CANDIDATE_SLOTS_PER_STEP, "MEDIA_DEFINITION_CANDIDATES_INVALID",
      "MEDIA_DEFINITION_STEP_CANDIDATE_COUNT_EXCEEDED");
    if (stepKeys.has(definitionStepKey)) throw new Error("MEDIA_DEFINITION_STEP_DUPLICATE");
    stepKeys.add(definitionStepKey);
    const candidateSlots = rawCandidateSlots.map((rawCandidate) => {
      const candidate = snapshotExactDataRecord(rawCandidate, ["outputSlot", "required"],
        "MEDIA_DEFINITION_OUTPUT_SLOT_INVALID");
      const outputSlot = validateDefinitionKey(candidate.outputSlot, "MEDIA_DEFINITION_OUTPUT_SLOT_INVALID");
      if (typeof candidate.required !== "boolean") {
        throw new Error("MEDIA_DEFINITION_OUTPUT_SLOT_REQUIRED_INVALID");
      }
      if (outputSlots.has(outputSlot)) throw new Error("MEDIA_DEFINITION_OUTPUT_SLOT_DUPLICATE");
      outputSlots.add(outputSlot);
      if (outputSlots.size > MAXIMUM_MEDIA_DEFINITION_CANDIDATES) {
        throw new Error("MEDIA_DEFINITION_CANDIDATE_COUNT_EXCEEDED");
      }
      return Object.freeze({ outputSlot, required: candidate.required });
    });
    return Object.freeze({ definitionStepKey, required: step.required,
      candidateSlots: Object.freeze(candidateSlots) });
  });
  if (typeof definition.minimumReadyCandidates !== "number" ||
      !Number.isInteger(definition.minimumReadyCandidates) || definition.minimumReadyCandidates < 1 ||
      definition.minimumReadyCandidates > outputSlots.size) {
    throw new Error("MEDIA_DEFINITION_READY_CANDIDATE_MINIMUM_INVALID");
  }
  return Object.freeze({
    definitionRevisionRef,
    partialCompletion: definition.partialCompletion,
    minimumReadyCandidates: definition.minimumReadyCandidates,
    steps: Object.freeze(steps),
  }) as CompiledOperationDefinitionRevision;
}

export function validateDefinitionKey(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 ||
      !isWellFormedUtf16(value) || hasControlCharacter(value)) {
    throw new Error(code);
  }
  return value;
}
