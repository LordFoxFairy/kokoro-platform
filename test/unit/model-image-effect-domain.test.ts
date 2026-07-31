import { describe, expect, it } from "vitest";
import {
  applyImageEffectObservation,
  createImageEffectAttempt,
  imageEffectUsageFactDigest,
  requestImageEffectCancellation,
  type ImageEffectProviderObservation,
} from "../../src/modules/model-gateway/domain/image-effect.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const ATTEMPT_AUTHORIZATION = Object.freeze({
  attemptAuthorizationRef: "00000000-0000-7000-8000-000000000111",
  attemptAuthorizationFenceEpoch: 1n,
  attemptAuthorizationDigest: "7".repeat(64),
});

describe("model image effect domain", () => {
  it("keeps cancellation as intent and accepts a late success after an unknown outcome", () => {
    const attempt = createImageEffectAttempt({
      attemptRef: "image-attempt:one",
      ordinal: 1,
      budgetCommitRef: "effect-budget:one",
      budgetCommitDigest: DIGEST_A,
      ...ATTEMPT_AUTHORIZATION,
      providerOperationKey: "image-provider-operation:one",
    });
    const submitted = applyImageEffectObservation(attempt, observation({
      eventRef: "provider-event:submitted",
      sequence: 1n,
      kind: "submitted",
      providerOperationRef: "provider-operation:one",
    }));
    const cancelRequested = requestImageEffectCancellation(submitted.attempt);
    expect(cancelRequested.cancelRequested).toBe(true);
    expect(cancelRequested.state).toBe("submitted");

    const unknown = applyImageEffectObservation(cancelRequested, observation({
      eventRef: "provider-event:unknown",
      sequence: 2n,
      kind: "outcome_unknown",
      outcomeEvidenceRef: "provider-evidence:unknown",
      outcomeEvidenceDigest: DIGEST_B,
    }));
    expect(unknown.attempt.state).toBe("outcome_unknown");

    const late = applyImageEffectObservation(unknown.attempt, observation({
      eventRef: "provider-event:late-success",
      sequence: 3n,
      kind: "succeeded",
      outcomeEvidenceRef: "provider-evidence:success",
      outcomeEvidenceDigest: DIGEST_A,
      usageEvidenceRef: "usage-evidence:one",
      usageEvidenceDigest: imageEffectUsageFactDigest(measuredUsageFact()),
      usageFact: measuredUsageFact(),
      outputs: [{ candidateRef: "candidate:one", stableOutputSlotRef: "slot:one",
        providerOutputFactRef: "provider-output:one", retrievalGrantHandle: "r".repeat(32),
        mediaType: "image/png", width: 1024, height: 1024, declaredByteSize: 4096n }],
    }));
    expect(late.attempt.state).toBe("succeeded");
    expect(late.attempt.lateOutcome).toBe(true);
  });

  it("replays an exact duplicate callback and rejects a changed digest or out-of-order event", () => {
    const attempt = createImageEffectAttempt({
      attemptRef: "image-attempt:one",
      ordinal: 1,
      budgetCommitRef: "effect-budget:one",
      budgetCommitDigest: DIGEST_A,
      ...ATTEMPT_AUTHORIZATION,
      providerOperationKey: "image-provider-operation:one",
    });
    const submittedEvent = observation({
      eventRef: "provider-event:submitted",
      sequence: 1n,
      kind: "submitted",
      providerOperationRef: "provider-operation:one",
    });
    const first = applyImageEffectObservation(attempt, submittedEvent);
    expect(first.replayed).toBe(false);
    expect(applyImageEffectObservation(first.attempt, submittedEvent)).toEqual({
      attempt: first.attempt,
      replayed: true,
    });
    expect(() => applyImageEffectObservation(first.attempt, {
      ...submittedEvent,
      observationDigest: DIGEST_B,
    })).toThrow("IMAGE_EFFECT_PROVIDER_EVENT_DIGEST_CONFLICT");
    expect(() => applyImageEffectObservation(first.attempt, observation({
      eventRef: "provider-event:stale",
      sequence: 1n,
      kind: "running",
    }))).toThrow("IMAGE_EFFECT_PROVIDER_EVENT_SEQUENCE_CONFLICT");
  });

  it("allows another attempt only after exact definitely-not-submitted evidence", () => {
    const attempt = createImageEffectAttempt({
      attemptRef: "image-attempt:one",
      ordinal: 1,
      budgetCommitRef: "effect-budget:one",
      budgetCommitDigest: DIGEST_A,
      ...ATTEMPT_AUTHORIZATION,
      providerOperationKey: "image-provider-operation:one",
    });
    const safe = applyImageEffectObservation(attempt, observation({
      eventRef: "provider-event:not-submitted",
      sequence: 1n,
      kind: "definitely_not_submitted",
      definitelyNotSubmittedReceiptRef: "not-submitted-receipt:one",
      definitelyNotSubmittedReceiptDigest: DIGEST_B,
    })).attempt;
    expect(safe.state).toBe("definitely_not_submitted");
    expect(safe.definitelyNotSubmittedReceiptDigest).toBe(DIGEST_B);
  });

  it("rejects a provider usage digest that does not bind the canonical typed fact", () => {
    const planned = createImageEffectAttempt({ attemptRef: "image-attempt:one", ordinal: 1,
      budgetCommitRef: "effect-budget:one", budgetCommitDigest: DIGEST_A,
      ...ATTEMPT_AUTHORIZATION,
      providerOperationKey: "image-provider-operation:one" });
    const submitted = applyImageEffectObservation(planned, observation({ eventRef: "provider-event:submitted",
      sequence: 1n, kind: "submitted", providerOperationRef: "provider-operation:one" })).attempt;
    expect(() => applyImageEffectObservation(submitted, observation({ kind: "succeeded",
      eventRef: "provider-event:tampered", sequence: 2n, outcomeEvidenceRef: "outcome:one",
      outcomeEvidenceDigest: DIGEST_A, usageEvidenceRef: "usage:one", usageEvidenceDigest: DIGEST_B,
      usageFact: measuredUsageFact(), outputs: [{ candidateRef: "candidate:one", stableOutputSlotRef: "slot:one",
        providerOutputFactRef: "provider-output:one", retrievalGrantHandle: "r".repeat(32),
        mediaType: "image/png", width: 1, height: 1 }] })))
      .toThrow("IMAGE_EFFECT_USAGE_EVIDENCE_DIGEST_MISMATCH");
  });

  it("canonicalizes usage dimensions by code units and rejects keys Credit cannot rate", () => {
    const base = measuredUsageFact();
    const first = Object.freeze({ ...base, dimensions: Object.freeze([
      Object.freeze({ dimensionKey: "z.output", sourceUnit: "unit", quantity: 2n }),
      Object.freeze({ dimensionKey: "A.input", sourceUnit: "unit", quantity: 1n }),
    ]) });
    const second = Object.freeze({ ...first, dimensions: Object.freeze([...first.dimensions].reverse()) });
    expect(imageEffectUsageFactDigest(first)).toBe(imageEffectUsageFactDigest(second));

    const planned = createImageEffectAttempt({ attemptRef: "attempt:grammar", ordinal: 1,
      budgetCommitRef: "budget:one", budgetCommitDigest: DIGEST_A, ...ATTEMPT_AUTHORIZATION,
      providerOperationKey: "provider:one" });
    const submitted = applyImageEffectObservation(planned, observation({ kind: "submitted", sequence: 1n,
      eventRef: "event:submitted", providerOperationRef: "provider:one" })).attempt;
    const invalid = Object.freeze({ ...base, dimensions: Object.freeze([
      Object.freeze({ dimensionKey: "image 输出", sourceUnit: "output", quantity: 1n }),
    ]) });
    expect(() => applyImageEffectObservation(submitted, observation({ kind: "succeeded", sequence: 2n,
      eventRef: "event:invalid-usage", outcomeEvidenceRef: "outcome:one", outcomeEvidenceDigest: DIGEST_A,
      usageEvidenceRef: "usage:one", usageEvidenceDigest: imageEffectUsageFactDigest(invalid),
      usageFact: invalid, outputs: [{ candidateRef: "candidate:one", stableOutputSlotRef: "slot:one",
        providerOutputFactRef: "output:one", retrievalGrantHandle: "r".repeat(32),
        mediaType: "image/png", width: 1, height: 1 }] })))
      .toThrow("IMAGE_EFFECT_USAGE_FACT_INVALID");
  });
});

