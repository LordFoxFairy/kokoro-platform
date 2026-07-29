import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/index.js";
import type {
  SiteAuthorityJournal,
  SiteAuthorityRepository,
  SiteAuthorityReceipt,
} from "../contracts/site-authority-ports.js";
import type {
  SitePublicationRepository,
  SiteReleaseCertificationAuthority,
} from "../contracts/site-publication-ports.js";
import {
  createPreviewReadySite,
  createSiteProjectBinding,
  publishCertifiedSiteRelease,
  type PublishedSiteRelease,
} from "../../domain/site-publication.js";
import { createSiteAuthorityCommand } from "../site-command.js";

type Repository = SiteAuthorityRepository & SitePublicationRepository;
type CommandInput = Readonly<{ commandId: string; idempotencyKey: string }>;

export class SitePublicationService {
  readonly #now: () => string;

  constructor(
    private readonly unitOfWork: PlatformUnitOfWork,
    private readonly repository: Repository,
    private readonly journal: SiteAuthorityJournal,
    private readonly certification: SiteReleaseCertificationAuthority,
    options: Readonly<{ now?: () => string }> = {},
  ) {
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  registerSite(
    input: CommandInput & Readonly<{
      siteRef: string;
      siteKey: string;
      bindingRef: string;
      repositoryRef: string;
      providerNamespace: string;
      providerProjectRef: string;
      environment: "development" | "preview" | "production";
      workloadIdentityId: string;
    }>,
    context: VerifiedRequestSecurityContext,
  ): Promise<SiteAuthorityReceipt> {
    admin(context, input.siteRef);
    const site = createPreviewReadySite(input);
    const binding = createSiteProjectBinding({ ...input, region: context.region });
    const command = createSiteAuthorityCommand("site.register", input.siteRef, input, context, {
      siteKey: input.siteKey,
      bindingRef: input.bindingRef,
      repositoryRef: input.repositoryRef,
      providerNamespace: input.providerNamespace,
      providerProjectRef: input.providerProjectRef,
      region: context.region,
      environment: input.environment,
      workloadIdentityId: input.workloadIdentityId,
    });
    return this.unitOfWork.execute({ context, operation: command.operation }, async (transaction) => {
      const disposition = await this.journal.begin(transaction, command);
      const existing = await this.repository.loadSiteForUpdate(transaction, input.siteRef);
      if (disposition === "replay") {
        if (existing === null) throw new Error("SITE_REGISTRATION_REPLAY_INCOMPLETE");
        return Object.freeze({ siteRef: existing.siteRef, state: existing.state, replayed: true });
      }
      if (existing !== null) throw new Error("SITE_REF_CONFLICT");
      await this.repository.insertSiteWithProjectBinding(transaction, site, binding);
      const receipt = Object.freeze({ siteRef: site.siteRef, state: site.state, replayed: false });
      await this.journal.succeed(transaction, command, receipt, context);
      return receipt;
    });
  }

  async publishRelease(
    input: CommandInput & Omit<PublishedSiteRelease, "state">,
    context: VerifiedRequestSecurityContext,
  ): Promise<SiteAuthorityReceipt> {
    admin(context, input.siteRef);
    const release = publishCertifiedSiteRelease(input);
    const certification = await this.certification.verify({
      siteRef: release.siteRef,
      releaseRef: release.releaseRef,
      webArtifactDigest: release.webArtifactDigest,
      releaseManifestDigest: release.releaseManifestDigest,
      certificationDigest: release.certificationDigest,
      launchProfileRef: release.launchProfileRef,
    });
    const now = this.#now();
    if (!Number.isFinite(Date.parse(certification.expiresAt)) ||
        Date.parse(certification.expiresAt) <= Date.parse(now)) {
      throw new Error("SITE_RELEASE_CERTIFICATION_EXPIRED");
    }
    const command = createSiteAuthorityCommand("site.release.publish", input.siteRef, input, context, {
      releaseRef: release.releaseRef,
      webArtifactDigest: release.webArtifactDigest,
      releaseManifestDigest: release.releaseManifestDigest,
      certificationDigest: release.certificationDigest,
      launchProfileRef: release.launchProfileRef,
      siteConfigRevisionRef: release.siteConfigRevisionRef,
      legalRevisionRef: release.legalRevisionRef,
      featurePolicyRevision: release.featurePolicyRevision,
      modelOptionCatalogRef: release.modelOptionCatalogRef,
      agentCatalogRef: release.agentCatalogRef,
      identityIssuerLabel: release.identityIssuerLabel,
      identityAuthStrengthPolicyRevision: release.identityAuthStrengthPolicyRevision,
      enabledSurfaceIds: release.enabledSurfaceIds,
      localePolicy: release.localePolicy,
    });
    return this.unitOfWork.execute({ context, operation: command.operation }, async (transaction) => {
      const disposition = await this.journal.begin(transaction, command);
      const site = await this.repository.loadSiteForUpdate(transaction, release.siteRef);
      if (site === null || site.state === "decommissioning" || site.state === "decommissioned") {
        throw new Error("SITE_RELEASE_OWNER_UNAVAILABLE");
      }
      const existing = await this.repository.loadReleaseForUpdate(
        transaction,
        release.siteRef,
        release.releaseRef,
      );
      if (disposition === "replay") {
        if (existing === null || existing.webArtifactDigest !== release.webArtifactDigest ||
            existing.releaseManifestDigest !== release.releaseManifestDigest ||
            existing.certificationDigest !== release.certificationDigest) {
          throw new Error("SITE_RELEASE_REPLAY_CONFLICT");
        }
        return Object.freeze({ siteRef: release.siteRef, state: existing.state, replayed: true });
      }
      if (existing !== null) throw new Error("SITE_RELEASE_REF_CONFLICT");
      await this.repository.insertRelease(transaction, release);
      const receipt = Object.freeze({ siteRef: release.siteRef, state: release.state, replayed: false });
      await this.journal.succeed(transaction, command, receipt, context);
      return receipt;
    });
  }
}

function admin(context: VerifiedRequestSecurityContext, siteRef: string): void {
  if (context.trustedCaller.kind !== "admin_workload" || context.actor.kind !== "operator") {
    throw new Error("SITE_ADMIN_OPERATOR_REQUIRED");
  }
  if (context.target.siteId !== siteRef) throw new Error("SITE_ADMIN_SCOPE_MISMATCH");
}
