import type { VerifiedRequestSecurityContext } from "../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../shared/unit-of-work/index.js";
import type { AdmissionLaunchProfileSnapshot } from
  "../domain/admission-launch-profile-publication.js";
import { defineAdmissionLaunchProfilePublication } from
  "../domain/admission-launch-profile-publication.js";
import type {
  AdmissionLaunchProfilePublicationOutcome,
  AdmissionLaunchProfilePublicationRepository,
} from "./contracts/admission-launch-profile-publication.js";

const OPERATION = "admission.launch-profile.publish";

export class AdmissionLaunchProfilePublicationService {
  constructor(private readonly dependencies: Readonly<{
    unitOfWork: Pick<PlatformUnitOfWork, "execute">;
    repository: AdmissionLaunchProfilePublicationRepository;
    clock?: () => string;
  }>) {}

  async publish(input: Readonly<{
    siteId: string;
    siteReleaseRef: string;
    snapshot: AdmissionLaunchProfileSnapshot;
  }>, context: VerifiedRequestSecurityContext): Promise<AdmissionLaunchProfilePublicationOutcome> {
    assertOwnerContext(context, input.siteId);
    const candidate = defineAdmissionLaunchProfilePublication({
      ...input,
      publishedAt: (this.dependencies.clock ?? (() => new Date().toISOString()))(),
    });
    return this.dependencies.unitOfWork.execute({ context, operation: OPERATION },
      (transaction) => this.dependencies.repository.publish(transaction, candidate));
  }
}

function assertOwnerContext(context: VerifiedRequestSecurityContext, siteId: string): void {
  if (context.trustedCaller.kind !== "admin_workload" || context.actor.kind !== "operator") {
    throw new Error("ADMISSION_LAUNCH_PROFILE_ADMIN_OPERATOR_REQUIRED");
  }
  if (context.target.siteId !== siteId) {
    throw new Error("ADMISSION_LAUNCH_PROFILE_SITE_SCOPE_MISMATCH");
  }
  if (context.target.purpose !== OPERATION || !context.target.scopes.includes(OPERATION)) {
    throw new Error("ADMISSION_LAUNCH_PROFILE_PUBLICATION_SCOPE_REQUIRED");
  }
}
