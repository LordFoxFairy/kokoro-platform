import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import {
  releaseEvidenceDecisionSignaturePreimage,
} from "../../../../generated/contracts/platform-site-evidence-admission@v1/digest.js";
import {
  ReleaseEvidenceCheckerRole,
  ReleaseEvidenceDecisionState,
  ReleaseEvidenceKind,
  ReleaseEvidenceSignatureAlgorithm,
  type SignedReleaseEvidenceDecision,
} from "../../../../generated/proto/kokoro/platform/site/v1/site_publication_pb.js";
import type {
  SiteReleaseCheckerTrust,
  SiteReleaseEvidenceKind,
  SiteReleaseEvidenceTrustAuthorityPort,
  SiteReleaseEvidenceTrustPort,
  SiteReleaseProducerTrust,
  VerifiedSiteReleaseEvidenceDecision,
} from "../../application/contracts/site-release-evidence-trust.js";
import {
  SITE_RELEASE_DECISION_SIGNATURE_DOMAIN,
  SITE_RELEASE_PROVENANCE_SIGNATURE_DOMAIN,
} from "../../application/contracts/site-release-evidence-trust.js";
import type {
  CandidateAuthorityBinding,
  ImmutableRevisionBinding,
} from "../../domain/site-publication-authority.js";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export class Ed25519SiteReleaseEvidenceTrust implements SiteReleaseEvidenceTrustPort {
  constructor(
    private readonly authority: SiteReleaseEvidenceTrustAuthorityPort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async verify(
    transaction: Parameters<SiteReleaseEvidenceTrustPort["verify"]>[0],
    input: Parameters<SiteReleaseEvidenceTrustPort["verify"]>[1],
  ) {
    const verifiedAt = instant(this.now());
    if (input.siteRef !== input.candidate.siteRef || input.candidate.environment.length === 0) {
      throw new Error("SITE_EVIDENCE_SCOPE_INVALID");
    }
    const attestation = input.provenanceAttestation;
    if (attestation.payloadType !== SITE_RELEASE_PROVENANCE_SIGNATURE_DOMAIN ||
        attestation.signatureAlgorithm !== ReleaseEvidenceSignatureAlgorithm.ED25519 ||
        attestation.signature.byteLength !== 64) {
      throw new Error("SITE_EVIDENCE_PROVENANCE_ATTESTATION_INVALID");
    }
    const producer = await this.authority.resolveProducer(transaction, {
      producerIdentityRef: input.producerIdentityRef,
      environment: input.candidate.environment,
      producerRegistration: input.producerRegistration,
      signingKeyId: attestation.keyId,
      signingKeyVersion: attestation.keyVersion,
    });
    assertProducer(producer, input, verifiedAt);
    const provenanceDigest = digest(input.provenanceCanonicalBytes);
    if (!safeEqual(provenanceDigest, input.provenanceBinding.digest)) {
      throw new Error("SITE_EVIDENCE_PROVENANCE_DIGEST_INVALID");
    }
    const producerKey = authoritativeKey(producer);
    if (!verify(null, pae(SITE_RELEASE_PROVENANCE_SIGNATURE_DOMAIN,
      input.provenanceCanonicalBytes), producerKey, attestation.signature)) {
      throw new Error("SITE_EVIDENCE_PROVENANCE_SIGNATURE_INVALID");
    }

    const checkers = await this.authority.resolveCheckers(transaction, {
      environment: input.candidate.environment,
    });
    assertCheckerSet(checkers, input.candidate.environment, verifiedAt);
    const expected = new Map<SiteReleaseEvidenceKind, ImmutableRevisionBinding>([
      ["artifact-inspection", input.artifactInspectionEvidence],
      ["journey", input.journeyEvidence],
      ["security", input.securityEvidence],
    ]);
    if (input.evidenceDecisions.length !== 3) {
      throw new Error("SITE_EVIDENCE_DECISION_SET_INVALID");
    }
    const verifiedDecisions = input.evidenceDecisions.map((decision) =>
      verifyDecision(decision, checkers, expected, input, verifiedAt));
    if (new Set(verifiedDecisions.map(({ kind }) => kind)).size !== 3 ||
        new Set(verifiedDecisions.map(({ checkerIdentityRef }) => checkerIdentityRef)).size !== 3 ||
        new Set(verifiedDecisions.map(({ signingKeyFingerprint }) => signingKeyFingerprint)).size !== 3) {
      throw new Error("SITE_EVIDENCE_DECISION_SET_INVALID");
    }
    return Object.freeze({
      producer,
      decisions: Object.freeze([...verifiedDecisions].sort((left, right) =>
        evidenceOrder(left.kind) - evidenceOrder(right.kind))),
      verifiedAt,
    });
  }
}

function assertProducer(
  producer: SiteReleaseProducerTrust,
  input: Parameters<SiteReleaseEvidenceTrustPort["verify"]>[1],
  observedAt: string,
): void {
  if (producer.producerIdentityRef !== input.producerIdentityRef ||
      producer.producerRole !== "web-artifact-provenance-attestor" ||
      producer.environment !== input.candidate.environment ||
      producer.signatureDomain !== SITE_RELEASE_PROVENANCE_SIGNATURE_DOMAIN ||
      producer.keyStatus !== "active" ||
      producer.signingKeyId !== input.provenanceAttestation.keyId ||
      producer.signingKeyVersion !== input.provenanceAttestation.keyVersion ||
      !sameRevision(producer.producerRegistration, input.producerRegistration) ||
      observedAt < instant(producer.keyValidFrom) || observedAt >= instant(producer.keyValidUntil)) {
    throw new Error("SITE_EVIDENCE_PRODUCER_NOT_AUTHORIZED");
  }
  authoritativeKey(producer);
}

function assertCheckerSet(
  checkers: readonly SiteReleaseCheckerTrust[],
  environment: string,
  observedAt: string,
): void {
  const roles: readonly SiteReleaseEvidenceKind[] = ["artifact-inspection", "journey", "security"];
  if (checkers.length !== 3 || roles.some((role) =>
    checkers.filter((checker) => checker.role === role).length !== 1) ||
    checkers.some((checker) => checker.environment !== environment || checker.keyStatus !== "active" ||
      checker.signatureDomain !== SITE_RELEASE_DECISION_SIGNATURE_DOMAIN ||
      observedAt < instant(checker.keyValidFrom) || observedAt >= instant(checker.keyValidUntil)) ||
    new Set(checkers.map(({ checkerIdentityRef }) => checkerIdentityRef)).size !== 3 ||
    new Set(checkers.map(({ signingKeyFingerprint }) => signingKeyFingerprint)).size !== 3) {
    throw new Error("SITE_EVIDENCE_CHECKER_TRUST_SET_INVALID");
  }
  checkers.forEach(authoritativeKey);
}

function verifyDecision(
  decision: SignedReleaseEvidenceDecision,
  authorities: readonly SiteReleaseCheckerTrust[],
  expected: ReadonlyMap<SiteReleaseEvidenceKind, ImmutableRevisionBinding>,
  input: Parameters<SiteReleaseEvidenceTrustPort["verify"]>[1],
  observedAt: string,
): VerifiedSiteReleaseEvidenceDecision {
  const material = decision.material;
  const attestation = decision.attestation;
  if (material === undefined || material.candidate === undefined || material.evidence === undefined ||
      material.checkerTrust === undefined || material.checkerTrust.checkerRegistration === undefined ||
      attestation === undefined || material.state !== ReleaseEvidenceDecisionState.PASSED) {
    throw new Error("SITE_EVIDENCE_DECISION_MATERIAL_INVALID");
  }
  const kind = evidenceKind(material.kind);
  if (checkerRole(material.checkerTrust.role) !== kind ||
      material.siteId !== input.siteRef || material.environment !== input.candidate.environment ||
      material.webArtifactDigest !== input.webArtifactDigest ||
      !sameCandidate(material.candidate, input.candidate.binding) ||
      !sameWireRevision(material.evidence, expected.get(kind))) {
    throw new Error("SITE_EVIDENCE_DECISION_BINDING_INVALID");
  }
  const authority = authorities.find(({ role }) => role === kind);
  if (authority === undefined || authority.checkerIdentityRef !== material.checkerTrust.checkerIdentityRef ||
      !sameWireRevision(material.checkerTrust.checkerRegistration, authority.checkerRegistration) ||
      authority.signingKeyId !== material.checkerTrust.signingKeyId ||
      authority.signingKeyVersion !== material.checkerTrust.signingKeyVersion ||
      authority.signingKeyFingerprint !== material.checkerTrust.signingKeyFingerprint ||
      authority.trustPolicyEpoch !== material.checkerTrust.trustPolicyEpoch ||
      observedAt < authority.keyValidFrom || observedAt >= authority.keyValidUntil ||
      attestation.payloadType !== SITE_RELEASE_DECISION_SIGNATURE_DOMAIN ||
      attestation.signatureAlgorithm !== ReleaseEvidenceSignatureAlgorithm.ED25519 ||
      attestation.signature.byteLength !== 64) {
    throw new Error("SITE_EVIDENCE_CHECKER_NOT_AUTHORIZED");
  }
  const preimage = releaseEvidenceDecisionSignaturePreimage(decision);
  if (!verify(null, preimage, authoritativeKey(authority), attestation.signature)) {
    throw new Error("SITE_EVIDENCE_DECISION_SIGNATURE_INVALID");
  }
  return Object.freeze({
    ...authority,
    kind,
    state: "passed" as const,
    evidence: Object.freeze({ ref: material.evidence.ref, revision: material.evidence.revision,
      digest: material.evidence.digest }),
    canonicalPayload: new Uint8Array(attestation.canonicalPayload),
    payloadDigest: attestation.payloadDigest,
    signature: new Uint8Array(attestation.signature),
  });
}

function authoritativeKey(
  trust: Pick<SiteReleaseProducerTrust | SiteReleaseCheckerTrust,
    "publicKeySpkiPem" | "signingKeyFingerprint">,
) {
  let key;
  try { key = createPublicKey(trust.publicKeySpkiPem); } catch {
    throw new Error("SITE_EVIDENCE_SIGNING_KEY_INVALID");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error("SITE_EVIDENCE_SIGNING_KEY_INVALID");
  const fingerprint = `sha256:${createHash("sha256").update(key.export({
    format: "der", type: "spki",
  })).digest("hex")}`;
  if (!safeEqual(fingerprint, trust.signingKeyFingerprint)) {
    throw new Error("SITE_EVIDENCE_SIGNING_KEY_FINGERPRINT_MISMATCH");
  }
  return key;
}

function evidenceKind(kind: ReleaseEvidenceKind): SiteReleaseEvidenceKind {
  if (kind === ReleaseEvidenceKind.ARTIFACT_INSPECTION) return "artifact-inspection";
  if (kind === ReleaseEvidenceKind.JOURNEY) return "journey";
  if (kind === ReleaseEvidenceKind.SECURITY) return "security";
  throw new Error("SITE_EVIDENCE_DECISION_KIND_INVALID");
}

function checkerRole(role: ReleaseEvidenceCheckerRole): SiteReleaseEvidenceKind {
  if (role === ReleaseEvidenceCheckerRole.ARTIFACT_INSPECTION) return "artifact-inspection";
  if (role === ReleaseEvidenceCheckerRole.JOURNEY) return "journey";
  if (role === ReleaseEvidenceCheckerRole.SECURITY) return "security";
  throw new Error("SITE_EVIDENCE_CHECKER_ROLE_INVALID");
}

function evidenceOrder(kind: SiteReleaseEvidenceKind): number {
  return kind === "artifact-inspection" ? 0 : kind === "journey" ? 1 : 2;
}

function sameCandidate(
  actual: Readonly<{ candidateRef: string; candidateVersion: bigint;
    candidateAuthorizationEpoch: bigint; candidateDigest: string }>,
  expected: CandidateAuthorityBinding,
): boolean {
  return actual.candidateRef === expected.ref && actual.candidateVersion === expected.version &&
    actual.candidateAuthorizationEpoch === expected.authorizationEpoch &&
    actual.candidateDigest === expected.digest;
}

function sameWireRevision(
  actual: Readonly<{ ref: string; revision: bigint; digest: string }>,
  expected: ImmutableRevisionBinding | undefined,
): boolean {
  return expected !== undefined && actual.ref === expected.ref && actual.revision === expected.revision &&
    actual.digest === expected.digest;
}

function sameRevision(left: ImmutableRevisionBinding, right: ImmutableRevisionBinding): boolean {
  return left.ref === right.ref && left.revision === right.revision && left.digest === right.digest;
}

function digest(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function safeEqual(left: string, right: string): boolean {
  if (!SHA256.test(left) || !SHA256.test(right)) return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function pae(type: string, payload: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "utf8");
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${typeBytes.byteLength} `, "ascii"), typeBytes,
    Buffer.from(` ${payload.byteLength} `, "ascii"), Buffer.from(payload),
  ]);
}

function instant(value: string): string {
  if (!/^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u.test(value) ||
      new Date(value).toISOString() !== value) throw new Error("SITE_EVIDENCE_TIME_INVALID");
  return value;
}
