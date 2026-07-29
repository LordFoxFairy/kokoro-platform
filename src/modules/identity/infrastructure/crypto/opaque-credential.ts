import { createHmac, randomBytes } from "node:crypto";

export type IssuedOpaqueCredential = Readonly<{
  credential: string;
  digest: string;
}>;

export type OpaqueCredentialCodec = Readonly<{
  issue(): IssuedOpaqueCredential;
  digest(credential: string): string;
}>;

export function createOpaqueCredentialCodec(digestKey: Uint8Array): OpaqueCredentialCodec {
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
