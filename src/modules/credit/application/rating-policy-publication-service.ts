import type { VerifiedRequestSecurityContext } from "../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../shared/unit-of-work/index.js";
import type { RatingPolicyRevision } from "../domain/usage-rating.js";
import { definePublishedRatingPolicyRevision } from "../domain/rating-policy-publication.js";
import type {
  RatingPolicyPublicationOutcome,
  RatingPolicyPublicationRepository,
} from "./contracts/rating-policy-publication.js";

const OPERATION = "credit.rating-policy.publish";

export class RatingPolicyPublicationService {
  constructor(private readonly dependencies: Readonly<{
    unitOfWork: Pick<PlatformUnitOfWork, "execute">;
    repository: RatingPolicyPublicationRepository;
    clock?: () => string;
  }>) {}

  async publish(input: Readonly<{ siteId: string; policy: RatingPolicyRevision }>,
    context: VerifiedRequestSecurityContext): Promise<RatingPolicyPublicationOutcome> {
    assertOwnerContext(context, input.siteId);
    const candidate = definePublishedRatingPolicyRevision({
      ...input,
      publishedAt: (this.dependencies.clock ?? (() => new Date().toISOString()))(),
    });
    return this.dependencies.unitOfWork.execute({ context, operation: OPERATION },
      (transaction) => this.dependencies.repository.publish(transaction, candidate));
  }
}

function assertOwnerContext(context: VerifiedRequestSecurityContext, siteId: string): void {
  if (context.trustedCaller.kind !== "admin_workload" || context.actor.kind !== "operator") {
    throw new Error("CREDIT_RATING_POLICY_ADMIN_OPERATOR_REQUIRED");
  }
  if (context.target.siteId !== siteId) {
    throw new Error("CREDIT_RATING_POLICY_SITE_SCOPE_MISMATCH");
  }
  if (context.target.purpose !== OPERATION || !context.target.scopes.includes(OPERATION)) {
    throw new Error("CREDIT_RATING_POLICY_PUBLICATION_SCOPE_REQUIRED");
  }
}
