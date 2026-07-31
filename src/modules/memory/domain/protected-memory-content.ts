import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";
import { MemoryDomainError } from "./memory-error.js";
import { memoryDigest, memoryProtectionKeyRevision, type MemoryDigest,
  type ProtectionKeyRevision } from "./memory-references.js";
import { snapshotExactMemoryRecord } from "./runtime-validation.js";

export type ProtectedMemoryContent = Readonly<{
  keyRevision: ProtectionKeyRevision;
  envelopeDigest: MemoryDigest;
  copyCiphertext(): Uint8Array;
}>;

type ValidatedProtectedContent = Readonly<{
  ciphertext: Uint8Array;
  keyRevision: ProtectionKeyRevision;
  envelopeDigest: MemoryDigest;
}>;

const constructionToken = Symbol("memory-protected-content-construction");
const protectedContentBytes = new WeakMap<object, Uint8Array>();

class SealedProtectedMemoryContent implements ProtectedMemoryContent {
  readonly keyRevision: ProtectionKeyRevision;
  readonly envelopeDigest: MemoryDigest;
  readonly #ciphertext: Uint8Array;

  constructor(token: symbol, value: unknown) {
    if (token !== constructionToken) throw new MemoryDomainError("MEMORY_PROTECTED_CONTENT_INVALID");
    const validated = validateAndCopyProtectedMemoryContent(value);
    this.#ciphertext = new Uint8Array(validated.ciphertext);
    this.keyRevision = validated.keyRevision;
    this.envelopeDigest = validated.envelopeDigest;
    protectedContentBytes.set(this, this.#ciphertext);
    Object.freeze(this);
  }

  copyCiphertext(): Uint8Array {
    return new Uint8Array(this.#ciphertext);
  }
}

Object.freeze(SealedProtectedMemoryContent.prototype);
Object.freeze(SealedProtectedMemoryContent);

export function createProtectedMemoryContent(value: unknown): ProtectedMemoryContent {
  const validated = validateAndCopyProtectedMemoryContent(value);
  return new SealedProtectedMemoryContent(constructionToken, validated);
}

export function assertProtectedMemoryContent(value: unknown): asserts value is ProtectedMemoryContent {
  if (typeof value !== "object" || value === null || !protectedContentBytes.has(value)) {
    throw new MemoryDomainError("MEMORY_PROTECTED_CONTENT_INVALID");
  }
}

export function protectedMemoryContentDigestMetadata(value: unknown): Readonly<{
  keyRevision: ProtectionKeyRevision;
  envelopeDigest: MemoryDigest;
  ciphertextLength: bigint;
  ciphertextDigest: MemoryDigest;
}> {
  assertProtectedMemoryContent(value);
  const ciphertext = protectedContentBytes.get(value as object);
  if (ciphertext === undefined) throw new MemoryDomainError("MEMORY_PROTECTED_CONTENT_INVALID");
  return Object.freeze({ keyRevision: value.keyRevision, envelopeDigest: value.envelopeDigest,
    ciphertextLength: BigInt(ciphertext.byteLength),
    ciphertextDigest: memoryDigest(createHash("sha256").update(ciphertext).digest("hex")) });
}

function validateAndCopyProtectedMemoryContent(value: unknown): ValidatedProtectedContent {
  const record = snapshotExactMemoryRecord(value, ["ciphertext", "keyRevision", "envelopeDigest"],
    "MEMORY_PROTECTED_CONTENT_INVALID");
  const ciphertext = record.ciphertext;
  if (!(ciphertext instanceof Uint8Array) || nodeTypes.isProxy(ciphertext) ||
    Object.getPrototypeOf(ciphertext) !== Uint8Array.prototype ||
    !(ciphertext.buffer instanceof ArrayBuffer) || ciphertext.byteLength < 1 ||
    ciphertext.byteLength > 65_536) {
    throw new MemoryDomainError("MEMORY_PROTECTED_CONTENT_INVALID");
  }
  return Object.freeze({ ciphertext: new Uint8Array(ciphertext),
    keyRevision: memoryProtectionKeyRevision(record.keyRevision),
    envelopeDigest: memoryDigest(record.envelopeDigest) });
}
