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
  proof: Readonly<{ signingKeyRef: string; issuedAt: string; expiresAt: string }>;
}>): string {
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
