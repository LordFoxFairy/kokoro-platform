import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type {
  PublishedSiteRelease,
  SiteAuthorityDefinition,
  SiteProjectBinding,
} from "../../domain/site-publication.js";

export interface SitePublicationRepository {
  insertSiteWithProjectBinding(
    transaction: PlatformTransaction,
    site: SiteAuthorityDefinition,
    binding: SiteProjectBinding,
  ): Promise<void>;
  insertRelease(transaction: PlatformTransaction, release: PublishedSiteRelease): Promise<void>;
}

export interface SiteReleaseCertificationAuthority {
  verify(input: Readonly<{
    siteRef: string;
    releaseRef: string;
    webArtifactDigest: string;
    releaseManifestDigest: string;
    certificationDigest: string;
    launchProfileRef: string;
    siteConfigRevisionRef: string;
    legalRevisionRef: string;
    featurePolicyRevision: string;
    modelOptionCatalogRef: string;
    agentCatalogRef: string;
    identityIssuerLabel: string;
    identityAuthStrengthPolicyRevision: string;
    enabledSurfaceIds: readonly string[];
    localePolicy: Readonly<{
      defaultLocale: string;
      allowedLocales: readonly string[];
    }>;
    proof: Readonly<{
      signingKeyRef: string;
      issuedAt: string;
      expiresAt: string;
      signature: Uint8Array;
    }>;
  }>): Promise<Readonly<{ status: "passed"; expiresAt: string }>>;
}
