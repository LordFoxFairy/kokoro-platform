import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type {
  SiteReleaseProducerTrust,
  VerifiedSiteReleaseEvidenceDecision,
} from "./site-release-evidence-trust.js";
import type {
  CandidateAuthorityBinding,
  ImmutableRevisionBinding,
} from "../../domain/site-publication-authority.js";

export interface SiteReleaseEvidenceWorkloadRecord {
  readonly siteProjectBindingRef: string;
  readonly workloadIdentityRef: string;
  readonly siteRef: string;
  readonly environment: string;
  readonly region: string;
  readonly bindingEpoch: bigint;
  readonly workloadAttestation: ImmutableRevisionBinding;
  readonly workloadRevocationEpoch: bigint;
  readonly liveRead: ImmutableRevisionBinding;
  readonly observedAt: string;
  readonly validUntil: string;
}

export interface VerifiedSiteReleaseEvidenceRecord {
  readonly requestDigest: string;
  readonly commandId: string;
  readonly admittedAt: string;
  readonly siteRef: string;
  readonly environment: string;
  readonly candidate: CandidateAuthorityBinding;
  readonly releaseEvidence: ImmutableRevisionBinding;
  readonly compiledWebManifest: ImmutableRevisionBinding;
  readonly provenance: ImmutableRevisionBinding;
  readonly provenanceCanonicalPayload: Uint8Array;
  readonly provenanceSignature: Uint8Array;
  readonly webArtifactDigest: string;
  readonly artifactInspectionEvidence: ImmutableRevisionBinding;
  readonly journeyEvidence: ImmutableRevisionBinding;
  readonly securityEvidence: ImmutableRevisionBinding;
  readonly producer: SiteReleaseProducerTrust;
  readonly workload: SiteReleaseEvidenceWorkloadRecord;
  readonly decisions: readonly VerifiedSiteReleaseEvidenceDecision[];
}

export interface SiteReleaseEvidenceRecordRepositoryPort {
  assertLiveWorkload(
    transaction: PlatformTransaction,
    input: SiteReleaseEvidenceWorkloadRecord,
  ): Promise<void>;
  insertProvenance(
    transaction: PlatformTransaction,
    input: VerifiedSiteReleaseEvidenceRecord,
  ): Promise<void>;
  insertDecision(
    transaction: PlatformTransaction,
    input: VerifiedSiteReleaseEvidenceRecord,
    decision: VerifiedSiteReleaseEvidenceDecision,
  ): Promise<void>;
  loadReplay(transaction: PlatformTransaction, input: Readonly<{
    commandId: string;
    candidate: CandidateAuthorityBinding;
    siteRef: string;
    environment: string;
    webArtifactDigest: string;
    artifactInspectionEvidence: ImmutableRevisionBinding;
    journeyEvidence: ImmutableRevisionBinding;
    securityEvidence: ImmutableRevisionBinding;
  }>): Promise<Readonly<{ binding: ImmutableRevisionBinding }> | null>;
}
