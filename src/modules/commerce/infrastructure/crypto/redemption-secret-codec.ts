import { createHmac, timingSafeEqual } from "node:crypto";
import type { RedemptionSecretPort } from "../../application/contracts/redemption-secret-port.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KEY_REVISION = /^[A-Za-z0-9_-]{1,64}$/u;
const CODE = /^[A-Z0-9]{16,256}$/u;

export type RedemptionHmacKey = Readonly<{ keyRevision: string; key: Uint8Array }>;

export type RedemptionSecretCodecConfig = Readonly<{
  currentCodeLookupKeyRevision: string;
  codeLookupKeys: readonly RedemptionHmacKey[];
  currentPreviewCredentialKeyRevision: string;
  previewCredentialKeys: readonly RedemptionHmacKey[];
  requestAuditKey: Uint8Array;
}>;

export function createRedemptionSecretCodec(config: RedemptionSecretCodecConfig): RedemptionSecretPort {
  const codeKeys = keyMap(config.codeLookupKeys, config.currentCodeLookupKeyRevision);
  const previewKeys = keyMap(config.previewCredentialKeys, config.currentPreviewCredentialKeyRevision);
  const auditKey = ownedKey(config.requestAuditKey);
  const orderedCodeKeys = Object.freeze([
    [config.currentCodeLookupKeyRevision, codeKeys.get(config.currentCodeLookupKeyRevision)!] as const,
    ...[...codeKeys.entries()]
      .filter(([revision]) => revision !== config.currentCodeLookupKeyRevision)
      .sort(([left], [right]) => left.localeCompare(right, "en")),
  ]);

  function previewCredential(previewRef: string, keyRevision: string = config.currentPreviewCredentialKeyRevision): string {
    if (!UUID.test(previewRef)) throw new Error("REDEMPTION_PREVIEW_REF_INVALID");
    if (!KEY_REVISION.test(keyRevision)) throw new Error("REDEMPTION_PREVIEW_KEY_REVISION_INVALID");
    const key = previewKeys.get(keyRevision);
    if (key === undefined) throw new Error("REDEMPTION_PREVIEW_KEY_RETIRED");
    const mac = hmac(key, "kokoro.commerce.preview-capability.v1", `${keyRevision}\0${previewRef}`, "base64url");
    return `kpv1.${keyRevision}.${previewRef}.${mac}`;
  }

  return Object.freeze({
    currentCodeLookupKeyRevision: config.currentCodeLookupKeyRevision,
    codeLookupCandidates(code: string, siteId: string) {
      const normalized = normalizeCode(code);
      bounded(siteId, 256, "REDEMPTION_SITE_INVALID");
      return Object.freeze(orderedCodeKeys.map(([keyRevision, key]) => Object.freeze({
        keyRevision,
        lookupDigest: hmac(key, "kokoro.commerce.code-lookup.v1", `${siteId}\0${normalized}`),
      })));
    },
    safeCodeFingerprint(code: string) {
      const normalized = normalizeCode(code);
      return `CODE-${hmac(auditKey, "kokoro.commerce.safe-code-fingerprint.v1", normalized).slice(0, 16).toUpperCase()}`;
    },
    previewCredential,
    verifyPreviewCredential(credential: string) {
      if (credential.length < 32 || credential.length > 4096) return null;
      const match = /^kpv1\.([A-Za-z0-9_-]{1,64})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/u.exec(credential);
      if (match === null) return null;
      const [, revision, previewRef, presentedMac] = match;
      if (revision === undefined || previewRef === undefined || presentedMac === undefined || !UUID.test(previewRef)) return null;
      const key = previewKeys.get(revision);
      if (key === undefined) return null;
      const expected = hmac(key, "kokoro.commerce.preview-capability.v1", `${revision}\0${previewRef}`, "base64url");
      if (!equalAscii(presentedMac, expected)) return null;
      return Object.freeze({
        keyRevision: revision,
        previewRef,
        credentialDigest: hmac(key, "kokoro.commerce.preview-credential-digest.v1", credential),
      });
    },
    previewRequestDigest(input: Readonly<{ siteId: string; subjectId: string; subjectGeneration: string; code: string }>) {
      bounded(input.siteId, 256, "REDEMPTION_SITE_INVALID");
      bounded(input.subjectId, 256, "REDEMPTION_SUBJECT_INVALID");
      if (!/^[1-9][0-9]*$/u.test(input.subjectGeneration)) throw new Error("REDEMPTION_SUBJECT_GENERATION_INVALID");
      return hmac(
        auditKey,
        "kokoro.commerce.preview-request-audit.v1",
        `${input.siteId}\0${input.subjectId}\0${input.subjectGeneration}\0${normalizeCode(input.code)}`,
      );
    },
  });
}

function keyMap(keys: readonly RedemptionHmacKey[], current: string): ReadonlyMap<string, Uint8Array> {
  if (!KEY_REVISION.test(current) || keys.length < 1 || keys.length > 16) throw new Error("REDEMPTION_KEY_RING_INVALID");
  const result = new Map<string, Uint8Array>();
  for (const item of keys) {
    if (!KEY_REVISION.test(item.keyRevision) || result.has(item.keyRevision)) throw new Error("REDEMPTION_KEY_RING_INVALID");
    result.set(item.keyRevision, ownedKey(item.key));
  }
  if (!result.has(current)) throw new Error("REDEMPTION_CURRENT_KEY_MISSING");
  return result;
}

function ownedKey(key: Uint8Array): Uint8Array {
  if (key.byteLength !== 32) throw new Error("REDEMPTION_HMAC_KEY_INVALID");
  return Uint8Array.from(key);
}

function normalizeCode(value: string): string {
  const normalized = value.normalize("NFKC").toUpperCase().replaceAll("-", "");
  if (!CODE.test(normalized)) throw new Error("REDEEM_NOT_ACCEPTED");
  return normalized;
}

function hmac(key: Uint8Array, domain: string, value: string, encoding: "hex" | "base64url" = "hex"): string {
  return createHmac("sha256", key).update(domain, "utf8").update("\0", "utf8").update(value, "utf8").digest(encoding);
}

function equalAscii(left: string, right: string): boolean {
  const a = Buffer.from(left, "ascii");
  const b = Buffer.from(right, "ascii");
  return a.length === b.length && timingSafeEqual(a, b);
}

function bounded(value: string, maximum: number, code: string): void {
  if (value.length < 1 || value.length > maximum || [...value].some((character) => (character.codePointAt(0) ?? 0) < 32)) {
    throw new Error(code);
  }
}
