import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from
  "node:crypto";
import { types as nodeTypes } from "node:util";
import type { MemoryContentProtectionPort, MemoryPayloadBinding } from
  "../../application/memory-authority-ports.js";
import { assertProtectedMemoryContent, createProtectedMemoryContent } from
  "../../domain/protected-memory-content.js";
import { memoryEntryRef, memoryProtectionKeyRevision, memoryRevisionRef, memorySiteRef,
  memorySpaceRef, type ProtectionKeyRevision } from "../../domain/memory-references.js";

const MAXIMUM_PLAINTEXT_BYTES = 16_384;
const MAXIMUM_KEY_RING_KEYS = 32;
const MAXIMUM_RETIRED_REVISIONS = 128;
const AAD_PREFIX = Buffer.from("kokoro.memory.payload.v1\0", "utf8");

export type MemoryContentKeyRing = Readonly<{
  version: 1;
  activeKeyRevision: ProtectionKeyRevision;
  keys: readonly Readonly<{
    keyRevision: ProtectionKeyRevision;
    status: "active" | "decrypt_only";
    key: Uint8Array;
  }>[];
  retiredKeyRevisions: readonly string[];
}>;

export function createMemoryContentProtector(value: unknown): MemoryContentProtectionPort {
  let ring: MemoryContentKeyRing;
  try { ring = validateKeyRing(value); }
  catch { throw safeError("MEMORY_CONTENT_KEY_RING_INVALID"); }
  const keys = new Map<ProtectionKeyRevision, Readonly<{
    status: "active" | "decrypt_only";
    key: Uint8Array;
  }>>();
  for (const item of ring.keys) keys.set(item.keyRevision,
    Object.freeze({ status: item.status, key: new Uint8Array(item.key) }));
  const retired = new Set(ring.retiredKeyRevisions);
  const activeRevision = ring.activeKeyRevision;

  return Object.freeze({
    async protect(input: Parameters<MemoryContentProtectionPort["protect"]>[0]) {
      const binding = validateBinding(input.binding);
      const plaintext = exactPlaintext(input.plaintext);
      const active = keys.get(activeRevision);
      if (active?.status !== "active") throw safeError("MEMORY_CONTENT_KEY_RING_INVALID");
      const nonce = randomBytes(12);
      const additionalData = aad(binding);
      const cipher = createCipheriv("aes-256-gcm", active.key, nonce, { authTagLength: 16 });
      cipher.setAAD(additionalData);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return createProtectedMemoryContent({ envelopeVersion: 1, keyRevision: activeRevision,
        nonce: Uint8Array.from(nonce), ciphertext: Uint8Array.from(ciphertext),
        authenticationTag: Uint8Array.from(cipher.getAuthTag()),
        aadDigest: createHash("sha256").update(additionalData).digest("hex") });
    },
    async reveal(input: Parameters<MemoryContentProtectionPort["reveal"]>[0]) {
      const binding = validateBinding(input.binding);
      try { assertProtectedMemoryContent(input.protectedContent); }
      catch { throw safeError("MEMORY_CONTENT_ENVELOPE_INVALID"); }
      const additionalData = aad(binding);
      const expectedAadDigest = createHash("sha256").update(additionalData).digest();
      const storedAadDigest = Buffer.from(input.protectedContent.aadDigest, "hex");
      if (storedAadDigest.byteLength !== expectedAadDigest.byteLength ||
        !timingSafeEqual(storedAadDigest, expectedAadDigest)) {
        throw safeError("MEMORY_CONTENT_AAD_MISMATCH");
      }
      const key = keys.get(input.protectedContent.keyRevision);
      if (key === undefined) {
        if (retired.has(input.protectedContent.keyRevision)) {
          throw safeError("MEMORY_CONTENT_KEY_RETIRED");
        }
        throw safeError("MEMORY_CONTENT_KEY_REVISION_UNKNOWN");
      }
      try {
        const decipher = createDecipheriv("aes-256-gcm", key.key,
          input.protectedContent.copyNonce(), { authTagLength: 16 });
        decipher.setAAD(additionalData);
        decipher.setAuthTag(input.protectedContent.copyAuthenticationTag());
        const plaintext = Buffer.concat([
          decipher.update(input.protectedContent.copyCiphertext()), decipher.final(),
        ]);
        if (plaintext.byteLength < 1 || plaintext.byteLength > MAXIMUM_PLAINTEXT_BYTES) {
          throw safeError("MEMORY_CONTENT_DECRYPTION_FAILED");
        }
        return Uint8Array.from(plaintext);
      } catch {
        throw safeError("MEMORY_CONTENT_DECRYPTION_FAILED");
      }
    },
  });
}

