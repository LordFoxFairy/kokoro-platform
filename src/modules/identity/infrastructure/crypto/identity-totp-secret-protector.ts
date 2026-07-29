import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type {
  IdentityTotpSecretEnvelope,
  IdentityTotpSecretBinding,
  IdentityTotpSecretProtectorPort,
} from "../../application/contracts/identity-security-ports.js";

export type IdentityTotpSecretKeyRing = Readonly<{
  currentKeyRevision: string;
  keys: readonly Readonly<{ keyRevision: string; key: Uint8Array }>[];
}>;

export function createIdentityTotpSecretProtector(
  config: IdentityTotpSecretKeyRing,
): IdentityTotpSecretProtectorPort {
  const keys = new Map<string, Uint8Array>();
  for (const item of config.keys) {
    if (!validRevision(item.keyRevision) || item.key.byteLength !== 32 || keys.has(item.keyRevision)) {
      throw new Error("IDENTITY_TOTP_KEY_RING_INVALID");
    }
    keys.set(item.keyRevision, Uint8Array.from(item.key));
  }
  if (!validRevision(config.currentKeyRevision) || !keys.has(config.currentKeyRevision)) {
    throw new Error("IDENTITY_TOTP_KEY_RING_INVALID");
  }
  return Object.freeze({
    seal(secret: string, binding: IdentityTotpSecretBinding) {
      assertBinding(binding);
      const key = keys.get(config.currentKeyRevision);
      if (key === undefined) throw new Error("IDENTITY_TOTP_KEY_RING_INVALID");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
      cipher.setAAD(additionalData(config.currentKeyRevision, binding));
      const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
      return Object.freeze({
        algorithm: "A256GCM" as const,
        keyRevision: config.currentKeyRevision,
        nonce: nonce.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        authenticationTag: cipher.getAuthTag().toString("base64url"),
      });
    },
    unseal(envelope: IdentityTotpSecretEnvelope, binding: IdentityTotpSecretBinding) {
      assertBinding(binding);
      if (envelope.algorithm !== "A256GCM") throw new Error("IDENTITY_TOTP_ENVELOPE_INVALID");
      const key = keys.get(envelope.keyRevision);
      if (key === undefined) throw new Error("IDENTITY_TOTP_KEY_REVISION_UNKNOWN");
      const nonce = canonicalBase64url(envelope.nonce, 12);
      const authenticationTag = canonicalBase64url(envelope.authenticationTag, 16);
      const ciphertext = canonicalBase64url(envelope.ciphertext, null);
      if (ciphertext.byteLength < 1 || ciphertext.byteLength > 3072) {
        throw new Error("IDENTITY_TOTP_ENVELOPE_INVALID");
      }
      const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
      decipher.setAAD(additionalData(envelope.keyRevision, binding));
      decipher.setAuthTag(authenticationTag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      if (!/^[A-Z2-7]{26,128}$/u.test(plaintext)) throw new Error("IDENTITY_TOTP_SECRET_INVALID");
      return plaintext;
    },
  });
}

function validRevision(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function assertBinding(binding: IdentityTotpSecretBinding): void {
  if ([binding.siteRef, binding.accountRef, binding.subjectRef, binding.authenticatorRef]
    .some((value) => value.length < 1 || value.length > 128 || /[\0\r\n]/u.test(value))) {
    throw new Error("IDENTITY_TOTP_BINDING_INVALID");
  }
}

function additionalData(keyRevision: string, binding: IdentityTotpSecretBinding): Buffer {
  return Buffer.from([
    "kokoro.identity.totp-secret.v1",
    keyRevision,
    binding.siteRef,
    binding.accountRef,
    binding.subjectRef,
    binding.authenticatorRef,
  ].join("\0"), "utf8");
}

function canonicalBase64url(value: string, expectedBytes: number | null): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("IDENTITY_TOTP_ENVELOPE_INVALID");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value || (expectedBytes !== null && decoded.byteLength !== expectedBytes)) {
    throw new Error("IDENTITY_TOTP_ENVELOPE_INVALID");
  }
  return decoded;
}
