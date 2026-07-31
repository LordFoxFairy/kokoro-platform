import { describe, expect, it } from "vitest";
import {
  applyImageEffectObservation,
  createImageEffectAttempt,
  requestImageEffectCancellation,
  type ImageEffectProviderObservation,
} from "../../src/modules/model-gateway/domain/image-effect.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

describe("model image effect domain", () => {
  it("keeps cancellation as intent and accepts a late success after an unknown outcome", () => {
    const attempt = createImageEffectAttempt({
      attemptRef: "image-attempt:one",
      ordinal: 1,
      budgetCommitRef: "effect-budget:one",
      budgetCommitDigest: DIGEST_A,
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
      usageEvidenceDigest: DIGEST_B,
      outputs: [{ candidateRef: "candidate:one", stableOutputSlotRef: "slot:one",
        providerOutputFactRef: "provider-output:one", retrievalGrantHandle: "r".repeat(32) }],
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
