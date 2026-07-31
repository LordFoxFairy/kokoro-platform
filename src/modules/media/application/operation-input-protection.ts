import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";

const DEFAULT_MAXIMUM_PLAINTEXT_BYTES = 64 * 1024;
const AES_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const DIGEST_DOMAIN = "kokoro.platform.media.owner-request-digest.v1\0";
const INPUT_AAD_DOMAIN = "kokoro.platform.media.operation-input.v1\0";
const WRAP_AAD_DOMAIN = "kokoro.platform.media.operation-input.dek-wrap.v1\0";

export type MediaOperationSource = "direct_studio" | "agent_runtime";

export type MediaOperationOwnerBinding = Readonly<{
  siteRef: string;
  subjectRef: string;
  subjectGeneration: bigint;
  projectRef: string;
  workloadRef: string;
  source: MediaOperationSource;
  definitionRevisionRef: string;
  modelOptionRevisionRef: string;
}>;

export type ProtectedOperationInputRevision = Readonly<{
  operationInputRevisionRef: string;
  encryptionAlgorithm: "AES-256-GCM-envelope-v1";
  keyRevisionRef: string;
  ciphertextBase64: string;
  contentIvBase64: string;
  contentTagBase64: string;
  wrappedDekBase64: string;
  wrapIvBase64: string;
  wrapTagBase64: string;
  plaintextBytes: number;
}>;

export class EnvelopeOperationInputProtector {
  readonly #activeKey: Readonly<{ keyRevisionRef: string; key: Buffer }>;
  readonly #maximumPlaintextBytes: number;

