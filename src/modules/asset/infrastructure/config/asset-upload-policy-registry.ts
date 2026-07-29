import type {
  AssetPolicyResolution,
  AssetPolicyResolverPort,
} from "../../application/contracts/asset-upload-ports.js";

export interface AssetUploadPolicyProfile {
  readonly siteRef: string;
  readonly siteReleaseRef: string;
  readonly bindingEpoch: bigint;
  readonly purpose: string;
  readonly policyRevisionRef: string;
  readonly quotaRevisionRef: string;
  readonly storageTenantRef: string;
  readonly storageRegion: string;
  readonly uploadAudience: string;
  readonly uploadEndpoint: string;
  readonly allowedOrigins: readonly string[];
  readonly allowedClientMediaTypes: readonly string[];
  readonly maximumFileBytes: bigint;
  readonly maximumInflightBytes: bigint;
  readonly maximumReadyBytes: bigint;
  readonly minimumPartBytes: bigint;
  readonly maximumPartBytes: bigint;
  readonly capabilityLifetimeSeconds: number;
  readonly sessionLifetimeSeconds: number;
}

export interface AssetUploadEndpointResolver {
  resolveEndpoint(audience: string): string;
  allowsOrigin(audience: string, origin: string): boolean;
}

export class AssetUploadPolicyRegistry implements AssetPolicyResolverPort, AssetUploadEndpointResolver {
  readonly #profiles: readonly AssetUploadPolicyProfile[];

  constructor(profiles: readonly AssetUploadPolicyProfile[]) {
    if (profiles.length < 1 || profiles.length > 10_000) throw new Error("ASSET_POLICY_REGISTRY_INVALID");
    const identities = new Set<string>();
    for (const profile of profiles) {
      validateProfile(profile);
      const identity = [profile.siteRef, profile.siteReleaseRef, profile.bindingEpoch, profile.purpose].join("\0");
      if (identities.has(identity)) throw new Error("ASSET_POLICY_REGISTRY_DUPLICATE");
      identities.add(identity);
    }
    this.#profiles = Object.freeze(profiles.map((profile) => Object.freeze({
      ...profile,
      allowedOrigins: Object.freeze([...profile.allowedOrigins]),
      allowedClientMediaTypes: Object.freeze([...profile.allowedClientMediaTypes]),
    })));
  }

  async resolve(input: Parameters<AssetPolicyResolverPort["resolve"]>[0]): Promise<AssetPolicyResolution> {
    const profile = this.#profiles.find((candidate) =>
      candidate.siteRef === input.siteRef && candidate.siteReleaseRef === input.siteReleaseRef &&
      candidate.bindingEpoch === input.bindingEpoch && candidate.purpose === input.purpose);
    if (profile === undefined) throw new Error("ASSET_NOT_ACCEPTED");
    const mediaType = input.clientMediaType.trim().toLowerCase();
    if (!profile.allowedClientMediaTypes.includes(mediaType) || input.expectedSize > profile.maximumFileBytes) {
      throw new Error("ASSET_NOT_ACCEPTED");
    }
    const expiresAt = new Date(Date.parse(input.now) + profile.sessionLifetimeSeconds * 1_000).toISOString();
    return Object.freeze({
      policy: Object.freeze({
        policyRevisionRef: profile.policyRevisionRef,
        purpose: profile.purpose,
        storageRegion: profile.storageRegion,
        maximumFileBytes: profile.maximumFileBytes,
        maximumInflightBytes: profile.maximumInflightBytes,
        maximumReadyBytes: profile.maximumReadyBytes,
        allowedClientMediaTypes: profile.allowedClientMediaTypes,
        expiresAt,
      }),
      quotaRevisionRef: profile.quotaRevisionRef,
      storageTenantRef: profile.storageTenantRef,
      uploadAudience: profile.uploadAudience,
      allowedOrigins: profile.allowedOrigins,
      minimumPartBytes: profile.minimumPartBytes,
      maximumPartBytes: profile.maximumPartBytes,
      capabilityLifetimeSeconds: profile.capabilityLifetimeSeconds,
    });
  }

  resolveEndpoint(audience: string): string {
    const matches = this.#profiles.filter((profile) => profile.uploadAudience === audience)
      .map((profile) => profile.uploadEndpoint);
    if (matches.length === 0 || new Set(matches).size !== 1) throw new Error("ASSET_UPLOAD_AUDIENCE_INVALID");
    return matches[0]!;
  }

  allowsOrigin(audience: string, origin: string): boolean {
    if (exactHttpsOrigin(origin) === null) return false;
    return this.#profiles.some((profile) =>
      profile.uploadAudience === audience && profile.allowedOrigins.includes(origin));
  }
}

export function parseAssetUploadPolicyRegistry(value: unknown): AssetUploadPolicyRegistry {
  const root = record(value, "ASSET_POLICY_REGISTRY_INVALID");
  exact(root, ["version", "profiles"], "ASSET_POLICY_REGISTRY_INVALID");
  if (root.version !== 1 || !Array.isArray(root.profiles)) throw new Error("ASSET_POLICY_REGISTRY_INVALID");
  return new AssetUploadPolicyRegistry(root.profiles.map(parseProfile));
}

