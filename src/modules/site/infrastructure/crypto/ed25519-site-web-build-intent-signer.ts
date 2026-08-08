import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import type { SiteWebBuildIntentSignerPort } from
  "../../application/contracts/site-publication-authority-ports.js";
import {
  createSiteWebBuildIntentDsseEnvelope,
  decodeSiteWebBuildIntentDssePayload,
  siteWebBuildIntentDssePae,
} from "../../domain/site-web-build-intent-dsse.js";

export interface SiteWebBuildIntentSigningKey {
  readonly keyId: string;
  readonly keyVersion: bigint;
  readonly publicKeyPem: string;
  readonly publicKeyFingerprint: string;
  readonly privateKeyPem?: string;
}

interface LoadedKey extends SiteWebBuildIntentSigningKey {
  readonly publicKey: KeyObject;
  readonly privateKey?: KeyObject;
}

export class Ed25519SiteWebBuildIntentSigner implements SiteWebBuildIntentSignerPort {
  private readonly keys: ReadonlyMap<string, LoadedKey>;

  constructor(keys: readonly SiteWebBuildIntentSigningKey[]) {
    const loaded = keys.map(loadKey);
    const entries = loaded.map((key) => [selector(key.keyId, key.keyVersion), key] as const);
    if (entries.length < 1 || entries.length > 64 || new Set(entries.map(([id]) => id)).size !== entries.length) {
      throw new Error("SITE_WEB_BUILD_INTENT_KEYRING_INVALID");
    }
    this.keys = new Map(entries);
  }

  async sign(input: Parameters<SiteWebBuildIntentSignerPort["sign"]>[0]) {
    const key = this.resolve(input.key);
    if (key.privateKey === undefined) {
      throw new Error("SITE_WEB_BUILD_INTENT_PRIVATE_KEY_UNAVAILABLE");
    }
    const signature = sign(
      null,
      siteWebBuildIntentDssePae(input.payloadType, input.payload),
      key.privateKey,
    );
    return createSiteWebBuildIntentDsseEnvelope({
      payloadType: input.payloadType,
      payload: Buffer.from(input.payload).toString("base64"),
      signatures: [{ keyid: key.keyId, sig: signature.toString("base64") }],
    });
  }

  async verify(input: Parameters<SiteWebBuildIntentSignerPort["verify"]>[0]): Promise<void> {
    const key = this.resolve(input.key);
    const envelope = createSiteWebBuildIntentDsseEnvelope(input.envelope);
    if (envelope.signatures[0].keyid !== key.keyId) {
      throw new Error("SITE_WEB_BUILD_INTENT_SIGNING_KEY_MISMATCH");
    }
    const payload = decodeSiteWebBuildIntentDssePayload(envelope);
    const valid = verify(
      null,
      siteWebBuildIntentDssePae(envelope.payloadType, payload),
      key.publicKey,
      Buffer.from(envelope.signatures[0].sig, "base64"),
    );
    if (!valid) throw new Error("SITE_WEB_BUILD_INTENT_SIGNATURE_INVALID");
  }

  private resolve(input: Parameters<SiteWebBuildIntentSignerPort["verify"]>[0]["key"]): LoadedKey {
    const key = this.keys.get(selector(input.keyId, input.keyVersion));
    if (key === undefined || key.publicKeyFingerprint !== input.publicKeyFingerprint) {
      throw new Error("SITE_WEB_BUILD_INTENT_SIGNING_KEY_MISMATCH");
    }
    return key;
  }
}

function loadKey(input: SiteWebBuildIntentSigningKey): LoadedKey {
  try {
    if (input.keyVersion < 1n || input.keyVersion > 18_446_744_073_709_551_615n) {
      throw new Error("invalid version");
    }
    const publicKey = createPublicKey(input.publicKeyPem);
    if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("invalid public key");
    const publicDer = publicKey.export({ type: "spki", format: "der" });
    const fingerprint = `sha256:${createHash("sha256").update(publicDer).digest("hex")}`;
    if (fingerprint !== input.publicKeyFingerprint) throw new Error("invalid fingerprint");
    const privateKey = input.privateKeyPem === undefined ? undefined : createPrivateKey(input.privateKeyPem);
    if (privateKey !== undefined && (privateKey.asymmetricKeyType !== "ed25519" ||
        !createPublicKey(privateKey).export({ type: "spki", format: "der" }).equals(publicDer))) {
      throw new Error("private key mismatch");
    }
    return Object.freeze({ ...input, publicKey, ...(privateKey === undefined ? {} : { privateKey }) });
  } catch {
    throw new Error("SITE_WEB_BUILD_INTENT_KEYRING_INVALID");
  }
}

function selector(keyId: string, keyVersion: bigint): string {
  return `${keyId}\0${keyVersion.toString()}`;
}