  constructor(input: Readonly<{
    activeKey: Readonly<{ keyRevisionRef: string; key: Uint8Array }>;
    maximumPlaintextBytes?: number;
  }>) {
    assertReference(input.activeKey.keyRevisionRef, "MEDIA_INPUT_KEY_REVISION_INVALID");
    if (input.activeKey.key.byteLength !== AES_KEY_BYTES) {
      throw new Error("MEDIA_INPUT_KEK_INVALID");
    }
    const maximum = input.maximumPlaintextBytes ?? DEFAULT_MAXIMUM_PLAINTEXT_BYTES;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > DEFAULT_MAXIMUM_PLAINTEXT_BYTES) {
      throw new Error("MEDIA_INPUT_MAXIMUM_INVALID");
    }
    this.#activeKey = Object.freeze({
      keyRevisionRef: input.activeKey.keyRevisionRef,
      key: Buffer.from(input.activeKey.key),
    });
    this.#maximumPlaintextBytes = maximum;
  }

  protect(input: Readonly<{
    operationInputRevisionRef: string;
    ownerBinding: MediaOperationOwnerBinding;
    canonicalBytes: Uint8Array;
  }>): ProtectedOperationInputRevision {
    assertReference(input.operationInputRevisionRef, "MEDIA_INPUT_REVISION_REF_INVALID");
    const binding = snapshotOwnerBinding(input.ownerBinding);
    const plaintext = Buffer.from(input.canonicalBytes);
    if (plaintext.byteLength === 0) throw new Error("MEDIA_INPUT_EMPTY");
    if (plaintext.byteLength > this.#maximumPlaintextBytes) throw new Error("MEDIA_INPUT_TOO_LARGE");

    const dataEncryptionKey = randomBytes(AES_KEY_BYTES);
    try {
      const contentIv = randomBytes(GCM_IV_BYTES);
      const content = encryptGcm(dataEncryptionKey, contentIv, inputAad(input.operationInputRevisionRef, binding),
        plaintext);
      const wrapIv = randomBytes(GCM_IV_BYTES);
      const wrapped = encryptGcm(this.#activeKey.key, wrapIv,
        frame([WRAP_AAD_DOMAIN, this.#activeKey.keyRevisionRef, input.operationInputRevisionRef]),
        dataEncryptionKey);
      return Object.freeze({
        operationInputRevisionRef: input.operationInputRevisionRef,
        encryptionAlgorithm: "AES-256-GCM-envelope-v1" as const,
        keyRevisionRef: this.#activeKey.keyRevisionRef,
        ciphertextBase64: content.ciphertext.toString("base64"),
        contentIvBase64: contentIv.toString("base64"),
        contentTagBase64: content.tag.toString("base64"),
        wrappedDekBase64: wrapped.ciphertext.toString("base64"),
        wrapIvBase64: wrapIv.toString("base64"),
        wrapTagBase64: wrapped.tag.toString("base64"),
        plaintextBytes: plaintext.byteLength,
      });
    } finally {
      dataEncryptionKey.fill(0);
      plaintext.fill(0);
    }
  }

  open(input: Readonly<{
    protectedInput: ProtectedOperationInputRevision;
    ownerBinding: MediaOperationOwnerBinding;
  }>): Uint8Array {
    const protectedInput = snapshotProtectedInput(input.protectedInput, this.#maximumPlaintextBytes);
    const binding = snapshotOwnerBinding(input.ownerBinding);
    if (protectedInput.keyRevisionRef !== this.#activeKey.keyRevisionRef) {
      throw new Error("MEDIA_INPUT_KEY_REVISION_UNAVAILABLE");
    }
    try {
      const dek = decryptGcm(
        this.#activeKey.key,
        decodeExactBase64(protectedInput.wrapIvBase64, GCM_IV_BYTES),
        frame([WRAP_AAD_DOMAIN, protectedInput.keyRevisionRef, protectedInput.operationInputRevisionRef]),
        Buffer.from(protectedInput.wrappedDekBase64, "base64"),
        decodeExactBase64(protectedInput.wrapTagBase64, GCM_TAG_BYTES),
      );
      try {
        if (dek.byteLength !== AES_KEY_BYTES) throw new Error("invalid DEK");
        const plaintext = decryptGcm(
          dek,
          decodeExactBase64(protectedInput.contentIvBase64, GCM_IV_BYTES),
          inputAad(protectedInput.operationInputRevisionRef, binding),
          Buffer.from(protectedInput.ciphertextBase64, "base64"),
          decodeExactBase64(protectedInput.contentTagBase64, GCM_TAG_BYTES),
        );
        if (plaintext.byteLength !== protectedInput.plaintextBytes) {
          plaintext.fill(0);
          throw new Error("invalid plaintext size");
        }
        return new Uint8Array(plaintext);
      } finally {
        dek.fill(0);
      }
    } catch (cause) {
      throw new Error("MEDIA_INPUT_AUTHENTICATION_FAILED", { cause });
    }
  }
}

export function deriveMediaOwnerRequestDigest(input: Readonly<{
  ownerDigestKey: Uint8Array;
  canonicalBytes: Uint8Array;
  ownerBinding: MediaOperationOwnerBinding;
}>): Readonly<{ ownerRequestDigest: string }> {
  if (input.ownerDigestKey.byteLength !== AES_KEY_BYTES) throw new Error("MEDIA_OWNER_DIGEST_KEY_INVALID");
  if (input.canonicalBytes.byteLength < 1 || input.canonicalBytes.byteLength > DEFAULT_MAXIMUM_PLAINTEXT_BYTES) {
    throw new Error("MEDIA_OWNER_DIGEST_INPUT_INVALID");
  }
  const binding = snapshotOwnerBinding(input.ownerBinding);
  return Object.freeze({
    ownerRequestDigest: createHmac("sha256", input.ownerDigestKey)
      .update(frame([
        DIGEST_DOMAIN,
        binding.siteRef,
        binding.subjectRef,
        binding.subjectGeneration.toString(),
        binding.projectRef,
        binding.workloadRef,
        binding.source,
        binding.definitionRevisionRef,
        binding.modelOptionRevisionRef,
      ]))
      .update(input.canonicalBytes)
      .digest("hex"),
  });
}

function snapshotOwnerBinding(input: MediaOperationOwnerBinding): MediaOperationOwnerBinding {
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = ["definitionRevisionRef", "modelOptionRevisionRef", "projectRef", "siteRef", "source",
    "subjectGeneration", "subjectRef", "workloadRef"];
  if (Object.getPrototypeOf(input) !== Object.prototype ||
      JSON.stringify(Object.keys(descriptors).sort()) !== JSON.stringify(keys)) {
    throw new Error("MEDIA_OWNER_BINDING_INVALID");
  }
  for (const key of keys) {
    if (!("value" in descriptors[key]!)) throw new Error("MEDIA_OWNER_BINDING_INVALID");
  }
  const value = Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value])) as
    Record<string, unknown>;
  for (const key of ["siteRef", "subjectRef", "projectRef", "workloadRef", "definitionRevisionRef",
    "modelOptionRevisionRef"] as const) {
    assertReference(value[key], "MEDIA_OWNER_BINDING_INVALID");
  }
  if (typeof value.subjectGeneration !== "bigint" || value.subjectGeneration < 1n ||
      value.subjectGeneration > 9_223_372_036_854_775_807n ||
      (value.source !== "direct_studio" && value.source !== "agent_runtime")) {
    throw new Error("MEDIA_OWNER_BINDING_INVALID");
  }
  return Object.freeze({
    siteRef: value.siteRef as string,
    subjectRef: value.subjectRef as string,
    subjectGeneration: value.subjectGeneration,
    projectRef: value.projectRef as string,
    workloadRef: value.workloadRef as string,
    source: value.source,
    definitionRevisionRef: value.definitionRevisionRef as string,
    modelOptionRevisionRef: value.modelOptionRevisionRef as string,
  });
}

