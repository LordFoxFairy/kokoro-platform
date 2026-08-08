import type {
  DetachedReleaseEvidenceAttestation,
  SignedReleaseEvidenceDecision,
} from "../../../../generated/proto/kokoro/platform/site/v1/site_publication_pb.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type {
  ImmutableRevisionBinding,
  SiteReleaseCandidateAuthority,
} from "../../domain/site-publication-authority.js";

export const SITE_RELEASE_PROVENANCE_SIGNATURE_DOMAIN = "application/vnd.in-toto+json";
export const SITE_RELEASE_DECISION_SIGNATURE_DOMAIN =
  "application/vnd.kokoro.release-evidence-decision.v1+json";

export type SiteReleaseEvidenceKind = "artifact-inspection" | "journey" | "security";

export interface SiteReleaseProducerTrust {
  readonly producerIdentityRef: string;
  readonly producerRole: "web-artifact-provenance-attestor";
  readonly producerRegistration: ImmutableRevisionBinding;
  readonly producerRegistryEpoch: bigint;
  readonly trustPolicy: ImmutableRevisionBinding;
  readonly trustPolicyEpoch: bigint;
  readonly signingKeyId: string;
  readonly signingKeyVersion: bigint;
  readonly signingKeyFingerprint: string;
  readonly signatureDomain: typeof SITE_RELEASE_PROVENANCE_SIGNATURE_DOMAIN;
  readonly environment: string;
  readonly keyStatus: "active" | "revoked";
  readonly keyValidFrom: string;
  readonly keyValidUntil: string;
  readonly publicKeySpkiPem: string;
  readonly configurationDigest: string;
}

export interface SiteReleaseCheckerTrust {
  readonly environment: string;
  readonly role: SiteReleaseEvidenceKind;
  readonly checkerIdentityRef: string;
  readonly checkerRegistration: ImmutableRevisionBinding;
  readonly trustPolicy: ImmutableRevisionBinding;
  readonly trustPolicyEpoch: bigint;
  readonly signingKeyId: string;
  readonly signingKeyVersion: bigint;
  readonly signingKeyFingerprint: string;
  readonly signatureDomain: typeof SITE_RELEASE_DECISION_SIGNATURE_DOMAIN;
  readonly keyStatus: "active" | "revoked";
  readonly keyValidFrom: string;
  readonly keyValidUntil: string;
  readonly publicKeySpkiPem: string;
  readonly configurationDigest: string;
}

export interface VerifiedSiteReleaseEvidenceDecision extends SiteReleaseCheckerTrust {
  readonly kind: SiteReleaseEvidenceKind;
  readonly state: "passed";
  readonly evidence: ImmutableRevisionBinding;
  readonly canonicalPayload: Uint8Array;
  readonly payloadDigest: string;
  readonly signature: Uint8Array;
}

/** Static key authority only. Submitted envelopes and decisions never enter a
 * trust lookup and are persisted only after all four signatures verify. */
export interface SiteReleaseEvidenceTrustAuthorityPort {
  resolveProducer(transaction: PlatformTransaction, input: Readonly<{
    producerIdentityRef: string;
    environment: string;
    producerRegistration: ImmutableRevisionBinding;
    signingKeyId: string;
    signingKeyVersion: bigint;
  }>): Promise<SiteReleaseProducerTrust>;
  resolveCheckers(transaction: PlatformTransaction, input: Readonly<{
    environment: string;
  }>): Promise<readonly SiteReleaseCheckerTrust[]>;
}

export interface SiteReleaseEvidenceTrustPort {
  verify(transaction: PlatformTransaction, input: Readonly<{
    candidate: SiteReleaseCandidateAuthority;
    siteRef: string;
    producerIdentityRef: string;
    producerRegistration: ImmutableRevisionBinding;
    provenanceBinding: ImmutableRevisionBinding;
    provenanceCanonicalBytes: Uint8Array;
    provenanceAttestation: DetachedReleaseEvidenceAttestation;
    webArtifactDigest: string;
    artifactInspectionEvidence: ImmutableRevisionBinding;
    journeyEvidence: ImmutableRevisionBinding;
    securityEvidence: ImmutableRevisionBinding;
    evidenceDecisions: readonly SignedReleaseEvidenceDecision[];
  }>): Promise<Readonly<{
    producer: SiteReleaseProducerTrust;
    decisions: readonly VerifiedSiteReleaseEvidenceDecision[];
    verifiedAt: string;
  }>>;
}
