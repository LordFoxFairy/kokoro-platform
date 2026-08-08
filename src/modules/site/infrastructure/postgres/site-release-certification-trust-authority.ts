import type { SiteReleaseCertificationTrustAuthorityPort } from
  "../../application/contracts/site-release-certification-trust.js";
import { resolveSiteReleaseTrustRow } from "./site-release-trust-authority-row.js";

export class PostgresSiteReleaseCertificationTrustAuthority
implements SiteReleaseCertificationTrustAuthorityPort {
  async resolve(
    transaction: Parameters<SiteReleaseCertificationTrustAuthorityPort["resolve"]>[0],
    input: Parameters<SiteReleaseCertificationTrustAuthorityPort["resolve"]>[1],
  ) {
    const row = await resolveSiteReleaseTrustRow(transaction, {
      subjectKind: "release-certification",
      subject: input.certification,
      producerIdentityRef: input.producerIdentityRef,
    });
    if (row.producerRole !== "release-certification-authority" ||
        row.signatureAudience !== "kokoro.site-release.activation.v1" ||
        row.evidenceDecisions.length !== 0) {
      throw new Error("SITE_CERTIFICATION_TRUST_AUTHORITY_INVALID");
    }
    return Object.freeze({
      producerRegistration: Object.freeze({
        ref: row.producerRegistration.ref,
        digest: row.producerRegistration.digest,
        epoch: row.producerRegistryEpoch,
      }),
      trustPolicy: Object.freeze({
        ref: row.trustPolicy.ref,
        digest: row.trustPolicy.digest,
        epoch: row.trustPolicyEpoch,
      }),
      keyId: row.signingKeyId,
      keyVersion: row.signingKeyVersion,
      publicKeyPem: row.publicKeyPem,
      publicKeyFingerprint: row.publicKeyFingerprint,
      keyStatus: row.keyStatus,
      keyValidFrom: row.keyValidFrom,
      keyValidUntil: row.keyValidUntil,
      signatureAudience: row.signatureAudience,
      environment: row.environment,
      detachedSignature: row.detachedSignature,
    });
  }
}
