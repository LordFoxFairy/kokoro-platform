import { z } from "zod";
import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { ImmutableRevisionBinding } from "../../domain/site-publication-authority.js";
import {
  bytes,
  canonicalInstant,
  deepFreeze,
  digest,
  exactlyOne,
  positiveDecimal,
  reference,
  revisionBinding,
  wireRevisionBindingSchema,
} from "./site-publication-authority-codecs.js";

interface TrustRow extends Record<string, unknown> {
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
  readonly signatureAudience: unknown;
  readonly environment: unknown;
  readonly keyStatus: unknown;
  readonly keyValidFrom: unknown;
  readonly keyValidUntil: unknown;
  readonly publicKeyPem: unknown;
  readonly publicKeyFingerprint: unknown;
  readonly detachedSignature: unknown;
  readonly evidenceDecisions: unknown;
}

const decisionsSchema = z.array(z.object({
  binding: wireRevisionBindingSchema,
  decision: z.enum(["passed", "failed"]),
}).strict()).max(32).refine((values) => new Set(values.map(({ binding }) =>
  `${binding.ref}\0${binding.revision}\0${binding.digest}`)).size === values.length);

export interface ResolvedSiteReleaseTrustRow {
  readonly producerIdentityRef: string;
  readonly producerRole: string;
  readonly producerRegistration: ImmutableRevisionBinding;
  readonly producerRegistryEpoch: bigint;
  readonly trustPolicy: ImmutableRevisionBinding;
  readonly trustPolicyEpoch: bigint;
  readonly signingKeyId: string;
  readonly signingKeyVersion: bigint;
  readonly signatureAudience: string;
  readonly environment: string;
  readonly keyStatus: "active" | "revoked";
  readonly keyValidFrom: string;
  readonly keyValidUntil: string;
  readonly publicKeyPem: string;
  readonly publicKeyFingerprint: string;
  readonly detachedSignature: Uint8Array;
  readonly evidenceDecisions: readonly Readonly<{
    binding: ImmutableRevisionBinding;
    decision: "passed" | "failed";
  }>[];
}

