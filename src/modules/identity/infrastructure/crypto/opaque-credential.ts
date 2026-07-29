import { createHmac, randomBytes } from "node:crypto";
import type { OpaqueCredentialPort } from "../../application/contracts/identity-security-ports.js";

export function createOpaqueCredentialCodec(digestKey: Uint8Array): OpaqueCredentialPort {
  if (digestKey.byteLength < 32) {
    throw new Error("OPAQUE_CREDENTIAL_KEY_INVALID");
  }
  const ownedDigestKey = Uint8Array.from(digestKey);

  function digest(credential: string): string {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(credential)) {
      throw new Error("OPAQUE_CREDENTIAL_INVALID");
    }
    return createHmac("sha256", ownedDigestKey).update(credential, "ascii").digest("hex");
  }

  return {
    issue() {
      const credential = randomBytes(32).toString("base64url");
      return { credential, digest: digest(credential) };
    },
    digest,
  };
}
