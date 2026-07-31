import { describe, expect, it } from "vitest";
import { projectImageEffectEvidence, selectImageEffectEvidencePage } from
  "../../src/modules/model-gateway/domain/image-effect-evidence.js";
import { imageEffectUsageFactDigest, type ImageEffectProviderObservation } from
  "../../src/modules/model-gateway/domain/image-effect.js";

const USAGE_FACT = Object.freeze({ evidenceKind: "measured" as const,
  dimensions: Object.freeze([Object.freeze({ dimensionKey: "image", sourceUnit: "output", quantity: 1n })]),
  attemptOutcome: "succeeded" as const, occurredAt: "2026-07-31T12:01:00.000Z",
  sourceDigest: "9".repeat(64) });
const SUCCEEDED = Object.freeze({
  kind: "succeeded",
  eventRef: "provider-event:terminal",
  sequence: 2n,
  observationDigest: "a".repeat(64),
  observedAt: "2026-07-31T12:01:00.000Z",
  outcomeEvidenceRef: "provider-outcome:one",
  outcomeEvidenceDigest: "b".repeat(64),
  usageEvidenceRef: "provider-usage:one",
  usageEvidenceDigest: imageEffectUsageFactDigest(USAGE_FACT),
  usageFact: USAGE_FACT,
  outputs: [Object.freeze({
    candidateRef: "candidate:one",
    stableOutputSlotRef: "slot:one",
    providerOutputFactRef: "provider-output:one",
    retrievalGrantHandle: "r".repeat(32),
    mediaType: "image/png",
    width: 1024,
    height: 1024,
    declaredByteSize: 4096n,
  })],
}) satisfies ImageEffectProviderObservation;

describe("image-effect evidence owner", () => {
  it("projects terminal outcome, usage and output facts in one monotonic owner sequence", () => {
    const projected = projectImageEffectEvidence({
      logicalInvocationRef: "invocation:one",
      attemptRef: "attempt:one",
      ownerVersion: 7n,
      lastEvidenceSequence: 4n,
      observation: SUCCEEDED,
      outputIdentity: (output) => Object.freeze({
        outputEvidenceRef: `image-output:${output.candidateRef}`,
        outputEvidenceDigest: "d".repeat(64),
      }),
    });

    expect(projected).toEqual([
      expect.objectContaining({ evidenceSequence: 5n, ownerVersion: 7n, kind: "outcome",
        evidenceRef: "provider-outcome:one", evidenceDigest: "b".repeat(64) }),
      expect.objectContaining({ evidenceSequence: 6n, ownerVersion: 7n, kind: "usage",
        evidenceRef: "provider-usage:one", evidenceDigest: imageEffectUsageFactDigest(USAGE_FACT) }),
      expect.objectContaining({ evidenceSequence: 7n, ownerVersion: 7n, kind: "output",
        evidenceRef: "image-output:candidate:one", evidenceDigest: "d".repeat(64),
        output: expect.objectContaining({ candidateOrdinal: 1, mediaType: "image/png",
          width: 1024, height: 1024, declaredByteSize: 4096n }) }),
    ]);
  });

  it("uses an exact owner cursor and never skips a concurrent ledger append", () => {
    const facts = projectImageEffectEvidence({
      logicalInvocationRef: "invocation:one", attemptRef: "attempt:one", ownerVersion: 7n,
      lastEvidenceSequence: 0n, observation: SUCCEEDED,
      outputIdentity: () => ({ outputEvidenceRef: "image-output:one", outputEvidenceDigest: "d".repeat(64) }),
    });
    expect(selectImageEffectEvidencePage({ facts, afterEvidenceSequence: 0n, limit: 2,
      ownerHighWatermark: 3n })).toEqual({ facts: facts.slice(0, 2), nextEvidenceSequence: 2n, caughtUp: false });
    expect(selectImageEffectEvidencePage({ facts, afterEvidenceSequence: 2n, limit: 2,
      ownerHighWatermark: 3n })).toEqual({ facts: facts.slice(2), nextEvidenceSequence: 3n, caughtUp: true });
    expect(() => selectImageEffectEvidencePage({ facts, afterEvidenceSequence: 4n, limit: 2,
      ownerHighWatermark: 3n })).toThrow("IMAGE_EFFECT_EVIDENCE_CURSOR_INVALID");
  });
});
