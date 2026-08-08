import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import type { SiteReleaseCertificationTrustAuthorityPort } from
  "../../application/contracts/site-release-certification-trust.js";
import { bytes, exactlyOne } from "./site-publication-authority-codecs.js";
import {
  decodeCertificationProducerTrust,
  type ProducerTrustRow,
} from "./site-release-static-trust-row.js";

interface CertificationEnvelopeRow extends ProducerTrustRow {
  readonly detachedSignature: unknown;
}

export class PostgresSiteReleaseCertificationTrustAuthority
implements SiteReleaseCertificationTrustAuthorityPort {
  async resolve(
    transaction: Parameters<SiteReleaseCertificationTrustAuthorityPort["resolve"]>[0],
    input: Parameters<SiteReleaseCertificationTrustAuthorityPort["resolve"]>[1],
  ) {
    const rows = await resolvePlatformTransaction(transaction).query<CertificationEnvelopeRow>(
      `SELECT trust.producer_identity_ref AS "producerIdentityRef",
              trust.producer_role AS "producerRole",
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
              trust.signing_key_fingerprint AS "signingKeyFingerprint",
              trust.signature_domain AS "signatureDomain",trust.environment,
              trust.key_status AS "keyStatus",
              to_char(trust.key_valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "keyValidFrom",
              to_char(trust.key_valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "keyValidUntil",
              trust.public_key_spki_pem AS "publicKeySpkiPem",
              trust.configuration_digest AS "configurationDigest",
              envelope.detached_signature AS "detachedSignature"
       FROM platform.site_release_certification_envelope envelope
       JOIN platform.site_release_producer_trust_revision trust
         ON trust.producer_identity_ref=envelope.producer_identity_ref
        AND trust.producer_role=envelope.producer_role AND trust.environment=envelope.environment
        AND trust.producer_registration_ref=envelope.producer_registration_ref
        AND trust.producer_registration_revision=envelope.producer_registration_revision
        AND trust.producer_registration_digest=envelope.producer_registration_digest
        AND trust.producer_registry_epoch=envelope.producer_registry_epoch
        AND trust.trust_policy_ref=envelope.trust_policy_ref
        AND trust.trust_policy_revision=envelope.trust_policy_revision
        AND trust.trust_policy_digest=envelope.trust_policy_digest
        AND trust.trust_policy_epoch=envelope.trust_policy_epoch
        AND trust.signing_key_id=envelope.signing_key_id
        AND trust.signing_key_version=envelope.signing_key_version
        AND trust.signing_key_fingerprint=envelope.signing_key_fingerprint
        AND trust.signature_domain=envelope.signature_domain
        AND trust.configuration_digest=envelope.producer_configuration_digest
       WHERE envelope.certification_ref=$1
         AND envelope.certification_revision=$2::numeric(20,0)
         AND envelope.certification_digest=$3 AND envelope.producer_identity_ref=$4`,
      [input.certification.ref, input.certification.revision.toString(), input.certification.digest,
        input.producerIdentityRef],
    );
    const row = exactlyOne(rows, "SITE_CERTIFICATION_TRUST_AUTHORITY_NOT_FOUND");
    const trust = decodeCertificationProducerTrust(row);
    return Object.freeze({
      producerRegistration: Object.freeze({ ref: trust.producerRegistration.ref,
        digest: trust.producerRegistration.digest, epoch: trust.producerRegistryEpoch }),
      trustPolicy: Object.freeze({ ref: trust.trustPolicy.ref, digest: trust.trustPolicy.digest,
        epoch: trust.trustPolicyEpoch }),
      keyId: trust.signingKeyId,
      keyVersion: trust.signingKeyVersion,
      publicKeySpkiPem: trust.publicKeySpkiPem,
      signingKeyFingerprint: trust.signingKeyFingerprint,
      keyStatus: trust.keyStatus,
      keyValidFrom: trust.keyValidFrom,
      keyValidUntil: trust.keyValidUntil,
      signatureDomain: "application/vnd.kokoro.release-certification-instance.v1+json" as const,
      environment: trust.environment,
      detachedSignature: bytes(row.detachedSignature, "SITE_CERTIFICATION_SIGNATURE_CORRUPT"),
    });
  }
}
