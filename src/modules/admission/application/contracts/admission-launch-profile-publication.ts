import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { PublishedAdmissionLaunchProfile } from
  "../../domain/admission-launch-profile-publication.js";

export type AdmissionLaunchProfilePublicationOutcome = Readonly<{
  kind: "published" | "replayed";
  publication: PublishedAdmissionLaunchProfile;
}>;

export interface AdmissionLaunchProfilePublicationRepository {
  publish(
    transaction: PlatformTransaction,
    candidate: PublishedAdmissionLaunchProfile,
  ): Promise<AdmissionLaunchProfilePublicationOutcome>;
}
