import type { ResolvedCanonicalDocument } from
  "../../../product-catalog/domain/canonical-product-document.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type {
  CandidateAuthorityBinding,
  ImmutableRevisionBinding,
  SitePublicationNode,
  SitePublicationNodeKind,
  SiteReleaseCandidateAuthority,
} from "../../domain/site-publication-authority.js";

export interface SiteReleaseCandidateAssemblyPort {
  assemble(
    transaction: PlatformTransaction,
    input: Readonly<{
      siteRef: string;
      environment: string;
      candidateRef: string;
      expectedCandidateVersion: bigint;
      candidateAuthorizationEpoch: bigint;
      launchProductProfile: ImmutableRevisionBinding;
      productSurfaceCatalog: ImmutableRevisionBinding;
    }>,
  ): Promise<ResolvedCanonicalDocument>;
}

export type SitePublicationDocumentKind =
  | Exclude<SitePublicationNodeKind, "site-release">
  | "compiled-web-manifest"
  | "web-artifact-provenance";

export interface SitePublicationDocumentResolver {
  resolve(input: Readonly<{
    kind: SitePublicationDocumentKind;
    binding: ImmutableRevisionBinding;
  }>): Promise<ResolvedCanonicalDocument>;
}

export interface SiteReleaseAssemblyPort {
  assemble(
    transaction: PlatformTransaction,
    input: Readonly<{
      candidate: SiteReleaseCandidateAuthority;
      predecessors: Readonly<Partial<Record<SitePublicationNodeKind, SitePublicationNode>>>;
    }>,
  ): Promise<Readonly<{ binding: ImmutableRevisionBinding; source: ResolvedCanonicalDocument }>>;
}

export interface SiteWebBuildIntentAssemblyPort {
  issue(
    transaction: PlatformTransaction,
    input: Readonly<{
      candidate: SiteReleaseCandidateAuthority;
      binding: ImmutableRevisionBinding;
      predecessors: Readonly<Partial<Record<SitePublicationNodeKind, SitePublicationNode>>>;
    }>,
  ): Promise<ResolvedCanonicalDocument>;
}

export interface SiteWebBuildIntentIssuerAuthorityPort {
  resolve(
    transaction: PlatformTransaction,
    input: Readonly<{ siteRef: string; environment: string }>,
  ): Promise<Readonly<{
    webCompositionRegistry: ImmutableRevisionBinding;
    webBuildToolchain: ImmutableRevisionBinding;
    contractFloor: readonly Readonly<{ contractRef: string; minimumMajor: bigint }>[];
    issuerRef: string;
    producerRegistry: Readonly<{ ref: string; digest: string }>;
    producerRegistryEpoch: bigint;
    trustPolicy: Readonly<{ ref: string; digest: string }>;
    trustPolicyEpoch: bigint;
    signingKeyId: string;
    keyVersion: bigint;
    publicKeyFingerprint: string;
    keyValidFrom: string;
    keyValidUntil: string;
  }>>;
}

export interface SiteReleaseEvidenceAdmissionPort {
  verify(
    transaction: PlatformTransaction,
    input: Readonly<{
      candidate: SiteReleaseCandidateAuthority;
      compiledWebManifest: ImmutableRevisionBinding;
      webArtifactProvenance: ImmutableRevisionBinding;
      webArtifactDigest: string;
      artifactInspectionEvidence: ImmutableRevisionBinding;
      journeyEvidence: ImmutableRevisionBinding;
      securityEvidence: ImmutableRevisionBinding;
      predecessors: Readonly<Partial<Record<SitePublicationNodeKind, SitePublicationNode>>>;
      producerIdentityRef: string;
    }>,
  ): Promise<Readonly<{ binding: ImmutableRevisionBinding; source: ResolvedCanonicalDocument }>>;
}

export interface SiteReleaseCertificationAdmissionPort {
  verify(
    transaction: PlatformTransaction,
    input: Readonly<{
      binding: ImmutableRevisionBinding;
      candidate: SiteReleaseCandidateAuthority;
      predecessors: Readonly<Partial<Record<SitePublicationNodeKind, SitePublicationNode>>>;
    }>,
  ): Promise<ResolvedCanonicalDocument>;
}

export interface SitePublicationAuthorityRepository {
  assertSiteCanPublish(
    transaction: PlatformTransaction,
    siteRef: string,
    environment: string,
  ): Promise<void>;
  loadCandidateForUpdate(
    transaction: PlatformTransaction,
    candidateRef: string,
  ): Promise<SiteReleaseCandidateAuthority | null>;
  insertCandidate(
    transaction: PlatformTransaction,
    candidate: SiteReleaseCandidateAuthority,
    commandId: string,
  ): Promise<void>;
  revokeCandidate(
    transaction: PlatformTransaction,
    input: Readonly<{
      candidate: CandidateAuthorityBinding;
      expectedAuthorizationEpoch: bigint;
      authorizationEpoch: bigint;
      commandId: string;
    }>,
  ): Promise<void>;
  loadNodeForUpdate(
    transaction: PlatformTransaction,
    kind: SitePublicationNodeKind,
    candidateRef: string,
    candidateVersion: bigint,
  ): Promise<SitePublicationNode | null>;
  insertNode(
    transaction: PlatformTransaction,
    node: SitePublicationNode,
    producerKind: "operator-approved" | "platform-issued" | "workload-attested" | "certifier-signed",
    commandId: string,
  ): Promise<void>;
}