export function parseMemoryContentKeyRing(source: string): MemoryContentKeyRing {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > 32 * 1024) {
    throw safeError("MEMORY_CONTENT_KEY_RING_INVALID");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(source) as unknown; }
  catch { throw safeError("MEMORY_CONTENT_KEY_RING_INVALID"); }
  const record = exactRecord(parsed, ["version", "activeKeyRevision", "keys",
    "retiredKeyRevisions"]);
  if (!Array.isArray(record.keys)) throw safeError("MEMORY_CONTENT_KEY_RING_INVALID");
  const keys = record.keys.map((item) => {
    const keyRecord = exactRecord(item, ["keyRevision", "status", "keyBase64url"]);
    if (typeof keyRecord.keyBase64url !== "string") {
      throw safeError("MEMORY_CONTENT_KEY_RING_INVALID");
    }
    return Object.freeze({ keyRevision: keyRecord.keyRevision, status: keyRecord.status,
      key: canonicalKey(keyRecord.keyBase64url) });
  });
  return validateKeyRing({ version: record.version,
    activeKeyRevision: record.activeKeyRevision, keys,
    retiredKeyRevisions: record.retiredKeyRevisions });
}

function validateKeyRing(value: unknown): MemoryContentKeyRing {
  const record = exactRecord(value, ["version", "activeKeyRevision", "keys",
    "retiredKeyRevisions"]);
  if (record.version !== 1 || typeof record.activeKeyRevision !== "string" ||
    !Array.isArray(record.keys) || record.keys.length < 1 ||
    record.keys.length > MAXIMUM_KEY_RING_KEYS || !Array.isArray(record.retiredKeyRevisions) ||
    record.retiredKeyRevisions.length > MAXIMUM_RETIRED_REVISIONS) {
    throw safeError("MEMORY_CONTENT_KEY_RING_INVALID");
  }
  const activeKeyRevision = revision(record.activeKeyRevision);
  const seen = new Set<string>();
  const seenKeyDigests = new Set<string>();
  let activeCount = 0;
  const keys = record.keys.map((item) => {
    const keyRecord = exactRecord(item, ["keyRevision", "status", "key"]);
    const keyRevision = revision(keyRecord.keyRevision);
    if ((keyRecord.status !== "active" && keyRecord.status !== "decrypt_only") ||
      seen.has(keyRevision) || !exactKey(keyRecord.key)) {
      throw safeError("MEMORY_CONTENT_KEY_RING_INVALID");
    }
    seen.add(keyRevision);
    const keyDigest = createHash("sha256").update(keyRecord.key).digest("hex");
    if (seenKeyDigests.has(keyDigest)) throw safeError("MEMORY_CONTENT_KEY_RING_INVALID");
    seenKeyDigests.add(keyDigest);
    if (keyRecord.status === "active") activeCount += 1;
    return Object.freeze({ keyRevision, status: keyRecord.status,
      key: new Uint8Array(keyRecord.key) });
  });
  const retiredKeyRevisions = record.retiredKeyRevisions.map((item) => revision(item));
  for (const keyRevision of retiredKeyRevisions) {
    if (seen.has(keyRevision)) throw safeError("MEMORY_CONTENT_KEY_RING_INVALID");
    seen.add(keyRevision);
  }
  const active = keys.find((item) => item.keyRevision === activeKeyRevision);
  if (activeCount !== 1 || active?.status !== "active") {
    throw safeError("MEMORY_CONTENT_KEY_RING_INVALID");
  }
  return Object.freeze({ version: 1, activeKeyRevision,
    keys: Object.freeze(keys), retiredKeyRevisions: Object.freeze(retiredKeyRevisions) });
}

function aad(binding: MemoryPayloadBinding): Buffer {
  const frames = [binding.siteRef, binding.spaceRef, binding.entryRef, binding.revisionRef]
    .map((value) => {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength);
    return Buffer.concat([length, bytes]);
  });
  return Buffer.concat([AAD_PREFIX, ...frames]);
}

function validateBinding(binding: MemoryPayloadBinding): MemoryPayloadBinding {
  try {
    return Object.freeze({ siteRef: memorySiteRef(binding.siteRef),
      spaceRef: memorySpaceRef(binding.spaceRef), entryRef: memoryEntryRef(binding.entryRef),
      revisionRef: memoryRevisionRef(binding.revisionRef) });
  } catch { throw safeError("MEMORY_CONTENT_BINDING_INVALID"); }
}

function exactPlaintext(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Uint8Array.prototype ||
    !(value.buffer instanceof ArrayBuffer) || value.byteLength < 1 ||
    value.byteLength > MAXIMUM_PLAINTEXT_BYTES) {
    throw safeError("MEMORY_CONTENT_PLAINTEXT_INVALID");
  }
  return new Uint8Array(value);
}

function exactKey(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && !nodeTypes.isProxy(value) &&
    Object.getPrototypeOf(value) === Uint8Array.prototype &&
    value.buffer instanceof ArrayBuffer && value.byteLength === 32;
}

function canonicalKey(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw safeError("MEMORY_CONTENT_KEY_RING_INVALID");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== value) {
    throw safeError("MEMORY_CONTENT_KEY_RING_INVALID");
  }
  return Uint8Array.from(decoded);
}

function revision(value: unknown): ProtectionKeyRevision {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw safeError("MEMORY_CONTENT_KEY_RING_INVALID");
  }
  return memoryProtectionKeyRevision(value);
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    nodeTypes.isProxy(value) || (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)) throw safeError("MEMORY_CONTENT_KEY_RING_INVALID");
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" ||
    !keys.includes(key))) throw safeError("MEMORY_CONTENT_KEY_RING_INVALID");
  return value as Readonly<Record<string, unknown>>;
}

function safeError(code: string): Error {
  return new Error(code);
}
