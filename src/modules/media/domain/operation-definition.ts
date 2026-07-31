import type { OperationDefinitionRevisionRef } from "./references.js";
import { hasControlCharacter } from "./text-validation.js";

declare const canonicalMediaRequestBytesBrand: unique symbol;
declare const callerRequestFingerprintBrand: unique symbol;
declare const compiledOperationDefinitionRevisionBrand: unique symbol;

export type CanonicalMediaRequestBytes = Readonly<Uint8Array> & Readonly<{
  [canonicalMediaRequestBytesBrand]: true;
}>;
export type CallerRequestFingerprint = string & Readonly<{
  [callerRequestFingerprintBrand]: true;
}>;

export interface MediaDefinitionCanonicalizer<Request> {
  canonicalize(input: Readonly<{
    definitionRevisionRef: OperationDefinitionRevisionRef;
    request: Request;
  }>): Readonly<{
    canonicalBytes: CanonicalMediaRequestBytes;
    callerRequestFingerprint: CallerRequestFingerprint;
  }>;
}

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
  if (input.partialCompletion !== "allowed" && input.partialCompletion !== "forbidden") {
    throw new Error("MEDIA_DEFINITION_PARTIAL_COMPLETION_INVALID");
  }
  if (input.steps.length < 1) throw new Error("MEDIA_DEFINITION_STEPS_INVALID");
  const stepKeys = new Set<string>();
  const outputSlots = new Set<string>();
  const steps = input.steps.map((step) => {
    definitionKey(step.definitionStepKey, "MEDIA_DEFINITION_STEP_KEY_INVALID");
    if (stepKeys.has(step.definitionStepKey)) throw new Error("MEDIA_DEFINITION_STEP_DUPLICATE");
    stepKeys.add(step.definitionStepKey);
    const candidateSlots = step.candidateSlots.map((candidate) => {
      definitionKey(candidate.outputSlot, "MEDIA_DEFINITION_OUTPUT_SLOT_INVALID");
      if (outputSlots.has(candidate.outputSlot)) throw new Error("MEDIA_DEFINITION_OUTPUT_SLOT_DUPLICATE");
      outputSlots.add(candidate.outputSlot);
      return Object.freeze({ ...candidate });
    });
    return Object.freeze({ ...step, candidateSlots: Object.freeze(candidateSlots) });
  });
  if (!Number.isInteger(input.minimumReadyCandidates) || input.minimumReadyCandidates < 1 ||
      input.minimumReadyCandidates > outputSlots.size) {
    throw new Error("MEDIA_DEFINITION_READY_CANDIDATE_MINIMUM_INVALID");
  }
  return Object.freeze({ ...input, steps: Object.freeze(steps) }) as CompiledOperationDefinitionRevision;
}

function definitionKey(value: string, code: string): void {
  if (value.length < 1 || value.length > 128 || hasControlCharacter(value)) {
    throw new Error(code);
  }
}