type ObservationInput<Value> = Value extends ImageEffectProviderObservation
  ? Omit<Value, "observationDigest" | "observedAt">
  : never;

function observation(
  input: ObservationInput<ImageEffectProviderObservation>,
): ImageEffectProviderObservation {
  const base = { observationDigest: DIGEST_A, observedAt: "2026-07-31T12:00:00.000Z" } as const;
  switch (input.kind) {
    case "definitely_not_submitted": return Object.freeze({ ...input, ...base });
    case "submitted": return Object.freeze({ ...input, ...base });
    case "submission_unknown": return Object.freeze({ ...input, ...base });
    case "running": return Object.freeze({ ...input, ...base });
    case "succeeded": return Object.freeze({ ...input, ...base });
    case "failed": return Object.freeze({ ...input, ...base });
    case "canceled": return Object.freeze({ ...input, ...base });
    case "outcome_unknown": return Object.freeze({ ...input, ...base });
  }
}

function measuredUsageFact() {
  return Object.freeze({ evidenceKind: "measured" as const,
    dimensions: Object.freeze([Object.freeze({ dimensionKey: "image", sourceUnit: "output", quantity: 1n })]),
    attemptOutcome: "succeeded" as const, occurredAt: "2026-07-31T12:01:00.000Z",
    sourceDigest: "9".repeat(64) });
}
