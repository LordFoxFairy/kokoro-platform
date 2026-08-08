import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import type { SiteReleaseEvidenceTrustAuthorityPort } from
  "../../application/contracts/site-release-evidence-trust.js";
import { exactlyOne } from "./site-publication-authority-codecs.js";
import {
  decodeEvidenceCheckerTrust,
  decodeEvidenceProducerTrust,
  type CheckerTrustRow,
  type ProducerTrustRow,
} from "./site-release-static-trust-row.js";

const PRODUCER_COLUMNS = `producer_identity_ref AS "producerIdentityRef",
  producer_role AS "producerRole",producer_registration_ref AS "producerRegistrationRef",
  producer_registration_revision::text AS "producerRegistrationRevision",
  producer_registration_digest AS "producerRegistrationDigest",
  producer_registry_epoch::text AS "producerRegistryEpoch",
  trust_policy_ref AS "trustPolicyRef",trust_policy_revision::text AS "trustPolicyRevision",
  trust_policy_digest AS "trustPolicyDigest",trust_policy_epoch::text AS "trustPolicyEpoch",
  signing_key_id AS "signingKeyId",signing_key_version::text AS "signingKeyVersion",
  signing_key_fingerprint AS "signingKeyFingerprint",signature_domain AS "signatureDomain",
  environment,key_status AS "keyStatus",
  to_char(key_valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "keyValidFrom",
  to_char(key_valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "keyValidUntil",
  public_key_spki_pem AS "publicKeySpkiPem",configuration_digest AS "configurationDigest"`;

export class PostgresSiteReleaseEvidenceTrustAuthority
implements SiteReleaseEvidenceTrustAuthorityPort {
  async resolveProducer(
    transaction: Parameters<SiteReleaseEvidenceTrustAuthorityPort["resolveProducer"]>[0],
    input: Parameters<SiteReleaseEvidenceTrustAuthorityPort["resolveProducer"]>[1],
  ) {
    const rows = await resolvePlatformTransaction(transaction).query<ProducerTrustRow>(
      `SELECT ${PRODUCER_COLUMNS}
       FROM platform.site_release_producer_trust_revision
       WHERE producer_identity_ref=$1 AND producer_role='web-artifact-provenance-attestor'
         AND environment=$2 AND producer_registration_ref=$3
         AND producer_registration_revision=$4::numeric(20,0)
         AND producer_registration_digest=$5 AND signing_key_id=$6
         AND signing_key_version=$7::numeric(20,0)`,
      [input.producerIdentityRef, input.environment, input.producerRegistration.ref,
        input.producerRegistration.revision.toString(), input.producerRegistration.digest,
        input.signingKeyId, input.signingKeyVersion.toString()],
    );
    return decodeEvidenceProducerTrust(exactlyOne(rows, "SITE_EVIDENCE_PRODUCER_TRUST_NOT_FOUND"));
  }

  async resolveCheckers(
    transaction: Parameters<SiteReleaseEvidenceTrustAuthorityPort["resolveCheckers"]>[0],
    input: Parameters<SiteReleaseEvidenceTrustAuthorityPort["resolveCheckers"]>[1],
  ) {
    const rows = await resolvePlatformTransaction(transaction).query<CheckerTrustRow>(
      `SELECT environment,checker_role AS "checkerRole",checker_identity_ref AS "checkerIdentityRef",
              checker_registration_ref AS "checkerRegistrationRef",
              checker_registration_revision::text AS "checkerRegistrationRevision",
              checker_registration_digest AS "checkerRegistrationDigest",
              trust_policy_ref AS "trustPolicyRef",trust_policy_revision::text AS "trustPolicyRevision",
              trust_policy_digest AS "trustPolicyDigest",trust_policy_epoch::text AS "trustPolicyEpoch",
              signing_key_id AS "signingKeyId",signing_key_version::text AS "signingKeyVersion",
              signing_key_fingerprint AS "signingKeyFingerprint",signature_domain AS "signatureDomain",
              key_status AS "keyStatus",
              to_char(key_valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "keyValidFrom",
              to_char(key_valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "keyValidUntil",
              public_key_spki_pem AS "publicKeySpkiPem",configuration_digest AS "configurationDigest"
       FROM platform.site_release_checker_trust_revision
       WHERE environment=$1
       ORDER BY CASE checker_role WHEN 'artifact-inspection' THEN 1 WHEN 'journey' THEN 2 ELSE 3 END`,
      [input.environment],
    );
    if (rows.length !== 3) throw new Error("SITE_EVIDENCE_CHECKER_TRUST_SET_NOT_FOUND");
    return Object.freeze(rows.map(decodeEvidenceCheckerTrust));
  }
}
