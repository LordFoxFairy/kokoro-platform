import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type {
  AssetUploadCapability,
  AssetUploadCapabilityIssuerPort,
} from "../../application/contracts/asset-upload-ports.js";
import type { AssetUploadEndpointResolver } from "../config/asset-upload-policy-registry.js";
import { exactHttpsOrigin } from "../config/asset-upload-policy-registry.js";

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
  readonly workloadIdentityId: string;
  readonly siteReleaseRef: string;
  readonly bindingEpoch: string;
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
  readonly allowedOrigins: readonly string[];
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
      workloadIdentityId: input.workloadIdentityId,
      siteReleaseRef: input.siteReleaseRef,
      bindingEpoch: input.bindingEpoch.toString(),
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
      allowedOrigins: Object.freeze([...input.allowedOrigins]),
    });
    if (parseClaims(claims) === null) throw new Error("ASSET_CAPABILITY_CLAIMS_INVALID");
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
    "version", "audience", "storageTenantRef", "storageRegion", "siteRef", "workloadIdentityId",
    "siteReleaseRef", "bindingEpoch", "subjectRef", "subjectGeneration", "projectRef", "purpose",
    "intentRef", "sessionRef", "quarantineObjectRef", "expectedSize", "expectedChecksumSha256",
    "capabilityEpoch", "expiresAt", "minimumPartBytes", "maximumPartBytes", "allowedOrigins",
  ];
  if (Object.keys(claims).length !== fields.length || fields.some((field) => !(field in claims)) || claims.version !== 1) return null;
  const textFields = [
    "audience", "storageTenantRef", "storageRegion", "siteRef", "workloadIdentityId",
    "siteReleaseRef", "bindingEpoch", "subjectRef", "subjectGeneration", "projectRef", "purpose",
    "intentRef", "sessionRef", "quarantineObjectRef", "expectedSize", "expectedChecksumSha256",
    "capabilityEpoch", "expiresAt", "minimumPartBytes", "maximumPartBytes",
  ];
  if (textFields.some((field) => typeof claims[field] !== "string") ||
      !Array.isArray(claims.allowedOrigins)) return null;
  const boundedFields = [
    "audience", "storageTenantRef", "storageRegion", "siteRef", "workloadIdentityId",
    "siteReleaseRef", "subjectRef", "projectRef", "intentRef", "sessionRef",
  ];
  if (boundedFields.some((field) => !boundedText(claims[field], 1, 256)) ||
      !boundedText(claims.purpose, 1, 128) ||
      !boundedText(claims.quarantineObjectRef, 16, 1_024) ||
      !positiveUint64(claims.bindingEpoch) || !positiveUint64(claims.subjectGeneration) ||
      !positiveUint64(claims.expectedSize) || !positiveUint64(claims.capabilityEpoch) ||
      !positiveUint64(claims.minimumPartBytes) || !positiveUint64(claims.maximumPartBytes) ||
      BigInt(claims.minimumPartBytes as string) > BigInt(claims.maximumPartBytes as string) ||
      !/^[0-9a-f]{64}$/u.test(claims.expectedChecksumSha256 as string) ||
      !Number.isFinite(Date.parse(claims.expiresAt as string))) return null;
  const allowedOrigins = claims.allowedOrigins;
  if (allowedOrigins.length < 1 || allowedOrigins.length > 32 ||
      allowedOrigins.some((origin) => typeof origin !== "string" || exactHttpsOrigin(origin) === null) ||
      new Set(allowedOrigins).size !== allowedOrigins.length) return null;
  return Object.freeze({ ...claims,
    allowedOrigins: Object.freeze([...allowedOrigins]) }) as unknown as AssetUploadCapabilityClaims;
}

function positiveUint64(value: unknown): boolean {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/u.test(value)) return false;
  return value.length < 20 || value <= "18446744073709551615";
}

function boundedText(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum &&
    ![...value].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point < 32 || point === 127;
    });
}
