import { createHash, createPublicKey, verify } from "node:crypto";
import { canonicalJson } from "../../../product-catalog/domain/canonical-product-document.js";
import type {
  SiteReleaseEvidenceTrustAuthorityPort,
  SiteReleaseEvidenceTrustPort,
} from "../../application/contracts/site-release-evidence-trust.js";
import type { ImmutableRevisionBinding } from "../../domain/site-publication-authority.js";

const payloadType = "application/vnd.in-toto+json";

export class Ed25519SiteReleaseEvidenceTrust implements SiteReleaseEvidenceTrustPort {
  constructor(
    private readonly authority: SiteReleaseEvidenceTrustAuthorityPort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async verify(
    transaction: Parameters<SiteReleaseEvidenceTrustPort["verify"]>[0],
    input: Parameters<SiteReleaseEvidenceTrustPort["verify"]>[1],
  ) {
    const resolved = await this.authority.resolve(transaction, input);
    if (resolved.producerIdentityRef !== input.producerIdentityRef ||
        resolved.producerRole !== "web-artifact-provenance-attestor" ||
        resolved.environment !== input.candidate.environment ||
        resolved.signatureAudience !== "kokoro.web-artifact-provenance.v1" ||
        resolved.keyStatus !== "active") {
      throw new Error("SITE_EVIDENCE_PRODUCER_NOT_AUTHORIZED");
    }
    const now = instant(this.now());
    if (now < instant(resolved.keyValidFrom) || now >= instant(resolved.keyValidUntil)) {
      throw new Error("SITE_EVIDENCE_SIGNING_KEY_INACTIVE");
    }
    const key = createPublicKey(resolved.publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("SITE_EVIDENCE_SIGNING_KEY_INVALID");
    const fingerprint = `sha256:${createHash("sha256").update(key.export({
      format: "der",
      type: "spki",
    })).digest("hex")}`;
    if (fingerprint !== resolved.publicKeyFingerprint) {
      throw new Error("SITE_EVIDENCE_SIGNING_KEY_FINGERPRINT_MISMATCH");
    }
    const payload = Buffer.from(canonicalJson(input.provenanceStatement), "utf8");
    if (!verify(null, pae(payloadType, payload), key, resolved.detachedSignature)) {
      throw new Error("SITE_EVIDENCE_PROVENANCE_SIGNATURE_INVALID");
    }
    const expected = [input.artifactInspectionEvidence, input.journeyEvidence,
      input.securityEvidence];
    if (resolved.evidenceDecisions.length !== expected.length || expected.some((binding) =>
      !resolved.evidenceDecisions.some((decision) => decision.decision === "passed" &&
        sameRevision(decision.binding, binding)))) {
      throw new Error("SITE_EVIDENCE_REQUIRED_CHECK_FAILED");
    }
    return Object.freeze({
      producerRegistration: resolved.producerRegistration,
      trustPolicy: resolved.trustPolicy,
      signingKeyId: resolved.signingKeyId,
      signingKeyVersion: resolved.signingKeyVersion,
      signatureAudience: resolved.signatureAudience,
    });
  }
}

function pae(type: string, payload: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "utf8");
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${typeBytes.byteLength} `, "ascii"),
    typeBytes,
    Buffer.from(` ${payload.byteLength} `, "ascii"),
    payload,
  ]);
}
function sameRevision(left: ImmutableRevisionBinding, right: ImmutableRevisionBinding): boolean {
  return left.ref === right.ref && left.revision === right.revision && left.digest === right.digest;
}
function instant(value: string): string {
  if (!/^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u.test(value) ||
      new Date(value).toISOString() !== value) throw new Error("SITE_EVIDENCE_TIME_INVALID");
  return value;
}
