import { createHash } from "node:crypto";
import {
  Aes128Gcm,
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
} from "@hpke/core";
import { z } from "zod";
import {
  GA_RUN_REQUEST_ENCRYPTION_ALGORITHM,
  type GaRunRequestDraftSealInput,
  type GaRunRequestDraftSealer,
  type SealedGaRunRequestDraft,
} from "../../application/ga-run-request-draft-factory.js";

const FRAME_MAGIC = Uint8Array.of(0x4b, 0x48, 0x50, 0x4b, 0x45); // KHPKE
const FRAME_VERSION = 1;
const FRAME_HEADER_BYTES = FRAME_MAGIC.byteLength + 3;
const P256_ENCAPSULATED_KEY_BYTES = 65;
const MAX_CIPHERTEXT_BYTES = 1024 * 1024;
const HPKE_INFO_LABEL = "kokoro-admission-hpke-v1\0";

const bounded = (maximum: number) => z.string().min(1).max(maximum).refine((value) => value.trim() === value);
const instant = z.string().refine((value) => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
});
const base64Url = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/u);
const publicJwkSchema = z.object({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: base64Url,
  y: base64Url,
  ext: z.boolean().optional(),
  key_ops: z.array(z.literal("deriveBits")).max(1).optional(),
}).strict();
const publicKeyRingSchema = z.object({
  version: z.literal(1),
  activeKeyRevisionRef: bounded(128),
  keys: z.array(z.object({
    keyRevisionRef: bounded(128),
    audience: bounded(128),
    notBefore: instant,
    notAfter: instant,
    publicJwk: publicJwkSchema,
  }).strict()).min(1).max(32),
}).strict().superRefine((ring, context) => {
  const refs = ring.keys.map(({ keyRevisionRef }) => keyRevisionRef);
  if (new Set(refs).size !== refs.length) {
    context.addIssue({ code: "custom", message: "duplicate key revision" });
  }
  for (const [index, key] of ring.keys.entries()) {
    if (Date.parse(key.notAfter) <= Date.parse(key.notBefore)) {
      context.addIssue({ code: "custom", message: "invalid key lifetime", path: ["keys", index] });
    }
  }
});

export type GaRunRequestHpkePublicKeyRing = z.infer<typeof publicKeyRingSchema>;

export interface GaRunRequestHpkeAad {
  readonly version: 1;
  readonly keyRevisionRef: string;
  readonly audience: string;
  readonly siteId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly expiresAt: string;
  readonly plaintextSha256: string;
}

