import { describe, expect, it } from "vitest";
import {
  GATEWAY_EFFECT_FAILURE_CAUSES,
  GATEWAY_IRRECONCILABLE_REASONS,
  MEDIA_CANCELLATION_CAUSES,
  MEDIA_CANDIDATE_POST_OUTPUT_FAILURE_CAUSES,
  MEDIA_CANDIDATE_PRE_OUTPUT_FAILURE_CAUSES,
  MEDIA_CANDIDATE_UNKNOWN_REASONS,
  MEDIA_OPERATION_RECONCILIATION_REASONS,
  MEDIA_STEP_FAILURE_CAUSES,
  MEDIA_STEP_RECONCILIATION_REASONS,
  isMediaCandidateFailureCause,
} from "../../src/modules/media/domain/media-vocabulary.js";

describe("Media runtime vocabulary", () => {
  it("keeps every type-source tuple immutable at runtime", () => {
    const vocabularies: readonly (readonly string[])[] = [
      GATEWAY_EFFECT_FAILURE_CAUSES,
      GATEWAY_IRRECONCILABLE_REASONS,
      MEDIA_CANCELLATION_CAUSES,
      MEDIA_CANDIDATE_POST_OUTPUT_FAILURE_CAUSES,
      MEDIA_CANDIDATE_PRE_OUTPUT_FAILURE_CAUSES,
      MEDIA_CANDIDATE_UNKNOWN_REASONS,
      MEDIA_OPERATION_RECONCILIATION_REASONS,
      MEDIA_STEP_FAILURE_CAUSES,
      MEDIA_STEP_RECONCILIATION_REASONS,
    ];
    for (const vocabulary of vocabularies) expect(Object.isFrozen(vocabulary)).toBe(true);

    expect(() => (MEDIA_CANDIDATE_POST_OUTPUT_FAILURE_CAUSES as unknown as string[])
      .push("invented_failure")).toThrow(TypeError);
    expect(isMediaCandidateFailureCause("provider_output_invalid")).toBe(true);
    expect(isMediaCandidateFailureCause("invented_failure")).toBe(false);
  });
});
