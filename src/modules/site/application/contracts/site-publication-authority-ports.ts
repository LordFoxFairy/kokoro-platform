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
import type {
  SiteWebBuildIntentDsseEnvelope,
  SITE_WEB_BUILD_INTENT_PAYLOAD_TYPE,
} from "../../domain/site-web-build-intent-dsse.js";
import type {
  DetachedReleaseEvidenceAttestation,
  SignedReleaseEvidenceDecision,
} from "../../../../generated/proto/kokoro/platform/site/v1/site_publication_pb.js";
import type {
  SiteReleaseProducerTrust,
  VerifiedSiteReleaseEvidenceDecision,
} from "./site-release-evidence-trust.js";

export interface SiteWebBuildIntentSigningKeyBinding {
  readonly keyId: string;
  readonly keyVersion: bigint;
  readonly publicKeyFingerprint: string;
}

export interface SiteWebBuildIntentSignerPort {
  sign(input: Readonly<{
    key: SiteWebBuildIntentSigningKeyBinding;
    payloadType: typeof SITE_WEB_BUILD_INTENT_PAYLOAD_TYPE;
    payload: Uint8Array;
  }>): Promise<SiteWebBuildIntentDsseEnvelope>;
  verify(input: Readonly<{
    key: SiteWebBuildIntentSigningKeyBinding;
    envelope: SiteWebBuildIntentDsseEnvelope;
  }>): Promise<void>;
}

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
      commandId: string;
      candidate: SiteReleaseCandidateAuthority;
      predecessors: Readonly<Partial<Record<SitePublicationNodeKind, SitePublicationNode>>>;
    }>,
  ): Promise<Readonly<{
    binding: ImmutableRevisionBinding;
    source: ResolvedCanonicalDocument;
    envelope: SiteWebBuildIntentDsseEnvelope;
  }>>;
  verify(
    transaction: PlatformTransaction,
    input: Readonly<{
      candidate: SiteReleaseCandidateAuthority;
      node: SitePublicationNode;
      envelope: SiteWebBuildIntentDsseEnvelope;
    }>,
  ): Promise<void>;
}

export interface SiteWebBuildIntentIssuerAuthority {
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
}

export interface SiteWebBuildIntentIssuerAuthorityPort {
  resolve(
    transaction: PlatformTransaction,
    input: Readonly<{ siteRef: string; environment: string }>,
  ): Promise<Readonly<SiteWebBuildIntentIssuerAuthority>>;
  resolveExact(
    transaction: PlatformTransaction,
    input: Readonly<{
      siteRef: string;
      environment: string;
      key: SiteWebBuildIntentSigningKeyBinding;
    }>,
  ): Promise<Readonly<SiteWebBuildIntentIssuerAuthority>>;
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
      producerRegistration: ImmutableRevisionBinding;
      provenanceAttestation: DetachedReleaseEvidenceAttestation;
      evidenceDecisions: readonly SignedReleaseEvidenceDecision[];
    }>,
  ): Promise<Readonly<{
    binding: ImmutableRevisionBinding;
    source: ResolvedCanonicalDocument;
    producer: SiteReleaseProducerTrust;
    decisions: readonly VerifiedSiteReleaseEvidenceDecision[];
    verifiedAt: string;
    provenanceCanonicalPayload: Uint8Array;
  }>>;
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
  loadCandidate(
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
  loadNode(
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
  loadWebBuildIntentEnvelope(
    transaction: PlatformTransaction,
    binding: ImmutableRevisionBinding,
  ): Promise<SiteWebBuildIntentDsseEnvelope | null>;
  insertWebBuildIntentEnvelope(
    transaction: PlatformTransaction,
    binding: ImmutableRevisionBinding,
    envelope: SiteWebBuildIntentDsseEnvelope,
    commandId: string,
  ): Promise<void>;
}