export class HpkeGaRunRequestDraftSealer implements GaRunRequestDraftSealer {
  readonly #suite: CipherSuite;
  readonly #key: Readonly<{
    keyRevisionRef: string;
    audience: string;
    notAfter: string;
    publicKey: CryptoKey;
  }>;
  readonly #clock: () => Date;

  private constructor(input: Readonly<{
    suite: CipherSuite;
    key: Readonly<{
      keyRevisionRef: string;
      audience: string;
      notAfter: string;
      publicKey: CryptoKey;
    }>;
    clock: () => Date;
  }>) {
    this.#suite = input.suite;
    this.#key = input.key;
    this.#clock = input.clock;
  }

  static async create(input: Readonly<{
    keyRing: unknown;
    expectedAudience: string;
    clock?: () => Date;
  }>): Promise<HpkeGaRunRequestDraftSealer> {
    try {
      const ring = publicKeyRingSchema.parse(input.keyRing);
      const clock = input.clock ?? (() => new Date());
      const now = validClock(clock);
      const active = ring.keys.find(({ keyRevisionRef }) => keyRevisionRef === ring.activeKeyRevisionRef);
      if (
        active === undefined ||
        active.audience !== bounded(128).parse(input.expectedAudience) ||
        Date.parse(active.notBefore) > now ||
        Date.parse(active.notAfter) <= now
      ) throw new Error("inactive key");
      const suite = hpkeSuite();
      const publicKey = await suite.kem.importKey("jwk", active.publicJwk as JsonWebKey, true);
      return new HpkeGaRunRequestDraftSealer({
        suite,
        key: Object.freeze({
          keyRevisionRef: active.keyRevisionRef,
          audience: active.audience,
          notAfter: active.notAfter,
          publicKey,
        }),
        clock,
      });
    } catch (cause) {
      throw new Error("ADMISSION_HPKE_PUBLIC_KEY_RING_INVALID", { cause });
    }
  }

  async seal(input: GaRunRequestDraftSealInput): Promise<SealedGaRunRequestDraft> {
    const now = validClock(this.#clock);
    if (input.audience !== this.#key.audience) {
      throw new Error("ADMISSION_HPKE_AUDIENCE_MISMATCH");
    }
    const maximumExpiresAt = canonicalInstant(input.maximumExpiresAt);
    const expiresAtMilliseconds = Math.min(maximumExpiresAt, Date.parse(this.#key.notAfter));
    if (expiresAtMilliseconds <= now) throw new Error("ADMISSION_HPKE_LIFETIME_INVALID");
    const expiresAt = new Date(expiresAtMilliseconds).toISOString();
    const aad = encodeGaRunRequestHpkeAad({
      version: 1,
      keyRevisionRef: this.#key.keyRevisionRef,
      audience: input.audience,
      siteId: input.siteId,
      sessionId: input.sessionId,
      runId: input.runId,
      expiresAt,
      plaintextSha256: input.plaintextSha256,
    });
    const result = await this.#suite.seal(
      {
        recipientPublicKey: this.#key.publicKey,
        info: hpkeInfo(aad),
      },
      input.plaintext,
      aad,
    );
    const ciphertext = frameGaRunRequestHpkeCiphertext(
      new Uint8Array(result.enc),
      new Uint8Array(result.ct),
    );
    return Object.freeze({
      ciphertext,
      encryptionAlgorithm: GA_RUN_REQUEST_ENCRYPTION_ALGORITHM,
      keyRevisionRef: this.#key.keyRevisionRef,
      audience: input.audience,
      expiresAt,
      plaintextSha256: input.plaintextSha256,
    });
  }
}

export function encodeGaRunRequestHpkeAad(input: GaRunRequestHpkeAad): Uint8Array {
  const parsed = z.object({
    version: z.literal(1),
    keyRevisionRef: bounded(128),
    audience: bounded(128),
    siteId: bounded(128),
    sessionId: bounded(128),
    runId: bounded(128),
    expiresAt: instant,
    plaintextSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }).strict().parse(input);
  return new TextEncoder().encode(JSON.stringify({
    audience: parsed.audience,
    expiresAt: parsed.expiresAt,
    keyRevisionRef: parsed.keyRevisionRef,
    plaintextSha256: parsed.plaintextSha256,
    runId: parsed.runId,
    sessionId: parsed.sessionId,
    siteId: parsed.siteId,
    version: parsed.version,
  }));
}

export function parseGaRunRequestHpkeCiphertext(input: Uint8Array): Readonly<{
  encapsulatedKey: Uint8Array;
  ciphertext: Uint8Array;
}> {
  if (
    !(input instanceof Uint8Array) ||
    input.byteLength > MAX_CIPHERTEXT_BYTES ||
    input.byteLength < FRAME_HEADER_BYTES + P256_ENCAPSULATED_KEY_BYTES + 16
  ) throw new Error("ADMISSION_HPKE_CIPHERTEXT_INVALID");
  for (let index = 0; index < FRAME_MAGIC.byteLength; index += 1) {
    if (input[index] !== FRAME_MAGIC[index]) throw new Error("ADMISSION_HPKE_CIPHERTEXT_INVALID");
  }
  if (input[FRAME_MAGIC.byteLength] !== FRAME_VERSION) {
    throw new Error("ADMISSION_HPKE_CIPHERTEXT_INVALID");
  }
  const encapsulatedKeyLength = (input[FRAME_MAGIC.byteLength + 1]! << 8) |
    input[FRAME_MAGIC.byteLength + 2]!;
  if (encapsulatedKeyLength !== P256_ENCAPSULATED_KEY_BYTES) {
    throw new Error("ADMISSION_HPKE_CIPHERTEXT_INVALID");
  }
  const ciphertextOffset = FRAME_HEADER_BYTES + encapsulatedKeyLength;
  return Object.freeze({
    encapsulatedKey: input.slice(FRAME_HEADER_BYTES, ciphertextOffset),
    ciphertext: input.slice(ciphertextOffset),
  });
}

function frameGaRunRequestHpkeCiphertext(
  encapsulatedKey: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array<ArrayBuffer> {
  if (encapsulatedKey.byteLength !== P256_ENCAPSULATED_KEY_BYTES || ciphertext.byteLength < 16) {
    throw new Error("ADMISSION_HPKE_CIPHERTEXT_INVALID");
  }
  const framed: Uint8Array<ArrayBuffer> = new Uint8Array(
    FRAME_HEADER_BYTES + encapsulatedKey.byteLength + ciphertext.byteLength,
  );
  if (framed.byteLength > MAX_CIPHERTEXT_BYTES) throw new Error("ADMISSION_HPKE_CIPHERTEXT_INVALID");
  framed.set(FRAME_MAGIC, 0);
  framed[FRAME_MAGIC.byteLength] = FRAME_VERSION;
  framed[FRAME_MAGIC.byteLength + 1] = encapsulatedKey.byteLength >>> 8;
  framed[FRAME_MAGIC.byteLength + 2] = encapsulatedKey.byteLength & 0xff;
  framed.set(encapsulatedKey, FRAME_HEADER_BYTES);
  framed.set(ciphertext, FRAME_HEADER_BYTES + encapsulatedKey.byteLength);
  return framed;
}

function hpkeSuite(): CipherSuite {
  return new CipherSuite({
    kem: new DhkemP256HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes128Gcm(),
  });
}

function hpkeInfo(aad: Uint8Array): Uint8Array {
  return createHash("sha256").update(HPKE_INFO_LABEL).update(aad).digest();
}

function validClock(clock: () => Date): number {
  const now = clock().getTime();
  if (!Number.isFinite(now)) throw new Error("ADMISSION_HPKE_CLOCK_INVALID");
  return now;
}

function canonicalInstant(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error("ADMISSION_HPKE_LIFETIME_INVALID");
  }
  return milliseconds;
}
