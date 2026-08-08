import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  Ed25519SiteWebBuildIntentSigner,
} from "../../src/modules/site/infrastructure/crypto/ed25519-site-web-build-intent-signer.js";
import {
  SITE_WEB_BUILD_INTENT_PAYLOAD_TYPE,
  siteWebBuildIntentDssePae,
} from "../../src/modules/site/domain/site-web-build-intent-dsse.js";

describe("Ed25519SiteWebBuildIntentSigner", () => {
  it("creates a standard DSSE envelope over the exact canonical payload bytes", async () => {
    const key = signingKey("key.web-build-intent", 3n);
    const signer = new Ed25519SiteWebBuildIntentSigner([key]);
    const payload = Buffer.from('{"contract":"kokoro.web-build-intent.v1"}', "utf8");

    const envelope = await signer.sign({
      key: selector(key),
      payloadType: SITE_WEB_BUILD_INTENT_PAYLOAD_TYPE,
      payload,
    });

    expect(envelope).toEqual({
      payloadType: SITE_WEB_BUILD_INTENT_PAYLOAD_TYPE,
      payload: payload.toString("base64"),
      signatures: [{ keyid: key.keyId, sig: expect.any(String) }],
    });
    expect(verify(
      null,
      siteWebBuildIntentDssePae(SITE_WEB_BUILD_INTENT_PAYLOAD_TYPE, payload),
      key.publicKeyPem,
      Buffer.from(envelope.signatures[0].sig, "base64"),
    )).toBe(true);
    await expect(signer.verify({ key: selector(key), envelope })).resolves.toBeUndefined();
  });

  it("rejects tampered payloads, signatures, fingerprints, and key selectors", async () => {
    const key = signingKey("key.web-build-intent", 3n);
    const other = signingKey("key.web-build-intent.next", 4n);
    const signer = new Ed25519SiteWebBuildIntentSigner([key, other]);
    const envelope = await signer.sign({
      key: selector(key),
      payloadType: SITE_WEB_BUILD_INTENT_PAYLOAD_TYPE,
      payload: Buffer.from("{}", "utf8"),
    });

    await expect(signer.verify({
      key: selector(key),
      envelope: { ...envelope, payload: Buffer.from('{"tampered":true}').toString("base64") },
    })).rejects.toThrow("SITE_WEB_BUILD_INTENT_SIGNATURE_INVALID");
    await expect(signer.verify({
      key: selector(key),
      envelope: { ...envelope, signatures: [{
        ...envelope.signatures[0], sig: Buffer.alloc(64, 1).toString("base64"),
      }] },
    })).rejects.toThrow("SITE_WEB_BUILD_INTENT_SIGNATURE_INVALID");
    await expect(signer.verify({
      key: { ...selector(key), publicKeyFingerprint: other.publicKeyFingerprint }, envelope,
    })).rejects.toThrow("SITE_WEB_BUILD_INTENT_SIGNING_KEY_MISMATCH");
    await expect(signer.verify({ key: selector(other), envelope }))
      .rejects.toThrow("SITE_WEB_BUILD_INTENT_SIGNING_KEY_MISMATCH");
  });

  it("verifies historical public keys but never signs without the matching private key", async () => {
    const historical = signingKey("key.web-build-intent.history", 2n, false);
    const signer = new Ed25519SiteWebBuildIntentSigner([historical]);
    const payload = Buffer.from("{}", "utf8");
    const signature = sign(
      null,
      siteWebBuildIntentDssePae(SITE_WEB_BUILD_INTENT_PAYLOAD_TYPE, payload),
      historical.testPrivateKeyPem,
    );
    const envelope = {
      payloadType: SITE_WEB_BUILD_INTENT_PAYLOAD_TYPE,
      payload: payload.toString("base64"),
      signatures: [{ keyid: historical.keyId, sig: signature.toString("base64") }],
    } as const;

    await expect(signer.verify({ key: selector(historical), envelope })).resolves.toBeUndefined();
    await expect(signer.sign({
      key: selector(historical), payloadType: SITE_WEB_BUILD_INTENT_PAYLOAD_TYPE, payload,
    })).rejects.toThrow("SITE_WEB_BUILD_INTENT_PRIVATE_KEY_UNAVAILABLE");
  });
});

function signingKey(keyId: string, keyVersion: bigint, includePrivate = true) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return Object.freeze({
    keyId,
    keyVersion,
    publicKeyPem,
    publicKeyFingerprint: `sha256:${createHash("sha256").update(publicKey.export({
      type: "spki", format: "der",
    })).digest("hex")}`,
    ...(includePrivate ? { privateKeyPem } : {}),
    testPrivateKeyPem: privateKeyPem,
  });
}

function selector(key: ReturnType<typeof signingKey>) {
  return Object.freeze({
    keyId: key.keyId,
    keyVersion: key.keyVersion,
    publicKeyFingerprint: key.publicKeyFingerprint,
  });
}
