import { createCipheriv, randomBytes } from "node:crypto";
import type {
  VerificationDeliveryContent,
  VerificationEnvelopeSealerPort,
} from "../../application/contracts/identity-security-ports.js";

export function createVerificationEnvelopeSealer(config: Readonly<{
  keyRevision: string;
  key: Uint8Array;
}>): VerificationEnvelopeSealerPort {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(config.keyRevision) || config.key.byteLength !== 32) {
    throw new Error("IDENTITY_DELIVERY_KEY_INVALID");
  }
  const ownedKey = Uint8Array.from(config.key);
  const additionalData = Buffer.from(`kokoro.identity.verification.v1\0${config.keyRevision}`, "utf8");
  return Object.freeze({
    seal(content: VerificationDeliveryContent) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", ownedKey, nonce, { authTagLength: 16 });
      cipher.setAAD(additionalData);
      const plaintext = Buffer.from(JSON.stringify(content), "utf8");
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const authenticationTag = cipher.getAuthTag();
      return Object.freeze({
        algorithm: "A256GCM" as const,
        keyRevision: config.keyRevision,
        nonce: nonce.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        authenticationTag: authenticationTag.toString("base64url"),
      });
    },
  });
}
