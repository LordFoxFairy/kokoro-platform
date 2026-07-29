import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type {
  AssetUploadCapability,
  AssetUploadCapabilityIssuerPort,
} from "../../application/contracts/asset-upload-ports.js";
import type { AssetUploadEndpointResolver } from "../config/asset-upload-policy-registry.js";

export interface AssetUploadCapabilityKeyRing {
  readonly currentKeyRevision: string;
  readonly keys: readonly Readonly<{ keyRevision: string; key: Uint8Array }>[];
}

export interface AssetUploadCapabilityClaims {
  readonly version: 1;
  readonly audience: string;
  readonly storageTenantRef: string;
  readonly storageRegion: string;
  readonly siteRef: string;
  readonly subjectRef: string;
  readonly subjectGeneration: string;
  readonly projectRef: string;
  readonly purpose: string;
  readonly intentRef: string;
  readonly sessionRef: string;
  readonly quarantineObjectRef: string;
  readonly expectedSize: string;
  readonly expectedChecksumSha256: string;
  readonly capabilityEpoch: string;
  readonly expiresAt: string;
  readonly minimumPartBytes: string;
  readonly maximumPartBytes: string;
}

export class SealedAssetUploadCapabilityIssuer implements AssetUploadCapabilityIssuerPort {
  readonly #keys: Map<string, Buffer>;
  readonly #currentKeyRevision: string;

  constructor(
    keyRing: AssetUploadCapabilityKeyRing,
    private readonly endpoints: AssetUploadEndpointResolver,
    private readonly nonce: () => Buffer = () => randomBytes(12),
  ) {
    if (keyRing.keys.length < 1 || keyRing.keys.length > 16) throw new Error("ASSET_CAPABILITY_KEY_RING_INVALID");
    this.#keys = new Map(keyRing.keys.map(({ keyRevision, key }) => {
      if (!/^[A-Za-z0-9_-]{1,64}$/u.test(keyRevision) || key.byteLength !== 32) {
        throw new Error("ASSET_CAPABILITY_KEY_RING_INVALID");
      }
      return [keyRevision, Buffer.from(key)] as const;
    }));
    if (this.#keys.size !== keyRing.keys.length || !this.#keys.has(keyRing.currentKeyRevision)) {
      throw new Error("ASSET_CAPABILITY_KEY_RING_INVALID");
    }
    this.#currentKeyRevision = keyRing.currentKeyRevision;
  }

  async issue(input: Parameters<AssetUploadCapabilityIssuerPort["issue"]>[0]): Promise<AssetUploadCapability> {
    const claims: AssetUploadCapabilityClaims = Object.freeze({
      version: 1,
      audience: input.audience,
      storageTenantRef: input.storageTenantRef,
      storageRegion: input.storageRegion,
      siteRef: input.siteRef,
      subjectRef: input.subjectRef,
      subjectGeneration: input.subjectGeneration.toString(),
      projectRef: input.projectRef,
      purpose: input.purpose,
      intentRef: input.intentRef,
      sessionRef: input.sessionRef,
      quarantineObjectRef: input.quarantineObjectRef,
      expectedSize: input.expectedSize.toString(),
      expectedChecksumSha256: input.expectedChecksumSha256,
      capabilityEpoch: input.capabilityEpoch.toString(),
      expiresAt: input.expiresAt,
      minimumPartBytes: input.minimumPartBytes.toString(),
      maximumPartBytes: input.maximumPartBytes.toString(),
    });
    return Object.freeze({
      protocolRevision: "s3-multipart-v1" as const,
      uploadEndpoint: this.endpoints.resolveEndpoint(input.audience),
      credential: this.seal(claims),
      capabilityEpoch: input.capabilityEpoch,
      expiresAt: input.expiresAt,
      minimumPartBytes: input.minimumPartBytes,
      maximumPartBytes: input.maximumPartBytes,
    });
  }

  verify(credential: string): AssetUploadCapabilityClaims | null {
    const parts = credential.split(".");
    if (parts.length !== 5 || parts[0] !== "asset-upload-v1") return null;
    const [, keyRevision, encodedNonce, encodedCiphertext, encodedTag] = parts;
    const key = this.#keys.get(keyRevision!);
    if (key === undefined) return null;
    try {
      const nonce = Buffer.from(encodedNonce!, "base64url");
      const ciphertext = Buffer.from(encodedCiphertext!, "base64url");
      const tag = Buffer.from(encodedTag!, "base64url");
      if (
        nonce.byteLength !== 12 || tag.byteLength !== 16 || ciphertext.byteLength < 32 ||
        nonce.toString("base64url") !== encodedNonce || ciphertext.toString("base64url") !== encodedCiphertext ||
        tag.toString("base64url") !== encodedTag
      ) return null;
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAAD(Buffer.from(`asset-upload-capability-v1\0${keyRevision}`, "utf8"));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      return parseClaims(JSON.parse(plaintext) as unknown);
    } catch {
      return null;
    }
  }

  private seal(claims: AssetUploadCapabilityClaims): string {
    const keyRevision = this.#currentKeyRevision;
    const key = this.#keys.get(keyRevision)!;
    const nonce = this.nonce();
    if (nonce.byteLength !== 12) throw new Error("ASSET_CAPABILITY_NONCE_INVALID");
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(`asset-upload-capability-v1\0${keyRevision}`, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(claims), "utf8"), cipher.final()]);
    return ["asset-upload-v1", keyRevision, nonce.toString("base64url"), ciphertext.toString("base64url"),
      cipher.getAuthTag().toString("base64url")].join(".");
  }
}

