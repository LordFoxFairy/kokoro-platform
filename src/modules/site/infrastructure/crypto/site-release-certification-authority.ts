import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import type { SiteReleaseCertificationAuthority } from
  "../../application/contracts/site-publication-ports.js";

interface CertificationKey {
  readonly signingKeyRef: string;
  readonly publicKey: KeyObject;
}

export class Ed25519SiteReleaseCertificationAuthority
  implements SiteReleaseCertificationAuthority
{
  readonly #keys: ReadonlyMap<string, KeyObject>;

  constructor(keys: readonly CertificationKey[]) {
    if (keys.length < 1 || keys.length > 32) {
      throw new Error("SITE_RELEASE_CERTIFICATION_KEYS_INVALID");
    }
    const entries = keys.map(({ signingKeyRef, publicKey }) => {
      identifier(signingKeyRef, "SITE_RELEASE_CERTIFICATION_KEY_REF_INVALID");
      if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
        throw new Error("SITE_RELEASE_CERTIFICATION_KEY_INVALID");
      }
      return [signingKeyRef, publicKey] as const;
    });
    if (new Set(entries.map(([keyRef]) => keyRef)).size !== entries.length) {
      throw new Error("SITE_RELEASE_CERTIFICATION_KEY_DUPLICATE");
    }
    this.#keys = new Map(entries);
  }

  async verify(
    input: Parameters<SiteReleaseCertificationAuthority["verify"]>[0],
  ): ReturnType<SiteReleaseCertificationAuthority["verify"]> {
    const key = this.#keys.get(input.proof.signingKeyRef);
    if (key === undefined) throw new Error("SITE_RELEASE_CERTIFICATION_KEY_UNKNOWN");
    const issuedAt = canonicalInstant(input.proof.issuedAt);
    const expiresAt = canonicalInstant(input.proof.expiresAt);
    if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
      throw new Error("SITE_RELEASE_CERTIFICATION_WINDOW_INVALID");
    }
    if (input.proof.signature.byteLength !== 64) {
      throw new Error("SITE_RELEASE_CERTIFICATION_SIGNATURE_INVALID");
    }
    const payload = canonicalCertificationPayload({
      ...input,
      proof: { signingKeyRef: input.proof.signingKeyRef, issuedAt, expiresAt },
    });
    const digest = createHash("sha256").update(payload).digest("hex");
    if (digest !== input.certificationDigest) {
      throw new Error("SITE_RELEASE_CERTIFICATION_DIGEST_INVALID");
    }
    const signed = Buffer.concat([
      Buffer.from("kokoro.site-release-certification.v1\0", "utf8"),
      Buffer.from(payload, "utf8"),
    ]);
    if (!verify(null, signed, key, input.proof.signature)) {
      throw new Error("SITE_RELEASE_CERTIFICATION_SIGNATURE_INVALID");
    }
    return Object.freeze({ status: "passed" as const, expiresAt });
  }
}

export function parseSiteReleaseCertificationKeys(input: unknown): readonly CertificationKey[] {
  const root = record(input, "SITE_RELEASE_CERTIFICATION_KEYS_INVALID");
  if (root.version !== 1 || !Array.isArray(root.keys) ||
      Object.keys(root).sort().join(",") !== "keys,version") {
    throw new Error("SITE_RELEASE_CERTIFICATION_KEYS_INVALID");
  }
  return Object.freeze(root.keys.map((candidate) => {
    const value = record(candidate, "SITE_RELEASE_CERTIFICATION_KEYS_INVALID");
    if (Object.keys(value).sort().join(",") !== "algorithm,publicKeyPem,signingKeyRef" ||
        value.algorithm !== "Ed25519" || typeof value.signingKeyRef !== "string" ||
        typeof value.publicKeyPem !== "string" || value.publicKeyPem.length > 8 * 1024) {
      throw new Error("SITE_RELEASE_CERTIFICATION_KEYS_INVALID");
    }
    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey(value.publicKeyPem);
    } catch {
      throw new Error("SITE_RELEASE_CERTIFICATION_KEY_INVALID");
    }
    return Object.freeze({ signingKeyRef: value.signingKeyRef, publicKey });
  }));
}