export async function resolveSiteReleaseTrustRow(
  transaction: PlatformTransaction,
  input: Readonly<{
    subjectKind: "web-artifact-provenance" | "release-certification";
    subject: ImmutableRevisionBinding;
    producerIdentityRef: string;
  }>,
): Promise<ResolvedSiteReleaseTrustRow> {
  const rows = await resolvePlatformTransaction(transaction).query<TrustRow>(
    `SELECT envelope.producer_identity_ref AS "producerIdentityRef",
            envelope.producer_role AS "producerRole",
            trust.producer_registration_ref AS "producerRegistrationRef",
            trust.producer_registration_revision::text AS "producerRegistrationRevision",
            trust.producer_registration_digest AS "producerRegistrationDigest",
            trust.producer_registry_epoch::text AS "producerRegistryEpoch",
            trust.trust_policy_ref AS "trustPolicyRef",
            trust.trust_policy_revision::text AS "trustPolicyRevision",
            trust.trust_policy_digest AS "trustPolicyDigest",
            trust.trust_policy_epoch::text AS "trustPolicyEpoch",
            trust.signing_key_id AS "signingKeyId",
            trust.signing_key_version::text AS "signingKeyVersion",
            trust.signature_audience AS "signatureAudience",trust.environment,
            trust.key_status AS "keyStatus",
            to_char(trust.key_valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "keyValidFrom",
            to_char(trust.key_valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "keyValidUntil",
            trust.public_key_pem AS "publicKeyPem",
            trust.public_key_fingerprint AS "publicKeyFingerprint",
            envelope.detached_signature AS "detachedSignature",
            COALESCE((SELECT jsonb_agg(jsonb_build_object(
              'binding',jsonb_build_object('ref',decision.evidence_ref,
                'revision',decision.evidence_revision::text,'digest',decision.evidence_digest),
              'decision',decision.decision) ORDER BY decision.evidence_ref COLLATE "C")
              FROM platform.site_release_evidence_decision decision
              WHERE decision.subject_kind=envelope.subject_kind
                AND decision.subject_ref=envelope.subject_ref
                AND decision.subject_revision=envelope.subject_revision
                AND decision.subject_digest=envelope.subject_digest),'[]'::jsonb) AS "evidenceDecisions"
     FROM platform.site_release_attestation_envelope envelope
     JOIN platform.site_release_producer_trust_revision trust
       ON trust.producer_identity_ref=envelope.producer_identity_ref
      AND trust.producer_role=envelope.producer_role AND trust.environment=envelope.environment
      AND trust.signing_key_id=envelope.signing_key_id
      AND trust.signing_key_version=envelope.signing_key_version
     WHERE envelope.subject_kind=$1 AND envelope.subject_ref=$2
       AND envelope.subject_revision=$3::numeric(20,0) AND envelope.subject_digest=$4
       AND envelope.producer_identity_ref=$5`,
    [input.subjectKind, input.subject.ref, input.subject.revision.toString(), input.subject.digest,
      input.producerIdentityRef],
  );
  const row = exactlyOne(rows, "SITE_RELEASE_TRUST_AUTHORITY_NOT_FOUND");
  const decisions = decisionsSchema.safeParse(row.evidenceDecisions);
  if (!decisions.success || typeof row.publicKeyPem !== "string" ||
      row.publicKeyPem.length < 64 || row.publicKeyPem.length > 16_384 ||
      (row.keyStatus !== "active" && row.keyStatus !== "revoked")) {
    throw new Error("SITE_RELEASE_TRUST_AUTHORITY_CORRUPT");
  }
  return deepFreeze({
    producerIdentityRef: reference(row.producerIdentityRef, "SITE_RELEASE_TRUST_AUTHORITY_CORRUPT"),
    producerRole: reference(row.producerRole, "SITE_RELEASE_TRUST_AUTHORITY_CORRUPT"),
    producerRegistration: revisionBinding({
      ref: reference(row.producerRegistrationRef, "SITE_RELEASE_TRUST_AUTHORITY_CORRUPT"),
      revision: positiveDecimal(row.producerRegistrationRevision,
        "SITE_RELEASE_TRUST_AUTHORITY_CORRUPT").toString(),
      digest: digest(row.producerRegistrationDigest, "SITE_RELEASE_TRUST_AUTHORITY_CORRUPT"),
    }),
    producerRegistryEpoch: positiveDecimal(row.producerRegistryEpoch,
      "SITE_RELEASE_TRUST_AUTHORITY_CORRUPT"),
    trustPolicy: revisionBinding({
      ref: reference(row.trustPolicyRef, "SITE_RELEASE_TRUST_AUTHORITY_CORRUPT"),
      revision: positiveDecimal(row.trustPolicyRevision,
        "SITE_RELEASE_TRUST_AUTHORITY_CORRUPT").toString(),
      digest: digest(row.trustPolicyDigest, "SITE_RELEASE_TRUST_AUTHORITY_CORRUPT"),
    }),
    trustPolicyEpoch: positiveDecimal(row.trustPolicyEpoch, "SITE_RELEASE_TRUST_AUTHORITY_CORRUPT"),
    signingKeyId: reference(row.signingKeyId, "SITE_RELEASE_TRUST_AUTHORITY_CORRUPT"),
    signingKeyVersion: positiveDecimal(row.signingKeyVersion,
      "SITE_RELEASE_TRUST_AUTHORITY_CORRUPT"),
    signatureAudience: reference(row.signatureAudience, "SITE_RELEASE_TRUST_AUTHORITY_CORRUPT"),
    environment: reference(row.environment, "SITE_RELEASE_TRUST_AUTHORITY_CORRUPT"),
    keyStatus: row.keyStatus,
    keyValidFrom: canonicalInstant(row.keyValidFrom, "SITE_RELEASE_TRUST_AUTHORITY_CORRUPT"),
    keyValidUntil: canonicalInstant(row.keyValidUntil, "SITE_RELEASE_TRUST_AUTHORITY_CORRUPT"),
    publicKeyPem: row.publicKeyPem,
    publicKeyFingerprint: digest(row.publicKeyFingerprint, "SITE_RELEASE_TRUST_AUTHORITY_CORRUPT"),
    detachedSignature: bytes(row.detachedSignature, "SITE_RELEASE_TRUST_AUTHORITY_CORRUPT"),
    evidenceDecisions: decisions.data.map((decision) => Object.freeze({
      binding: revisionBinding(decision.binding), decision: decision.decision,
    })),
  });
}
