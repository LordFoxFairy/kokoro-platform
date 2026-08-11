import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { RedemptionCodeIssuancePort, RedemptionSecretPort } from "../../application/contracts/redemption-secret-port.js";
import { RedemptionInputError } from "../../domain/redemption-input-error.js";
import { commerceCanonicalJson } from "../../domain/canonical-json.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KEY_REVISION = /^[A-Za-z0-9_-]{1,64}$/u;
const CODE = /^KC1-([0-9A-HJKMNP-TV-Z]{8})-([0-9A-HJKMNP-TV-Z]{10})-([0-9A-HJKMNP-TV-Z]{32})-([0-9A-HJKMNP-TV-Z]{8})$/u;

export type RedemptionHmacKey = Readonly<{ keyRevision: string; key: Uint8Array }>;

export type RedemptionSecretCodecConfig = Readonly<{
  currentCodeLookupKeyRevision: string;
  codeLookupKeys: readonly RedemptionHmacKey[];
  currentPreviewCredentialKeyRevision: string;
  previewCredentialKeys: readonly RedemptionHmacKey[];
  requestAuditKey: Uint8Array;
}>;

export type RedemptionEntropySource = () => Uint8Array;

export function createRedemptionSecretCodec(
  config: RedemptionSecretCodecConfig,
  dependencies: Readonly<{ entropySource?: RedemptionEntropySource }> = {},
): RedemptionSecretPort & RedemptionCodeIssuancePort {
  const codeKeys = keyMap(config.codeLookupKeys, config.currentCodeLookupKeyRevision);
  const previewKeys = keyMap(config.previewCredentialKeys, config.currentPreviewCredentialKeyRevision);
  const auditKey = ownedKey(config.requestAuditKey);
  const entropySource = dependencies.entropySource ?? (() => randomBytes(20));
  const codeSelectors = new Map([...codeKeys].map(([revision, key]) => [selector(revision, 8), [revision, key] as const]));
  if (codeSelectors.size !== codeKeys.size) throw new Error("REDEMPTION_KEY_SELECTOR_COLLISION");

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
    issueCode(siteId: string, batchRef: string) {
      bounded(siteId, 256, "REDEMPTION_SITE_INVALID");
      if (!UUID.test(batchRef)) throw new Error("REDEMPTION_BATCH_REF_INVALID");
      const keyRevision = config.currentCodeLookupKeyRevision;
      const keySelector = selector(keyRevision, 8);
      const batchSelector = selector(batchRef, 10);
      const entropy = Uint8Array.from(entropySource());
      if (entropy.byteLength !== 20) throw new Error("REDEMPTION_ENTROPY_INVALID");
      const payload = base32(entropy);
      const prefix = `KC1-${keySelector}-${batchSelector}-${payload}`;
      const code = `${prefix}-${selector(prefix, 8)}`;
      const normalized = normalizeCode(code);
      return Object.freeze({
        code, keyRevision, batchSelector,
        lookupDigest: hmac(codeKeys.get(keyRevision)!, "kokoro.commerce.code-lookup.v1", `${siteId}\0${normalized}`),
        safeFingerprint: `CODE-${hmac(auditKey, "kokoro.commerce.safe-code-fingerprint.v1", `${siteId}\0${normalized}`).slice(0, 16).toUpperCase()}`,
      });
    },
    codeLookupCandidates(code: string, siteId: string) {
      const normalized = normalizeCode(code);
      bounded(siteId, 256, "REDEMPTION_SITE_INVALID");
      const match = CODE.exec(normalized)!;
      const selected = codeSelectors.get(match[1]!);
      if (selected === undefined) throw new RedemptionInputError();
      const [keyRevision, key] = selected;
      return Object.freeze([Object.freeze({ keyRevision, batchSelector: match[2]!,
        lookupDigest: hmac(key, "kokoro.commerce.code-lookup.v1", `${siteId}\0${normalized}`) })]);
    },
    safeCodeFingerprint(code: string, siteId: string) {
      const normalized = normalizeCode(code);
      bounded(siteId, 256, "REDEMPTION_SITE_INVALID");
      return `CODE-${hmac(auditKey, "kokoro.commerce.safe-code-fingerprint.v1", `${siteId}\0${normalized}`).slice(0, 16).toUpperCase()}`;
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
    confirmRequestDigest(input: Readonly<{
      siteId: string;
      subjectId: string;
      subjectGeneration: string;
      previewCredential: string;
      legalAcceptanceRefs: readonly string[];
    }>) {
      bounded(input.siteId, 256, "REDEMPTION_SITE_INVALID");
      bounded(input.subjectId, 256, "REDEMPTION_SUBJECT_INVALID");
      if (!/^[1-9][0-9]*$/u.test(input.subjectGeneration)) throw new Error("REDEMPTION_SUBJECT_GENERATION_INVALID");
      if (input.previewCredential.length < 32 || input.previewCredential.length > 4096 || /\s/u.test(input.previewCredential)) {
        throw new Error("REDEMPTION_PREVIEW_CREDENTIAL_INVALID");
      }
      if (input.legalAcceptanceRefs.length > 16) throw new Error("REDEMPTION_LEGAL_ACCEPTANCE_INVALID");
      input.legalAcceptanceRefs.forEach((reference: string) => bounded(reference, 128, "REDEMPTION_LEGAL_ACCEPTANCE_INVALID"));
      return hmac(auditKey, "kokoro.commerce.confirm-request-audit.v1", commerceCanonicalJson({
        siteId: input.siteId,
        subjectId: input.subjectId,
        subjectGeneration: input.subjectGeneration,
        previewCredential: input.previewCredential,
        legalAcceptanceRefs: [...input.legalAcceptanceRefs].sort((left, right) => left.localeCompare(right, "en")),
      }));
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
  const normalized = value.normalize("NFKC").toUpperCase();
  const match = CODE.exec(normalized);
  if (match === null || selector(normalized.slice(0, normalized.lastIndexOf("-")), 8) !== match[4]) throw new RedemptionInputError();
  return normalized;
}

const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function base32(bytes: Uint8Array): string {
  let bits = 0; let buffer = 0; let output = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; output += BASE32[(buffer >>> bits) & 31]; }
  }
  if (bits > 0) output += BASE32[(buffer << (5 - bits)) & 31];
  return output;
}
function selector(value: string, length: number): string {
  return base32(createHash("sha256").update(value, "utf8").digest()).slice(0, length);
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
