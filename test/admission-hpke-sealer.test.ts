import { createHash } from "node:crypto";
import {
  Aes128Gcm,
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
} from "@hpke/core";
import { describe, expect, it } from "vitest";
import type { GaRunRequestDraftSealInput } from "../src/modules/admission/application/ga-run-request-draft-factory.js";
import {
  HpkeGaRunRequestDraftSealer,
  encodeGaRunRequestHpkeAad,
  parseGaRunRequestHpkeCiphertext,
} from "../src/modules/admission/infrastructure/hpke/ga-run-request-draft-sealer.js";

const now = new Date("2026-07-29T12:00:00.000Z");
const keyRevisionRef = "ga-dispatch-hpke-2026-07";
const audience = "kokoro-session-dispatch";

async function p256KeyPair() {
  const suite = new CipherSuite({
    kem: new DhkemP256HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes128Gcm(),
  });
  const pair = await suite.kem.generateKeyPair();
  return {
    privateKey: pair.privateKey,
    publicJwk: await globalThis.crypto.subtle.exportKey("jwk", pair.publicKey),
  };
}

function sealInput(plaintext = new TextEncoder().encode('{"kind":"run.request"}')) {
  return Object.freeze({
    plaintext,
    plaintextSha256: createHash("sha256").update(plaintext).digest("hex"),
    audience,
    siteId: "site-1",
    sessionId: "session-1",
    runId: "run-1",
    maximumExpiresAt: "2026-07-29T12:05:00.000Z",
  }) satisfies GaRunRequestDraftSealInput;
}

describe("Admission HPKE public-key sealer", () => {
  it("encrypts for the active audience key and binds the complete owner context as AAD", async () => {
    const { privateKey, publicJwk } = await p256KeyPair();
    const sealer = await HpkeGaRunRequestDraftSealer.create({
      keyRing: {
        version: 1,
        activeKeyRevisionRef: keyRevisionRef,
        keys: [{
          keyRevisionRef,
          audience,
          notBefore: "2026-07-29T11:00:00.000Z",
          notAfter: "2026-07-29T13:00:00.000Z",
          publicJwk,
        }],
      },
      expectedAudience: audience,
      clock: () => now,
    });
    const input = sealInput();

    const sealed = await sealer.seal(input);

    expect(sealed).toMatchObject({
      encryptionAlgorithm: "HPKE-v1",
      keyRevisionRef,
      audience,
      expiresAt: input.maximumExpiresAt,
      plaintextSha256: input.plaintextSha256,
    });
    const frame = parseGaRunRequestHpkeCiphertext(sealed.ciphertext);
    const suite = new CipherSuite({
      kem: new DhkemP256HkdfSha256(),
      kdf: new HkdfSha256(),
      aead: new Aes128Gcm(),
    });
    const aad = encodeGaRunRequestHpkeAad({
      version: 1,
      keyRevisionRef,
      audience,
      siteId: input.siteId,
      sessionId: input.sessionId,
      runId: input.runId,
      expiresAt: sealed.expiresAt,
      plaintextSha256: input.plaintextSha256,
    });
    const opened = await suite.open(
      {
        recipientKey: privateKey,
        enc: frame.encapsulatedKey,
        info: createHash("sha256").update("kokoro-admission-hpke-v1\0").update(aad).digest(),
      },
      frame.ciphertext,
      aad,
    );
    expect(new Uint8Array(opened)).toEqual(input.plaintext);

    const tamperedAad = encodeGaRunRequestHpkeAad({
      version: 1,
      keyRevisionRef,
      audience,
      siteId: "site-2",
      sessionId: input.sessionId,
      runId: input.runId,
      expiresAt: sealed.expiresAt,
      plaintextSha256: input.plaintextSha256,
    });
    await expect(suite.open(
      {
        recipientKey: privateKey,
        enc: frame.encapsulatedKey,
        info: createHash("sha256").update("kokoro-admission-hpke-v1\0").update(tamperedAad).digest(),
      },
      frame.ciphertext,
      tamperedAad,
    )).rejects.toThrow();
  });

  it("fails startup for a missing, inactive, mismatched, or private-bearing public key", async () => {
    const { publicJwk } = await p256KeyPair();
    const base = {
      version: 1 as const,
      activeKeyRevisionRef: keyRevisionRef,
      keys: [{
        keyRevisionRef,
        audience,
        notBefore: "2026-07-29T11:00:00.000Z",
        notAfter: "2026-07-29T13:00:00.000Z",
        publicJwk,
      }],
    };

    await expect(HpkeGaRunRequestDraftSealer.create({
      keyRing: { ...base, activeKeyRevisionRef: "missing" },
      expectedAudience: audience,
      clock: () => now,
    })).rejects.toThrow("ADMISSION_HPKE_PUBLIC_KEY_RING_INVALID");
    await expect(HpkeGaRunRequestDraftSealer.create({
      keyRing: {
        ...base,
        keys: [{ ...base.keys[0]!, notBefore: "2026-07-29T12:00:00.001Z" }],
      },
      expectedAudience: audience,
      clock: () => now,
    })).rejects.toThrow("ADMISSION_HPKE_PUBLIC_KEY_RING_INVALID");
    await expect(HpkeGaRunRequestDraftSealer.create({
      keyRing: {
        ...base,
        keys: [{ ...base.keys[0]!, audience: "another-recipient" }],
      },
      expectedAudience: audience,
      clock: () => now,
    })).rejects.toThrow("ADMISSION_HPKE_PUBLIC_KEY_RING_INVALID");
    await expect(HpkeGaRunRequestDraftSealer.create({
      keyRing: {
        ...base,
        keys: [{ ...base.keys[0]!, publicJwk: { ...publicJwk, d: "private" } }],
      },
      expectedAudience: audience,
      clock: () => now,
    })).rejects.toThrow("ADMISSION_HPKE_PUBLIC_KEY_RING_INVALID");
  });

  it("caps ciphertext expiry to the active key lifetime and rejects caller/key audience drift", async () => {
    const { publicJwk } = await p256KeyPair();
    const sealer = await HpkeGaRunRequestDraftSealer.create({
      keyRing: {
        version: 1,
        activeKeyRevisionRef: keyRevisionRef,
        keys: [{
          keyRevisionRef,
          audience,
          notBefore: "2026-07-29T11:00:00.000Z",
          notAfter: "2026-07-29T12:02:00.000Z",
          publicJwk,
        }],
      },
      expectedAudience: audience,
      clock: () => now,
    });

    await expect(sealer.seal({ ...sealInput(), audience: "another-recipient" })).rejects.toThrow(
      "ADMISSION_HPKE_AUDIENCE_MISMATCH",
    );
    await expect(sealer.seal({ ...sealInput(), maximumExpiresAt: now.toISOString() })).rejects.toThrow(
      "ADMISSION_HPKE_LIFETIME_INVALID",
    );
    await expect(sealer.seal(sealInput())).resolves.toMatchObject({
      expiresAt: "2026-07-29T12:02:00.000Z",
    });
  });
});
