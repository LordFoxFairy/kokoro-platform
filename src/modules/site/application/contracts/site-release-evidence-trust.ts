import type { CanonicalJsonValue } from
  "../../../product-catalog/domain/canonical-product-document.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type {
  ImmutableRevisionBinding,
  SiteReleaseCandidateAuthority,
} from "../../domain/site-publication-authority.js";

/** Verifies the detached DSSE/in-toto envelope, producer registration, key
 * status/audience/environment and every referenced immutable evidence object.
 * Implementations are Platform local adapters, never operator claims. */
export interface SiteReleaseEvidenceTrustPort {
  verify(transaction: PlatformTransaction, input: Readonly<{
    candidate: SiteReleaseCandidateAuthority;
    producerIdentityRef: string;
    provenanceBinding: ImmutableRevisionBinding;
    provenanceStatement: CanonicalJsonValue;
    webArtifactDigest: string;
    artifactInspectionEvidence: ImmutableRevisionBinding;
    journeyEvidence: ImmutableRevisionBinding;
    securityEvidence: ImmutableRevisionBinding;
  }>): Promise<Readonly<{
    producerRegistration: ImmutableRevisionBinding;
    trustPolicy: ImmutableRevisionBinding;
    signingKeyId: string;
    signingKeyVersion: bigint;
    signatureAudience: "kokoro.web-artifact-provenance.v1";
  }>>;
}

export interface SiteReleaseEvidenceTrustAuthorityPort {
  resolve(transaction: PlatformTransaction, input: Readonly<{
    producerIdentityRef: string;
    provenanceBinding: ImmutableRevisionBinding;
    artifactInspectionEvidence: ImmutableRevisionBinding;
    journeyEvidence: ImmutableRevisionBinding;
    securityEvidence: ImmutableRevisionBinding;
  }>): Promise<Readonly<{
    producerIdentityRef: string;
    producerRole: "web-artifact-provenance-attestor";
    producerRegistration: ImmutableRevisionBinding;
    trustPolicy: ImmutableRevisionBinding;
    signingKeyId: string;
    signingKeyVersion: bigint;
    signatureAudience: "kokoro.web-artifact-provenance.v1";
    environment: string;
    keyStatus: "active" | "revoked";
    keyValidFrom: string;
    keyValidUntil: string;
    publicKeyPem: string;
    publicKeyFingerprint: string;
    detachedSignature: Uint8Array;
    evidenceDecisions: readonly Readonly<{
      binding: ImmutableRevisionBinding;
      decision: "passed" | "failed";
    }>[];
  }>>;
}
