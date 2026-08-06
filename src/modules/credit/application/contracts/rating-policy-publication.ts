import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { PublishedRatingPolicyRevision } from "../../domain/rating-policy-publication.js";

export type RatingPolicyPublicationOutcome = Readonly<{
  kind: "published" | "replayed";
  publication: PublishedRatingPolicyRevision;
}>;

export interface RatingPolicyPublicationRepository {
  publish(
    transaction: PlatformTransaction,
    candidate: PublishedRatingPolicyRevision,
  ): Promise<RatingPolicyPublicationOutcome>;
}