function parseProfile(value: unknown): AssetUploadPolicyProfile {
  const profile = record(value, "ASSET_POLICY_REGISTRY_INVALID");
  exact(profile, [
    "siteRef", "siteReleaseRef", "bindingEpoch", "purpose", "policyRevisionRef", "quotaRevisionRef",
    "storageTenantRef", "storageRegion", "uploadAudience", "uploadEndpoint", "allowedClientMediaTypes",
    "allowedOrigins",
    "maximumFileBytes", "maximumInflightBytes", "maximumReadyBytes", "minimumPartBytes",
    "maximumPartBytes", "capabilityLifetimeSeconds", "sessionLifetimeSeconds",
  ], "ASSET_POLICY_REGISTRY_INVALID");
  if (!Array.isArray(profile.allowedClientMediaTypes) || !Array.isArray(profile.allowedOrigins)) {
    throw new Error("ASSET_POLICY_REGISTRY_INVALID");
  }
  return Object.freeze({
    siteRef: text(profile.siteRef), siteReleaseRef: text(profile.siteReleaseRef),
    bindingEpoch: positive(profile.bindingEpoch), purpose: text(profile.purpose),
    policyRevisionRef: text(profile.policyRevisionRef), quotaRevisionRef: text(profile.quotaRevisionRef),
    storageTenantRef: text(profile.storageTenantRef), storageRegion: text(profile.storageRegion),
    uploadAudience: text(profile.uploadAudience), uploadEndpoint: text(profile.uploadEndpoint),
    allowedOrigins: Object.freeze(profile.allowedOrigins.map((item) => text(item))),
    allowedClientMediaTypes: Object.freeze(profile.allowedClientMediaTypes.map((item) => text(item).toLowerCase())),
    maximumFileBytes: positive(profile.maximumFileBytes), maximumInflightBytes: positive(profile.maximumInflightBytes),
    maximumReadyBytes: positive(profile.maximumReadyBytes), minimumPartBytes: positive(profile.minimumPartBytes),
    maximumPartBytes: positive(profile.maximumPartBytes),
    capabilityLifetimeSeconds: integer(profile.capabilityLifetimeSeconds),
    sessionLifetimeSeconds: integer(profile.sessionLifetimeSeconds),
  });
}

function validateProfile(value: AssetUploadPolicyProfile): void {
  let endpoint: URL;
  try { endpoint = new URL(value.uploadEndpoint); }
  catch { throw new Error("ASSET_POLICY_REGISTRY_INVALID"); }
  for (const field of [value.siteRef, value.siteReleaseRef, value.purpose, value.policyRevisionRef,
    value.quotaRevisionRef, value.storageTenantRef, value.storageRegion, value.uploadAudience]) {
    if (field.length < 1 || field.length > 256) throw new Error("ASSET_POLICY_REGISTRY_INVALID");
  }
  if (
    endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== "" ||
    endpoint.search !== "" || endpoint.hash !== "" || value.uploadEndpoint.length > 512 ||
    value.allowedOrigins.length < 1 || value.allowedOrigins.length > 32 ||
    new Set(value.allowedOrigins).size !== value.allowedOrigins.length ||
    value.allowedOrigins.some((origin) => exactHttpsOrigin(origin) === null) ||
    value.allowedClientMediaTypes.length < 1 || value.allowedClientMediaTypes.length > 256 ||
    new Set(value.allowedClientMediaTypes).size !== value.allowedClientMediaTypes.length ||
    value.allowedClientMediaTypes.some((mediaType) =>
      !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mediaType)) ||
    value.maximumInflightBytes < value.maximumFileBytes || value.maximumReadyBytes < value.maximumFileBytes ||
    value.maximumPartBytes < value.minimumPartBytes || value.bindingEpoch < 1n ||
    value.capabilityLifetimeSeconds < 30 || value.capabilityLifetimeSeconds > 900 ||
    value.sessionLifetimeSeconds < value.capabilityLifetimeSeconds || value.sessionLifetimeSeconds > 86_400
  ) throw new Error("ASSET_POLICY_REGISTRY_INVALID");
}

export function exactHttpsOrigin(value: string): string | null {
  if (value.length < 1 || value.length > 512) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" ||
      parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "" ||
      parsed.origin !== value
    ) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[], code: string): void {
  if (Object.keys(value).some((field) => !fields.includes(field))) throw new Error(code);
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length < 1) throw new Error("ASSET_POLICY_REGISTRY_INVALID");
  return value;
}

function positive(value: unknown): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/u.test(value)) throw new Error("ASSET_POLICY_REGISTRY_INVALID");
  return BigInt(value);
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("ASSET_POLICY_REGISTRY_INVALID");
  return value;
}
