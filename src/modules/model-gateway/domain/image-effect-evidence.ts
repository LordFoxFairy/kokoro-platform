import { createHash } from "node:crypto";
import type { ImageEffectProviderObservation, ImageEffectProviderOutput } from "./image-effect.js";

export type ImageEffectEvidenceKind = "outcome" | "usage" | "output";

export type ImageEffectEvidenceFact = Readonly<{
  logicalInvocationRef: string;
  attemptRef: string;
  evidenceSequence: bigint;
  ownerVersion: bigint;
  kind: ImageEffectEvidenceKind;
  evidenceRef: string;
  evidenceDigest: string;
  recordedAt: string;
  output?: Readonly<{
    candidateOrdinal: number;
    candidateRef: string;
    stableOutputSlotRef: string;
    outputEvidenceRef: string;
    outputEvidenceDigest: string;
    providerOutputFactRef: string;
    retrievalGrantHandleDigest: string;
    mediaType: ImageEffectProviderOutput["mediaType"];
    width: number;
    height: number;
    declaredByteSize?: bigint;
  }>;
}>;

export interface ImageEffectOutputEvidenceIdentityAuthority {
  (output: ImageEffectProviderOutput, context: Readonly<{
    logicalInvocationRef: string;
    attemptRef: string;
    candidateOrdinal: number;
  }>): Readonly<{ outputEvidenceRef: string; outputEvidenceDigest: string }>;
}

export function projectImageEffectEvidence(input: Readonly<{
  logicalInvocationRef: string;
  attemptRef: string;
  ownerVersion: bigint;
  lastEvidenceSequence: bigint;
  observation: ImageEffectProviderObservation;
  outputIdentity: ImageEffectOutputEvidenceIdentityAuthority;
}>): readonly ImageEffectEvidenceFact[] {
  reference(input.logicalInvocationRef);
  reference(input.attemptRef);
  if (input.ownerVersion < 1n || input.lastEvidenceSequence < 0n) {
    throw new Error("IMAGE_EFFECT_EVIDENCE_OWNER_REVISION_INVALID");
  }
  if (!["succeeded", "failed", "canceled", "outcome_unknown"].includes(input.observation.kind)) {
    return Object.freeze([]);
  }
  const terminal = input.observation as Extract<ImageEffectProviderObservation, {
    kind: "succeeded" | "failed" | "canceled" | "outcome_unknown";
  }>;
  const facts: ImageEffectEvidenceFact[] = [];
  const append = (fact: Omit<ImageEffectEvidenceFact, "logicalInvocationRef" | "attemptRef" |
    "evidenceSequence" | "ownerVersion" | "recordedAt">): void => {
    reference(fact.evidenceRef);
    digest(fact.evidenceDigest);
    facts.push(Object.freeze({
      logicalInvocationRef: input.logicalInvocationRef,
      attemptRef: input.attemptRef,
      evidenceSequence: input.lastEvidenceSequence + BigInt(facts.length + 1),
      ownerVersion: input.ownerVersion,
      recordedAt: terminal.observedAt,
      ...fact,
    }));
  };
  append({ kind: "outcome", evidenceRef: terminal.outcomeEvidenceRef,
    evidenceDigest: terminal.outcomeEvidenceDigest });
  if (terminal.usageEvidenceRef !== undefined && terminal.usageEvidenceDigest !== undefined) {
    append({ kind: "usage", evidenceRef: terminal.usageEvidenceRef,
      evidenceDigest: terminal.usageEvidenceDigest });
  }
  if (terminal.kind === "succeeded") terminal.outputs.forEach((output, index) => {
    const candidateOrdinal = index + 1;
    const identity = input.outputIdentity(output, {
      logicalInvocationRef: input.logicalInvocationRef,
      attemptRef: input.attemptRef,
      candidateOrdinal,
    });
    reference(identity.outputEvidenceRef);
    digest(identity.outputEvidenceDigest);
    append({
      kind: "output",
      evidenceRef: identity.outputEvidenceRef,
      evidenceDigest: identity.outputEvidenceDigest,
      output: Object.freeze({
        candidateOrdinal,
        candidateRef: output.candidateRef,
        stableOutputSlotRef: output.stableOutputSlotRef,
        outputEvidenceRef: identity.outputEvidenceRef,
        outputEvidenceDigest: identity.outputEvidenceDigest,
        providerOutputFactRef: output.providerOutputFactRef,
        retrievalGrantHandleDigest: createHash("sha256").update(output.retrievalGrantHandle, "utf8").digest("hex"),
        mediaType: output.mediaType,
        width: output.width,
        height: output.height,
        ...(output.declaredByteSize === undefined ? {} : { declaredByteSize: output.declaredByteSize }),
      }),
    });
  });
  return Object.freeze(facts);
}

export function selectImageEffectEvidencePage(input: Readonly<{
  facts: readonly ImageEffectEvidenceFact[];
  afterEvidenceSequence: bigint;
  limit: number;
  ownerHighWatermark: bigint;
}>): Readonly<{
  facts: readonly ImageEffectEvidenceFact[];
  nextEvidenceSequence: bigint;
  caughtUp: boolean;
}> {
  if (input.afterEvidenceSequence < 0n || input.ownerHighWatermark < 0n ||
      input.afterEvidenceSequence > input.ownerHighWatermark ||
      !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 64) {
    throw new Error("IMAGE_EFFECT_EVIDENCE_CURSOR_INVALID");
  }
  const eligible = input.facts.filter((fact) => fact.evidenceSequence > input.afterEvidenceSequence);
  for (let index = 1; index < eligible.length; index += 1) {
    if (eligible[index]!.evidenceSequence <= eligible[index - 1]!.evidenceSequence) {
      throw new Error("IMAGE_EFFECT_EVIDENCE_LEDGER_CORRUPT");
    }
  }
  const facts = Object.freeze(eligible.slice(0, input.limit));
  const nextEvidenceSequence = facts.at(-1)?.evidenceSequence ?? input.afterEvidenceSequence;
  return Object.freeze({ facts, nextEvidenceSequence,
    caughtUp: nextEvidenceSequence === input.ownerHighWatermark });
}

function reference(value: string): void {
  if (value.length < 1 || value.length > 256 || /[\0\r\n]/u.test(value)) {
    throw new Error("IMAGE_EFFECT_EVIDENCE_REFERENCE_INVALID");
  }
}

function digest(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error("IMAGE_EFFECT_EVIDENCE_DIGEST_INVALID");
}
