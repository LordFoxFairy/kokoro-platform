import { describe, expect, it } from "vitest";
import {
  AesGcmSecretCipher,
  keyFingerprint,
  makeSecretKeyring,
} from "../../src/infrastructure/crypto/aes-gcm-secret-cipher.js";
import { SecretDecryptError } from "../../src/domain/secret-cipher.js";

const K1 = Buffer.alloc(32, 1);
const K2 = Buffer.alloc(32, 2);

function cipherWith(keys: Buffer[]): AesGcmSecretCipher {
  const ring = makeSecretKeyring(keys);
  if (ring === null) {
    throw new Error("keyring must not be empty");
  }
  return new AesGcmSecretCipher(ring);
}

describe("AesGcmSecretCipher", () => {
  it("round-trips plaintext through encrypt/decrypt", () => {
    const cipher = cipherWith([K1]);
    const encrypted = cipher.encrypt("super-secret-token-value");
    expect(cipher.decrypt(encrypted)).toBe("super-secret-token-value");
  });

  it("stamps the primary key fingerprint as key_id", () => {
    const cipher = cipherWith([K1]);
    expect(cipher.encrypt("v").keyId).toBe(keyFingerprint(K1));
  });

  it("never embeds the plaintext in the ciphertext envelope", () => {
    const cipher = cipherWith([K1]);
    const plaintext = "plaintext-marker-do-not-leak";
    const { ciphertext } = cipher.encrypt(plaintext);
    expect(ciphertext).not.toContain(plaintext);
    expect(ciphertext.startsWith("v1:")).toBe(true);
  });

  it("produces distinct ciphertext for the same plaintext (random iv)", () => {
    const cipher = cipherWith([K1]);
    const a = cipher.encrypt("same-value");
    const b = cipher.encrypt("same-value");
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(cipher.decrypt(a)).toBe(cipher.decrypt(b));
  });

  it("dual-reads across rotation: new primary decrypts an old key_id envelope", () => {
    const oldCipher = cipherWith([K1]);
    const encByOld = oldCipher.encrypt("value-under-old-key");
    expect(encByOld.keyId).toBe(keyFingerprint(K1));

    // 轮换后：primary=K2，历史保留 K1。
    const rotated = cipherWith([K2, K1]);
    expect(rotated.decrypt(encByOld)).toBe("value-under-old-key");
    // 新写走新 primary key_id。
    expect(rotated.encrypt("fresh").keyId).toBe(keyFingerprint(K2));
  });

  it("fails when the key_id is not present in the keyring", () => {
    const onlyK2 = cipherWith([K2]);
    const encByK1 = cipherWith([K1]).encrypt("orphan");
    expect(() => onlyK2.decrypt(encByK1)).toThrow(SecretDecryptError);
  });

  it("rejects a tampered ciphertext with an authentication failure (no plaintext leak)", () => {
    const cipher = cipherWith([K1]);
    const encrypted = cipher.encrypt("tamper-target");
    const parts = encrypted.ciphertext.split(":");
    // 在解码后的密文字节上翻一个 bit（保证真实改动，非 base64 padding 无效位）。
    const ctBytes = Buffer.from(parts[3] ?? "", "base64");
    ctBytes[0] = (ctBytes[0] ?? 0) ^ 0x01;
    const tampered = {
      ciphertext: [parts[0], parts[1], parts[2], ctBytes.toString("base64")].join(":"),
      keyId: encrypted.keyId,
    };
    try {
      cipher.decrypt(tampered);
      throw new Error("expected decrypt to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SecretDecryptError);
      expect((error as Error).message).not.toContain("tamper-target");
    }
  });

  it("rejects a malformed envelope (bad version / segment count)", () => {
    const cipher = cipherWith([K1]);
    const keyId = keyFingerprint(K1);
    expect(() => cipher.decrypt({ ciphertext: "v2:a:b:c", keyId })).toThrow(SecretDecryptError);
    expect(() => cipher.decrypt({ ciphertext: "v1:onlytwo", keyId })).toThrow(SecretDecryptError);
  });

  it("makeSecretKeyring rejects a non-32-byte key and returns null on empty input", () => {
    expect(() => makeSecretKeyring([Buffer.alloc(16, 1)])).toThrow();
    expect(makeSecretKeyring([])).toBeNull();
  });
});