export function parseAssetUploadCapabilityKeyRing(value: unknown): AssetUploadCapabilityKeyRing {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ASSET_CAPABILITY_KEY_RING_INVALID");
  const root = value as Record<string, unknown>;
  if (Object.keys(root).some((field) => !["version", "currentKeyRevision", "keys"].includes(field)) ||
    root.version !== 1 || typeof root.currentKeyRevision !== "string" || !Array.isArray(root.keys)) {
    throw new Error("ASSET_CAPABILITY_KEY_RING_INVALID");
  }
  return Object.freeze({
    currentKeyRevision: root.currentKeyRevision,
    keys: Object.freeze(root.keys.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("ASSET_CAPABILITY_KEY_RING_INVALID");
      const key = item as Record<string, unknown>;
      if (Object.keys(key).some((field) => !["keyRevision", "keyBase64url"].includes(field)) ||
        typeof key.keyRevision !== "string" || typeof key.keyBase64url !== "string") {
        throw new Error("ASSET_CAPABILITY_KEY_RING_INVALID");
      }
      return Object.freeze({ keyRevision: key.keyRevision, key: Buffer.from(key.keyBase64url, "base64url") });
    })),
  });
}

function parseClaims(value: unknown): AssetUploadCapabilityClaims | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const claims = value as Record<string, unknown>;
  const fields = [
    "version", "audience", "storageTenantRef", "storageRegion", "siteRef", "subjectRef",
    "subjectGeneration", "projectRef", "purpose", "intentRef", "sessionRef", "quarantineObjectRef",
    "expectedSize", "expectedChecksumSha256", "capabilityEpoch", "expiresAt", "minimumPartBytes",
    "maximumPartBytes",
  ];
  if (Object.keys(claims).length !== fields.length || fields.some((field) => !(field in claims)) || claims.version !== 1) return null;
  for (const field of fields.slice(1)) if (typeof claims[field] !== "string") return null;
  if (!/^[1-9][0-9]*$/u.test(claims.subjectGeneration as string) ||
    !/^[1-9][0-9]*$/u.test(claims.expectedSize as string) ||
    !/^[1-9][0-9]*$/u.test(claims.capabilityEpoch as string) ||
    !/^[0-9a-f]{64}$/u.test(claims.expectedChecksumSha256 as string) ||
    !Number.isFinite(Date.parse(claims.expiresAt as string))) return null;
  return Object.freeze(claims) as unknown as AssetUploadCapabilityClaims;
}
