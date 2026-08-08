import type {
  SiteReleaseCheckerTrust,
  SiteReleaseEvidenceKind,
  SiteReleaseProducerTrust,
} from "../../application/contracts/site-release-evidence-trust.js";
import {
  canonicalInstant,
  deepFreeze,
  digest,
  positiveDecimal,
  reference,
} from "./site-publication-authority-codecs.js";

export interface ProducerTrustRow extends Record<string, unknown> {
  readonly producerIdentityRef: unknown;
  readonly producerRole: unknown;
  readonly producerRegistrationRef: unknown;
  readonly producerRegistrationRevision: unknown;
  readonly producerRegistrationDigest: unknown;
  readonly producerRegistryEpoch: unknown;
  readonly trustPolicyRef: unknown;
  readonly trustPolicyRevision: unknown;
  readonly trustPolicyDigest: unknown;
  readonly trustPolicyEpoch: unknown;
  readonly signingKeyId: unknown;
  readonly signingKeyVersion: unknown;
  readonly signingKeyFingerprint: unknown;
  readonly signatureDomain: unknown;
  readonly environment: unknown;
  readonly keyStatus: unknown;
  readonly keyValidFrom: unknown;
  readonly keyValidUntil: unknown;
  readonly publicKeySpkiPem: unknown;
  readonly configurationDigest: unknown;
}

export interface CheckerTrustRow extends Record<string, unknown> {
  readonly environment: unknown;
  readonly checkerRole: unknown;
  readonly checkerIdentityRef: unknown;
  readonly checkerRegistrationRef: unknown;
  readonly checkerRegistrationRevision: unknown;
  readonly checkerRegistrationDigest: unknown;
  readonly trustPolicyRef: unknown;
  readonly trustPolicyRevision: unknown;
  readonly trustPolicyDigest: unknown;
  readonly trustPolicyEpoch: unknown;
  readonly signingKeyId: unknown;
  readonly signingKeyVersion: unknown;
  readonly signingKeyFingerprint: unknown;
  readonly signatureDomain: unknown;
  readonly keyStatus: unknown;
  readonly keyValidFrom: unknown;
  readonly keyValidUntil: unknown;
  readonly publicKeySpkiPem: unknown;
  readonly configurationDigest: unknown;
}

export function decodeEvidenceProducerTrust(row: ProducerTrustRow): SiteReleaseProducerTrust {
  const code = "SITE_EVIDENCE_PRODUCER_TRUST_CORRUPT";
  if (row.producerRole !== "web-artifact-provenance-attestor" ||
      row.signatureDomain !== "application/vnd.in-toto+json") throw new Error(code);
  return decodeProducer(row, code) as SiteReleaseProducerTrust;
}

export function decodeCertificationProducerTrust(row: ProducerTrustRow) {
  const code = "SITE_CERTIFICATION_TRUST_AUTHORITY_CORRUPT";
  if (row.producerRole !== "release-certification-authority" ||
      row.signatureDomain !== "application/vnd.kokoro.release-certification-instance.v1+json") {
    throw new Error(code);
  }
  return decodeProducer(row, code);
}

export function decodeEvidenceCheckerTrust(row: CheckerTrustRow): SiteReleaseCheckerTrust {
  const code = "SITE_EVIDENCE_CHECKER_TRUST_CORRUPT";
  const role = evidenceRole(row.checkerRole, code);
  if (row.signatureDomain !== "application/vnd.kokoro.release-evidence-decision.v1+json") {
    throw new Error(code);
  }
  return deepFreeze({
    environment: reference(row.environment, code),
    role,
    checkerIdentityRef: reference(row.checkerIdentityRef, code),
    checkerRegistration: {
      ref: reference(row.checkerRegistrationRef, code),
      revision: positiveDecimal(row.checkerRegistrationRevision, code),
      digest: digest(row.checkerRegistrationDigest, code),
    },
    trustPolicy: {
      ref: reference(row.trustPolicyRef, code),
      revision: positiveDecimal(row.trustPolicyRevision, code),
      digest: digest(row.trustPolicyDigest, code),
    },
    trustPolicyEpoch: positiveDecimal(row.trustPolicyEpoch, code),
    signingKeyId: reference(row.signingKeyId, code),
    signingKeyVersion: positiveDecimal(row.signingKeyVersion, code),
    signingKeyFingerprint: digest(row.signingKeyFingerprint, code),
    signatureDomain: "application/vnd.kokoro.release-evidence-decision.v1+json" as const,
    keyStatus: keyStatus(row.keyStatus, code),
    keyValidFrom: canonicalInstant(row.keyValidFrom, code),
    keyValidUntil: canonicalInstant(row.keyValidUntil, code),
    publicKeySpkiPem: publicKey(row.publicKeySpkiPem, code),
    configurationDigest: configurationDigest(row.configurationDigest, code),
  });
}

function decodeProducer(row: ProducerTrustRow, code: string) {
  return deepFreeze({
    producerIdentityRef: reference(row.producerIdentityRef, code),
    producerRole: row.producerRole,
    producerRegistration: {
      ref: reference(row.producerRegistrationRef, code),
      revision: positiveDecimal(row.producerRegistrationRevision, code),
      digest: digest(row.producerRegistrationDigest, code),
    },
    producerRegistryEpoch: positiveDecimal(row.producerRegistryEpoch, code),
    trustPolicy: {
      ref: reference(row.trustPolicyRef, code),
      revision: positiveDecimal(row.trustPolicyRevision, code),
      digest: digest(row.trustPolicyDigest, code),
    },
    trustPolicyEpoch: positiveDecimal(row.trustPolicyEpoch, code),
    signingKeyId: reference(row.signingKeyId, code),
    signingKeyVersion: positiveDecimal(row.signingKeyVersion, code),
    signingKeyFingerprint: digest(row.signingKeyFingerprint, code),
    signatureDomain: row.signatureDomain,
    environment: reference(row.environment, code),
    keyStatus: keyStatus(row.keyStatus, code),
    keyValidFrom: canonicalInstant(row.keyValidFrom, code),
    keyValidUntil: canonicalInstant(row.keyValidUntil, code),
    publicKeySpkiPem: publicKey(row.publicKeySpkiPem, code),
    configurationDigest: configurationDigest(row.configurationDigest, code),
  });
}

function evidenceRole(value: unknown, code: string): SiteReleaseEvidenceKind {
  if (value === "artifact-inspection" || value === "journey" || value === "security") return value;
  throw new Error(code);
}

function keyStatus(value: unknown, code: string): "active" | "revoked" {
  if (value === "active" || value === "revoked") return value;
  throw new Error(code);
}

function publicKey(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length < 64 || value.length > 16_384) throw new Error(code);
  return value;
}

function configurationDigest(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new Error(code);
  return value;
}