function snapshotProtectedInput(
  input: ProtectedOperationInputRevision,
  maximumPlaintextBytes: number,
): ProtectedOperationInputRevision {
  if (input.encryptionAlgorithm !== "AES-256-GCM-envelope-v1" ||
      !Number.isSafeInteger(input.plaintextBytes) || input.plaintextBytes < 1 ||
      input.plaintextBytes > maximumPlaintextBytes) {
    throw new Error("MEDIA_INPUT_ENVELOPE_INVALID");
  }
  assertReference(input.operationInputRevisionRef, "MEDIA_INPUT_ENVELOPE_INVALID");
  assertReference(input.keyRevisionRef, "MEDIA_INPUT_ENVELOPE_INVALID");
  return input;
}

function inputAad(operationInputRevisionRef: string, binding: MediaOperationOwnerBinding): Buffer {
  return frame([
    INPUT_AAD_DOMAIN,
    operationInputRevisionRef,
    binding.siteRef,
    binding.subjectRef,
    binding.subjectGeneration.toString(),
    binding.projectRef,
    binding.workloadRef,
    binding.source,
    binding.definitionRevisionRef,
    binding.modelOptionRevisionRef,
  ]);
}

function encryptGcm(key: Uint8Array, iv: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Readonly<{
  ciphertext: Buffer;
  tag: Buffer;
}> {
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Object.freeze({ ciphertext, tag: cipher.getAuthTag() });
}

function decryptGcm(
  key: Uint8Array,
  iv: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function frame(parts: readonly (string | Uint8Array)[]): Buffer {
  const buffers = parts.map((part) => typeof part === "string" ? Buffer.from(part, "utf8") : Buffer.from(part));
  const output: Buffer[] = [];
  for (const value of buffers) {
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(value.byteLength);
    output.push(length, value);
  }
  return Buffer.concat(output);
}

function decodeExactBase64(value: string, bytes: number): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== bytes || decoded.toString("base64") !== value) {
    throw new Error("invalid base64 field");
  }
  return decoded;
}

function assertReference(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || value.trim() !== value ||
      hasControlCharacter(value)) {
    throw new Error(code);
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
