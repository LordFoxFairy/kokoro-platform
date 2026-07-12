import { describe, expect, it } from "vitest";
import { loadSecretKeyring } from "../../src/config/secret-keyring.js";
import { loadHubEnv } from "../../src/config/env.js";
import {
  AesGcmSecretCipher,
  keyFingerprint,
} from "../../src/infrastructure/crypto/aes-gcm-secret-cipher.js";

const K1 = Buffer.alloc(32, 3);
const K2 = Buffer.alloc(32, 4);
const K1_B64 = K1.toString("base64");
const K2_B64 = K2.toString("base64");

// loadSecretKeyring 收 HubEnv；用 loadHubEnv 洗出带默认值的最小 env，再覆盖 secret 字段。
function envWith(overrides: Record<string, string>) {
  return loadHubEnv({ ...overrides });
}

describe("loadSecretKeyring", () => {
  it("returns null when no master key is configured", () => {
    expect(loadSecretKeyring(envWith({}))).toBeNull();
  });

  it("loads the primary key and derives its fingerprint as primaryKeyId", () => {
    const ring = loadSecretKeyring(envWith({ KOKORO_HUB_SECRET_MASTER_KEY: K1_B64 }));
    expect(ring?.primaryKeyId).toBe(keyFingerprint(K1));
  });

  it("loads previous keys for dual-read rotation", () => {
    const ring = loadSecretKeyring(
      envWith({
        KOKORO_HUB_SECRET_MASTER_KEY: K2_B64,
        KOKORO_HUB_SECRET_MASTER_KEY_PREVIOUS: K1_B64,
      }),
    );
    expect(ring).not.toBeNull();
    const cipher = new AesGcmSecretCipher(ring!);
    // primary = K2，历史 = K1：K1 封的信封仍可解。
    const encByK1 = new AesGcmSecretCipher({ primaryKeyId: keyFingerprint(K1), keys: new Map([[keyFingerprint(K1), K1]]) }).encrypt("old");
    expect(cipher.decrypt(encByK1)).toBe("old");
    expect(cipher.encrypt("new").keyId).toBe(keyFingerprint(K2));
  });

  it("fails loud on a master key that does not decode to 32 bytes", () => {
    const shortB64 = Buffer.alloc(16, 9).toString("base64");
    expect(() => loadSecretKeyring(envWith({ KOKORO_HUB_SECRET_MASTER_KEY: shortB64 }))).toThrow(
      /32 bytes/,
    );
  });
});
