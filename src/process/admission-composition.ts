import {
  GaRunRequestDraftFactory,
  type GaRunRequestDraftSealer,
} from "../modules/admission/application/ga-run-request-draft-factory.js";

export interface AdmissionApplicationComposition {
  readonly gaRunRequestDraftFactory: GaRunRequestDraftFactory;
}

/**
 * Required Admission application dependency. Production startup must provide a
 * real audience-bound sealer; there is no plaintext or development fallback.
 */
export function createAdmissionApplicationComposition(
  input: Readonly<{
    gaRunRequestDraftSealer: GaRunRequestDraftSealer;
    gaDispatchAudience: string;
  }>,
): AdmissionApplicationComposition {
  if (input.gaRunRequestDraftSealer === undefined || input.gaRunRequestDraftSealer === null) {
    throw new Error("ADMISSION_GA_DRAFT_SEALER_REQUIRED");
  }
  return Object.freeze({
    gaRunRequestDraftFactory: new GaRunRequestDraftFactory({
      sealer: input.gaRunRequestDraftSealer,
      expectedAudience: input.gaDispatchAudience,
    }),
  });
}
