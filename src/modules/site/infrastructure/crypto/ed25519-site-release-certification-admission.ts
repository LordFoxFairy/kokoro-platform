import { createHash, createPublicKey, verify } from "node:crypto";
import { canonicalJson, verifyCanonicalDocument } from
  "../../../product-catalog/domain/canonical-product-document.js";
import { validateReleaseCertificationShape } from
  "../../../../generated/schema/site-publication/validator.js";
import type {
  SitePublicationDocumentResolver,
  SiteReleaseCertificationAdmissionPort,
} from "../../application/contracts/site-publication-authority-ports.js";
import type { SiteReleaseCertificationTrustAuthorityPort } from
  "../../application/contracts/site-release-certification-trust.js";

const payloadType = "application/vnd.kokoro.release-certification-instance.v1+json";

export class Ed25519SiteReleaseCertificationAdmission
implements SiteReleaseCertificationAdmissionPort {
  constructor(
    private readonly documents: Pick<SitePublicationDocumentResolver, "resolve">,
    private readonly authority: SiteReleaseCertificationTrustAuthorityPort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async verify(
    transaction: Parameters<SiteReleaseCertificationAdmissionPort["verify"]>[0],
    input: Parameters<SiteReleaseCertificationAdmissionPort["verify"]>[1],
  ) {
    const source = await this.documents.resolve({ kind: "release-certification", binding: input.binding });
    const verified = verifyCanonicalDocument(source);
    if (!validateReleaseCertificationShape(verified.parsedDocument)) {
      throw new Error("SITE_CERTIFICATION_SCHEMA_INVALID");
    }
    const document = object(verified.parsedDocument);
    const producer = object(document.producer);
    const producerIdentityRef = text(producer.producerIdentityRef);
    const trust = await this.authority.resolve(transaction, {
      certification: input.binding,
      producerIdentityRef,
    });
    if (document.environment !== input.candidate.environment || trust.environment !== input.candidate.environment ||
        trust.signatureAudience !== "kokoro.site-release.activation.v1" || trust.keyStatus !== "active" ||
        producer.signatureAudience !== trust.signatureAudience || producer.environment !== trust.environment ||
        producer.keyId !== trust.keyId || decimal(producer.keyVersion) !== trust.keyVersion ||
        producer.publicKeyFingerprint !== trust.publicKeyFingerprint) {
      throw new Error("SITE_CERTIFICATION_PRODUCER_NOT_AUTHORIZED");
    }
    exactDigestRef(producer.producerRegistry, trust.producerRegistration);
    exactDigestRef(producer.trustPolicy, trust.trustPolicy);
    if (decimal(producer.producerRegistryEpoch) !== trust.producerRegistration.epoch ||
        decimal(producer.trustPolicyEpoch) !== trust.trustPolicy.epoch) {
      throw new Error("SITE_CERTIFICATION_TRUST_EPOCH_MISMATCH");
    }
    const now = instant(this.now());
    const generatedAt = instant(text(document.generatedAt));
    if (now < instant(trust.keyValidFrom) || now >= instant(trust.keyValidUntil) ||
        producer.keyValidFrom !== trust.keyValidFrom || producer.keyValidUntil !== trust.keyValidUntil ||
        generatedAt > now || generatedAt < trust.keyValidFrom ||
        now >= instant(text(document.validUntil)) || decimal(document.certificationRevocationEpoch) !== 0n) {
      throw new Error("SITE_CERTIFICATION_NOT_LIVE");
    }
    const key = createPublicKey(trust.publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("SITE_CERTIFICATION_KEY_INVALID");
    const fingerprint = `sha256:${createHash("sha256").update(key.export({
      format: "der",
      type: "spki",
    })).digest("hex")}`;
    if (fingerprint !== trust.publicKeyFingerprint ||
        !verify(null, pae(Buffer.from(canonicalJson(verified.parsedDocument), "utf8")), key,
          trust.detachedSignature)) {
      throw new Error("SITE_CERTIFICATION_SIGNATURE_INVALID");
    }
    return verified;
  }
}

function pae(payload: Uint8Array): Buffer {
  const type = Buffer.from(payloadType, "utf8");
  return Buffer.concat([Buffer.from(`DSSEv1 ${type.byteLength} `, "ascii"), type,
    Buffer.from(` ${payload.byteLength} `, "ascii"), payload]);
}
function exactDigestRef(value: unknown, expected: Readonly<{ ref: string; digest: string }>): void {
  const actual = object(value);
  if (actual.ref !== expected.ref || actual.digest !== expected.digest) {
    throw new Error("SITE_CERTIFICATION_TRUST_BINDING_MISMATCH");
  }
}
function object(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SITE_CERTIFICATION_DOCUMENT_INVALID");
  }
  return value as Readonly<Record<string, unknown>>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("SITE_CERTIFICATION_TEXT_INVALID");
  return value;
}
function decimal(value: unknown): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("SITE_CERTIFICATION_DECIMAL_INVALID");
  }
  return BigInt(value);
}
function instant(value: string): string {
  if (!/^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u.test(value) ||
      new Date(value).toISOString() !== value) throw new Error("SITE_CERTIFICATION_TIME_INVALID");
  return value;
}