export function canonicalCertificationPayload(input: Readonly<{
  siteRef: string;
  releaseRef: string;
  webArtifactDigest: string;
  releaseManifestDigest: string;
  certificationDigest?: string;
  launchProfileRef: string;
  siteConfigRevisionRef: string;
  legalRevisionRef: string;
  featurePolicyRevision: string;
  modelOptionCatalogRef: string;
  agentCatalogRef: string;
  identityIssuerLabel: string;
  identityAuthStrengthPolicyRevision: string;
  enabledSurfaceIds: readonly string[];
  localePolicy: Readonly<{
    defaultLocale: string;
    allowedLocales: readonly string[];
  }>;
  proof: Readonly<{ signingKeyRef: string; issuedAt: string; expiresAt: string }>;
}>): string {
  const enabledSurfaceIds = canonicalStrings(
    input.enabledSurfaceIds,
    "SITE_RELEASE_CERTIFICATION_SURFACES_INVALID",
    1,
    64,
  );
  const allowedLocales = canonicalStrings(
    input.localePolicy.allowedLocales,
    "SITE_RELEASE_CERTIFICATION_LOCALES_INVALID",
    1,
    32,
  );
  if (!allowedLocales.includes(input.localePolicy.defaultLocale)) {
    throw new Error("SITE_RELEASE_CERTIFICATION_DEFAULT_LOCALE_INVALID");
  }
  return stableJson({
    schemaVersion: 1,
    siteRef: identifier(input.siteRef, "SITE_RELEASE_CERTIFICATION_SITE_INVALID"),
    releaseRef: identifier(input.releaseRef, "SITE_RELEASE_CERTIFICATION_RELEASE_INVALID"),
    webArtifactDigest: digest(input.webArtifactDigest),
    releaseManifestDigest: digest(input.releaseManifestDigest),
    launchProfileRef: identifier(
      input.launchProfileRef,
      "SITE_RELEASE_CERTIFICATION_LAUNCH_PROFILE_INVALID",
    ),
    siteConfigRevisionRef: identifier(
      input.siteConfigRevisionRef,
      "SITE_RELEASE_CERTIFICATION_SITE_CONFIG_INVALID",
    ),
    legalRevisionRef: identifier(
      input.legalRevisionRef,
      "SITE_RELEASE_CERTIFICATION_LEGAL_INVALID",
    ),
    featurePolicyRevision: identifier(
      input.featurePolicyRevision,
      "SITE_RELEASE_CERTIFICATION_FEATURE_POLICY_INVALID",
    ),
    modelOptionCatalogRef: identifier(
      input.modelOptionCatalogRef,
      "SITE_RELEASE_CERTIFICATION_MODEL_CATALOG_INVALID",
    ),
    agentCatalogRef: identifier(
      input.agentCatalogRef,
      "SITE_RELEASE_CERTIFICATION_AGENT_CATALOG_INVALID",
    ),
    identityIssuerLabel: boundedText(
      input.identityIssuerLabel,
      1,
      64,
      "SITE_RELEASE_CERTIFICATION_IDENTITY_ISSUER_INVALID",
    ),
    identityAuthStrengthPolicyRevision: identifier(
      input.identityAuthStrengthPolicyRevision,
      "SITE_RELEASE_CERTIFICATION_IDENTITY_POLICY_INVALID",
    ),
    enabledSurfaceIds,
    localePolicy: {
      defaultLocale: boundedText(
        input.localePolicy.defaultLocale,
        1,
        64,
        "SITE_RELEASE_CERTIFICATION_DEFAULT_LOCALE_INVALID",
      ),
      allowedLocales,
    },
    signingKeyRef: identifier(
      input.proof.signingKeyRef,
      "SITE_RELEASE_CERTIFICATION_KEY_REF_INVALID",
    ),
    issuedAt: canonicalInstant(input.proof.issuedAt),
    expiresAt: canonicalInstant(input.proof.expiresAt),
  });
}

function canonicalInstant(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error("SITE_RELEASE_CERTIFICATION_INSTANT_INVALID");
  }
  return value;
}

function identifier(value: string, code: string): string {
  if (value.length < 3 || value.length > 256 ||
      Array.from(value).some((character) => (character.codePointAt(0) ?? 0) < 32)) {
    throw new Error(code);
  }
  return value;
}

function digest(value: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error("SITE_RELEASE_CERTIFICATION_DIGEST_INVALID");
  return value;
}

function canonicalStrings(
  values: readonly string[],
  code: string,
  minimum: number,
  maximum: number,
): readonly string[] {
  if (!Array.isArray(values) || values.length < minimum || values.length > maximum ||
      values.some((value) => typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)) ||
      new Set(values).size !== values.length) {
    throw new Error(code);
  }
  return Object.freeze([...values].sort());
}

function boundedText(
  value: string,
  minimum: number,
  maximum: number,
  code: string,
): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum ||
      Array.from(value).some((character) => {
        const point = character.codePointAt(0) ?? 0;
        return point < 32 || point === 127;
      })) throw new Error(code);
  return value;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}
