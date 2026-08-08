import type { PlatformTransactionalDatabaseClient } from "../infrastructure/postgres/client.js";
import type { SiteEffectiveAccessSnapshotPort } from
  "../modules/site/application/contracts/site-effective-access-snapshot.js";
import type {
  SitePublicationDocumentResolver,
  SiteWebBuildIntentIssuerAuthorityPort,
  SiteWebBuildIntentSignerPort,
} from "../modules/site/application/contracts/site-publication-authority-ports.js";
import type { SiteReleaseEvidenceTrustAuthorityPort } from
  "../modules/site/application/contracts/site-release-evidence-trust.js";
import type { SiteReleaseCertificationTrustAuthorityPort } from
  "../modules/site/application/contracts/site-release-certification-trust.js";
import { SitePublicationAuthorityService } from
  "../modules/site/application/services/site-publication-authority-service.js";
import { SiteReleaseEvidenceAuthorityService } from
  "../modules/site/application/services/site-release-evidence-authority-service.js";
import { SiteReleaseAssembler } from
  "../modules/site/application/services/site-release-assembler.js";
import { SiteReleaseEvidenceAdmission } from
  "../modules/site/application/services/site-release-evidence-admission.js";
import { SiteWebBuildIntentIssuer } from
  "../modules/site/application/services/site-web-build-intent-issuer.js";
import { ContentAddressedSitePublicationDocumentResolver } from
  "../modules/site/infrastructure/filesystem/content-addressed-site-publication-document-resolver.js";
import { PostgresSiteAuthorityJournal } from
  "../modules/site/infrastructure/postgres/site-authority-journal.js";
import { PostgresSitePublicationAuthorityRepository } from
  "../modules/site/infrastructure/postgres/site-publication-authority-repository.js";
import { PostgresSiteReleaseCandidateAssembler } from
  "../modules/site/infrastructure/postgres/site-release-candidate-assembler.js";
import { Ed25519SiteReleaseEvidenceTrust } from
  "../modules/site/infrastructure/crypto/ed25519-site-release-evidence-trust.js";
import { Ed25519SiteReleaseCertificationAdmission } from
  "../modules/site/infrastructure/crypto/ed25519-site-release-certification-admission.js";
import { PlatformUnitOfWork } from "../shared/unit-of-work/index.js";

export interface SitePublicationAuthorityProductionDependencies {
  readonly effectiveAccess: SiteEffectiveAccessSnapshotPort;
  readonly intentAuthority: SiteWebBuildIntentIssuerAuthorityPort;
  readonly intentSigner: SiteWebBuildIntentSignerPort;
  readonly certificationTrustAuthority: SiteReleaseCertificationTrustAuthorityPort;
  readonly publicationDocumentRoot?: string;
  readonly documents?: SitePublicationDocumentResolver;
  readonly now?: () => string;
}

/**
 * Production owner composition. Cross-domain facts enter only through typed
 * transaction-local ports; this bounded context never calls Platform via RPC.
 */
export function createSitePublicationAuthorityProductionComposition(
  database: PlatformTransactionalDatabaseClient,
  dependencies: SitePublicationAuthorityProductionDependencies,
): Readonly<{ authority: SitePublicationAuthorityService }> {
  const documents = dependencies.documents ?? new ContentAddressedSitePublicationDocumentResolver(
    required(dependencies.publicationDocumentRoot, "PLATFORM_PUBLICATION_DOCUMENT_ROOT_REQUIRED"),
  );
  const now = dependencies.now ?? (() => new Date().toISOString());
  return Object.freeze({
    authority: new SitePublicationAuthorityService(
      new PlatformUnitOfWork(database),
      new PostgresSitePublicationAuthorityRepository(),
      new PostgresSiteAuthorityJournal(),
      new PostgresSiteReleaseCandidateAssembler(dependencies.effectiveAccess, { now }),
      documents,
      new SiteWebBuildIntentIssuer(dependencies.intentAuthority, dependencies.intentSigner, now),
      new Ed25519SiteReleaseCertificationAdmission(
        documents,
        dependencies.certificationTrustAuthority,
        now,
      ),
      new SiteReleaseAssembler({ now }),
    ),
  });
}

export interface SiteReleaseEvidenceAuthorityProductionDependencies {
  readonly evidenceTrustAuthority: SiteReleaseEvidenceTrustAuthorityPort;
  readonly publicationDocumentRoot?: string;
  readonly documents?: SitePublicationDocumentResolver;
  readonly now?: () => string;
}

/** Production machine owner composition; no operator publication capability crosses this boundary. */
export function createSiteReleaseEvidenceAuthorityProductionComposition(
  database: PlatformTransactionalDatabaseClient,
  dependencies: SiteReleaseEvidenceAuthorityProductionDependencies,
): Readonly<{ authority: SiteReleaseEvidenceAuthorityService }> {
  const documents = dependencies.documents ?? new ContentAddressedSitePublicationDocumentResolver(
    required(dependencies.publicationDocumentRoot, "PLATFORM_PUBLICATION_DOCUMENT_ROOT_REQUIRED"),
  );
  const now = dependencies.now ?? (() => new Date().toISOString());
  return Object.freeze({
    authority: new SiteReleaseEvidenceAuthorityService(
      new PlatformUnitOfWork(database),
      new PostgresSitePublicationAuthorityRepository(),
      new PostgresSiteAuthorityJournal(),
      new SiteReleaseEvidenceAdmission(
        documents,
        new Ed25519SiteReleaseEvidenceTrust(dependencies.evidenceTrustAuthority, now),
        now,
      ),
    ),
  });
}

function required(value: string | undefined, code: string): string {
  if (value === undefined || value.length === 0) throw new Error(code);
  return value;
}
