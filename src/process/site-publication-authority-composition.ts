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
import { PostgresSiteReleaseEvidenceRecordRepository } from
  "../modules/site/infrastructure/postgres/site-release-evidence-record-repository.js";
import { Ed25519SiteReleaseCertificationAdmission } from
  "../modules/site/infrastructure/crypto/ed25519-site-release-certification-admission.js";
import { PostgresControlCommandReceiptTimestampReader } from
  "../modules/admin/infrastructure/postgres/control-command-receipt-reader.js";
import { PlatformUnitOfWork } from "../shared/unit-of-work/index.js";
import { resolvePlatformTransaction } from
  "../shared/unit-of-work/platform-transaction.js";

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
): Readonly<{
  authority: SiteReleaseEvidenceAuthorityService;
  receipts: PostgresControlCommandReceiptTimestampReader;
}> {
  const documents = dependencies.documents ?? new ContentAddressedSitePublicationDocumentResolver(
    required(dependencies.publicationDocumentRoot, "PLATFORM_PUBLICATION_DOCUMENT_ROOT_REQUIRED"),
  );
  const now = dependencies.now ?? (() => new Date().toISOString());
  const unitOfWork = createSiteReleaseEvidenceOwnerUnitOfWork(database, now);
  return Object.freeze({
    authority: new SiteReleaseEvidenceAuthorityService(
      unitOfWork,
      new PostgresSitePublicationAuthorityRepository(),
      new PostgresSiteAuthorityJournal(),
      new SiteReleaseEvidenceAdmission(
        documents,
        new Ed25519SiteReleaseEvidenceTrust(dependencies.evidenceTrustAuthority, now),
      ),
      new PostgresSiteReleaseEvidenceRecordRepository(),
    ),
    receipts: new PostgresControlCommandReceiptTimestampReader(unitOfWork),
  });
}

/**
 * Narrow privilege adapter between the workload-owned domain command and the
 * leased Admission PostgreSQL execution root. The application fence remains
 * `site.release-evidence.publish`; only this host may map it to the database
 * operation `site.evidence.record`.
 */
export function createSiteReleaseEvidenceOwnerUnitOfWork(
  database: PlatformTransactionalDatabaseClient,
  now: () => string = () => new Date().toISOString(),
): PlatformUnitOfWork {
  return new PlatformUnitOfWork({
    async transaction(fence, work) {
      const context = fence.context;
      if (fence.operation !== "site.release-evidence.publish" ||
          context.trustedCaller.kind !== "platform_worker" ||
          context.actor.kind !== "workload" ||
          context.target.purpose !== "site.release-evidence.publish" ||
          context.target.siteId === null ||
          context.target.siteId !== context.trustedCaller.siteId ||
          context.actor.subjectId !== context.trustedCaller.workloadIdentityId ||
          context.environment !== context.trustedCaller.environment ||
          context.environment !== context.actor.environment ||
          context.region !== context.trustedCaller.region ||
          context.region !== context.actor.region) {
        throw new Error("SITE_EVIDENCE_OWNER_OPERATION_INVALID");
      }
      return database.internalTransaction("site.evidence.record", async (transaction) => {
        await resolvePlatformTransaction(transaction).query(
          `SELECT set_config('app.site_id',$1,true),
                  set_config('app.environment',$2,true),
                  set_config('app.region',$3,true),
                  set_config('app.workload_identity_ref',$4,true),
                  set_config('app.workload_binding_epoch',$5,true),
                  set_config('app.workload_kind','platform_worker',true),
                  set_config('app.actor_kind','workload',true)`,
          [context.target.siteId, context.environment, context.region,
            context.trustedCaller.workloadIdentityId, context.trustedCaller.bindingEpoch],
        );
        return work(transaction);
      });
    },
  }, now);
}

function required(value: string | undefined, code: string): string {
  if (value === undefined || value.length === 0) throw new Error(code);
  return value;
}
