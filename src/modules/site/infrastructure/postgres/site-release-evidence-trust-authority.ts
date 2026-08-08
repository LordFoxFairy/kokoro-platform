import type { SiteReleaseEvidenceTrustAuthorityPort } from
  "../../application/contracts/site-release-evidence-trust.js";
import { resolveSiteReleaseTrustRow } from "./site-release-trust-authority-row.js";

export class PostgresSiteReleaseEvidenceTrustAuthority
implements SiteReleaseEvidenceTrustAuthorityPort {
  async resolve(
    transaction: Parameters<SiteReleaseEvidenceTrustAuthorityPort["resolve"]>[0],
    input: Parameters<SiteReleaseEvidenceTrustAuthorityPort["resolve"]>[1],
  ) {
    const row = await resolveSiteReleaseTrustRow(transaction, {
      subjectKind: "web-artifact-provenance",
      subject: input.provenanceBinding,
      producerIdentityRef: input.producerIdentityRef,
    });
    if (row.producerRole !== "web-artifact-provenance-attestor" ||
        row.signatureAudience !== "kokoro.web-artifact-provenance.v1") {
      throw new Error("SITE_EVIDENCE_TRUST_AUTHORITY_INVALID");
    }
    return Object.freeze({
      producerIdentityRef: row.producerIdentityRef,
      producerRole: row.producerRole,
      producerRegistration: row.producerRegistration,
      trustPolicy: row.trustPolicy,
      signingKeyId: row.signingKeyId,
      signingKeyVersion: row.signingKeyVersion,
      signatureAudience: row.signatureAudience,
      environment: row.environment,
      keyStatus: row.keyStatus,
      keyValidFrom: row.keyValidFrom,
      keyValidUntil: row.keyValidUntil,
      publicKeyPem: row.publicKeyPem,
      publicKeyFingerprint: row.publicKeyFingerprint,
      detachedSignature: row.detachedSignature,
      evidenceDecisions: row.evidenceDecisions,
    });
  }
}
