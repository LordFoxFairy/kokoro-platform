import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";
import { MemoryDomainError } from "./memory-error.js";
import { memoryDigest, memoryProtectionKeyRevision, type MemoryDigest,
  type ProtectionKeyRevision } from "./memory-references.js";
import { snapshotExactMemoryRecord } from "./runtime-validation.js";

export type ProtectedMemoryContent = Readonly<{
  envelopeVersion: 1;
  keyRevision: ProtectionKeyRevision;
  aadDigest: MemoryDigest;
  copyNonce(): Uint8Array;
  copyCiphertext(): Uint8Array;
  copyAuthenticationTag(): Uint8Array;
}>;

type ValidatedProtectedContent = Readonly<{
  envelopeVersion: 1;
  keyRevision: ProtectionKeyRevision;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  authenticationTag: Uint8Array;
  aadDigest: MemoryDigest;
}>;

const constructionToken = Symbol("memory-protected-content-construction");
const protectedContentBytes = new WeakMap<object, Readonly<{
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  authenticationTag: Uint8Array;
}>>();

class SealedProtectedMemoryContent implements ProtectedMemoryContent {
  readonly envelopeVersion: 1;
  readonly keyRevision: ProtectionKeyRevision;
  readonly aadDigest: MemoryDigest;
  readonly #nonce: Uint8Array;
  readonly #ciphertext: Uint8Array;
  readonly #authenticationTag: Uint8Array;

  constructor(token: symbol, value: unknown) {
    if (token !== constructionToken) throw invalid();
    const validated = validateAndCopyProtectedMemoryContent(value);
    this.envelopeVersion = validated.envelopeVersion;
    this.keyRevision = validated.keyRevision;
    this.aadDigest = validated.aadDigest;
    this.#nonce = new Uint8Array(validated.nonce);
    this.#ciphertext = new Uint8Array(validated.ciphertext);
    this.#authenticationTag = new Uint8Array(validated.authenticationTag);
    protectedContentBytes.set(this, Object.freeze({ nonce: this.#nonce,
      ciphertext: this.#ciphertext, authenticationTag: this.#authenticationTag }));
    Object.freeze(this);
  }

  copyNonce(): Uint8Array { return new Uint8Array(this.#nonce); }
  copyCiphertext(): Uint8Array { return new Uint8Array(this.#ciphertext); }
  copyAuthenticationTag(): Uint8Array { return new Uint8Array(this.#authenticationTag); }
}

Object.freeze(SealedProtectedMemoryContent.prototype);
Object.freeze(SealedProtectedMemoryContent);

export function createProtectedMemoryContent(value: unknown): ProtectedMemoryContent {
  return new SealedProtectedMemoryContent(constructionToken, value);
}

export function assertProtectedMemoryContent(value: unknown): asserts value is ProtectedMemoryContent {
  if (typeof value !== "object" || value === null || !protectedContentBytes.has(value)) throw invalid();
}

export function protectedMemoryContentDigestMetadata(value: unknown): Readonly<{
  envelopeVersion: bigint;
  keyRevision: ProtectionKeyRevision;
  aadDigest: MemoryDigest;
  nonceDigest: MemoryDigest;
  ciphertextLength: bigint;
  ciphertextDigest: MemoryDigest;
  authenticationTagDigest: MemoryDigest;
}> {
  assertProtectedMemoryContent(value);
  const bytes = protectedContentBytes.get(value as object);
  if (bytes === undefined) throw invalid();
  return Object.freeze({ envelopeVersion: BigInt(value.envelopeVersion),
    keyRevision: value.keyRevision, aadDigest: value.aadDigest,
    nonceDigest: digest(bytes.nonce), ciphertextLength: BigInt(bytes.ciphertext.byteLength),
    ciphertextDigest: digest(bytes.ciphertext),
    authenticationTagDigest: digest(bytes.authenticationTag) });
}

function validateAndCopyProtectedMemoryContent(value: unknown): ValidatedProtectedContent {
  const record = snapshotExactMemoryRecord(value, ["envelopeVersion", "keyRevision", "nonce",
    "ciphertext", "authenticationTag", "aadDigest"], "MEMORY_PROTECTED_CONTENT_INVALID");
  if (record.envelopeVersion !== 1) throw invalid();
  return Object.freeze({ envelopeVersion: 1,
    keyRevision: memoryProtectionKeyRevision(record.keyRevision),
    nonce: exactBytes(record.nonce, 12, 12), ciphertext: exactBytes(record.ciphertext, 1, 16_384),
    authenticationTag: exactBytes(record.authenticationTag, 16, 16),
    aadDigest: memoryDigest(record.aadDigest) });
}

function exactBytes(value: unknown, minimum: number, maximum: number): Uint8Array {
  if (!(value instanceof Uint8Array) || nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Uint8Array.prototype ||
    !(value.buffer instanceof ArrayBuffer) || value.byteLength < minimum ||
    value.byteLength > maximum) throw invalid();
  return new Uint8Array(value);
}

function digest(value: Uint8Array): MemoryDigest {
  return memoryDigest(createHash("sha256").update(value).digest("hex"));
}

function invalid(): MemoryDomainError {
  return new MemoryDomainError("MEMORY_PROTECTED_CONTENT_INVALID");
}
