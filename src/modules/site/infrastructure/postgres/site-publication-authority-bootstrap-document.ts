import { createHash, createPublicKey } from "node:crypto";
import { z } from "zod";
import { canonicalDigest } from "../../../product-catalog/domain/canonical-product-document.js";
import {
  authorityReferenceSchema,
  canonicalInstantSchema,
  digestReferenceSchema,
  positiveDecimalSchema,
  prefixedDigestSchema,
  wireRevisionBindingSchema,
} from "./site-publication-authority-codecs.js";
import { siteEffectiveAccessSnapshotWireSchema } from
  "./site-effective-access-snapshot-authority.js";
import { DEPLOYMENT_ENVIRONMENTS } from "../../../../shared/deployment-environment.js";

const environmentSchema = z.enum(DEPLOYMENT_ENVIRONMENTS);
const effectiveAccessSchema = z.object({
  siteRef: authorityReferenceSchema,
  environment: environmentSchema,
  launchProductProfile: wireRevisionBindingSchema,
  productSurfaceCatalog: wireRevisionBindingSchema,
  snapshotDigest: prefixedDigestSchema,
  snapshot: siteEffectiveAccessSnapshotWireSchema,
}).strict().refine((value) => canonicalDigest(value.snapshot) === value.snapshotDigest);

const intentIssuerSchema = z.object({
  authorityRef: authorityReferenceSchema,
  authorityRevision: positiveDecimalSchema,
  authorityDigest: prefixedDigestSchema,
  siteRef: authorityReferenceSchema,
  environment: environmentSchema,
  webCompositionRegistry: wireRevisionBindingSchema,
  webBuildToolchain: wireRevisionBindingSchema,
  contractFloor: z.array(z.object({
    contractRef: authorityReferenceSchema,
    minimumMajor: positiveDecimalSchema,
  }).strict()).min(1).max(128).refine(uniqueBy("contractRef")),
  issuerRef: authorityReferenceSchema,
  producerRegistry: digestReferenceSchema,
  producerRegistryEpoch: positiveDecimalSchema,
  trustPolicy: digestReferenceSchema,
  trustPolicyEpoch: positiveDecimalSchema,
  signingKeyId: authorityReferenceSchema,
  keyVersion: positiveDecimalSchema,
  publicKeyFingerprint: prefixedDigestSchema,
  keyValidFrom: canonicalInstantSchema,
  keyValidUntil: canonicalInstantSchema,
}).strict().refine((value) => value.keyValidFrom < value.keyValidUntil);

const producerTrustSchema = z.object({
  producerIdentityRef: authorityReferenceSchema,
  producerRole: z.enum([
    "web-artifact-provenance-attestor",
    "release-certification-authority",
  ]),
  environment: environmentSchema,
  producerRegistration: wireRevisionBindingSchema,
  producerRegistryEpoch: positiveDecimalSchema,
  trustPolicy: wireRevisionBindingSchema,
  trustPolicyEpoch: positiveDecimalSchema,
  signingKeyId: authorityReferenceSchema,
  signingKeyVersion: positiveDecimalSchema,
  signatureAudience: z.enum([
    "kokoro.web-artifact-provenance.v1",
    "kokoro.site-release.activation.v1",
  ]),
  keyStatus: z.enum(["active", "revoked"]),
  keyValidFrom: canonicalInstantSchema,
  keyValidUntil: canonicalInstantSchema,
  publicKeyPem: z.string().min(64).max(16_384),
  publicKeyFingerprint: prefixedDigestSchema,
}).strict().superRefine((value, context) => {
  const audience = value.producerRole === "web-artifact-provenance-attestor"
    ? "kokoro.web-artifact-provenance.v1" : "kokoro.site-release.activation.v1";
  if (value.signatureAudience !== audience || value.keyValidFrom >= value.keyValidUntil ||
      !validPublicKey(value.publicKeyPem, value.publicKeyFingerprint)) {
    context.addIssue({ code: "custom", message: "producer trust tuple invalid" });
  }
});

const documentSchema = z.object({
  version: z.literal(1),
  effectiveAccess: z.array(effectiveAccessSchema).min(1).max(512),
  intentIssuers: z.array(intentIssuerSchema).min(1).max(512),
  producerTrust: z.array(producerTrustSchema).min(2).max(512),
}).strict().superRefine((value, context) => {
  const effectiveKeys = value.effectiveAccess.map((item) => [item.siteRef, item.environment,
    item.launchProductProfile.ref, item.launchProductProfile.revision,
    item.productSurfaceCatalog.ref, item.productSurfaceCatalog.revision].join("\0"));
  const issuerKeys = value.intentIssuers.map((item) => `${item.siteRef}\0${item.environment}`);
  const trustKeys = value.producerTrust.map((item) => [item.producerIdentityRef, item.producerRole,
    item.environment, item.signingKeyId, item.signingKeyVersion].join("\0"));
  if (!unique(effectiveKeys) || !unique(issuerKeys) || !unique(trustKeys) ||
      value.effectiveAccess.some((item) => !issuerKeys.includes(`${item.siteRef}\0${item.environment}`))) {
    context.addIssue({ code: "custom", message: "duplicate or missing authority head" });
  }
  for (const environment of new Set(value.intentIssuers.map(({ environment }) => environment))) {
    const roles = new Set(value.producerTrust.filter((item) => item.environment === environment)
      .map(({ producerRole }) => producerRole));
    if (!roles.has("web-artifact-provenance-attestor") ||
        !roles.has("release-certification-authority")) {
      context.addIssue({ code: "custom", message: "producer trust role missing" });
    }
  }
});

export type SitePublicationAuthorityBootstrapDocument = z.infer<typeof documentSchema>;

export function parseSitePublicationAuthorityBootstrapDocument(
  value: unknown,
): SitePublicationAuthorityBootstrapDocument {
  const result = documentSchema.safeParse(value);
  if (!result.success) throw new Error("SITE_PUBLICATION_AUTHORITY_BOOTSTRAP_DOCUMENT_INVALID");
  return result.data;
}

function validPublicKey(pem: string, expectedFingerprint: string): boolean {
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "ed25519") return false;
    const fingerprint = `sha256:${createHash("sha256").update(key.export({
      format: "der", type: "spki",
    })).digest("hex")}`;
    return fingerprint === expectedFingerprint;
  } catch {
    return false;
  }
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}
function uniqueBy<Key extends string>(key: Key) {
  return (values: readonly Record<Key, string>[]): boolean => unique(values.map((value) => value[key]));
}
