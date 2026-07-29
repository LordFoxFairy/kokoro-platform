export type UploadSessionState =
  | "awaiting_capability"
  | "uploading"
  | "completing"
  | "reconciling_upload"
  | "validating"
  | "aborting"
  | "aborted"
  | "rejected";

export interface AssetPolicySnapshot {
  readonly policyRevisionRef: string;
  readonly purpose: string;
  readonly storageRegion: string;
  readonly maximumFileBytes: bigint;
  readonly maximumInflightBytes: bigint;
  readonly allowedClientMediaTypes: readonly string[];
  readonly expiresAt: string;
}

export interface AssetUploadIntent {
  readonly intentRef: string;
  readonly siteRef: string;
  readonly workloadIdentityId: string;
  readonly siteReleaseRef: string;
  readonly bindingEpoch: bigint;
  readonly subjectRef: string;
  readonly subjectGeneration: bigint;
  readonly projectRef: string;
  readonly purpose: string;
  readonly safeDisplayName: string;
  readonly clientMediaType: string;
  readonly expectedSize: bigint;
  readonly expectedChecksumSha256: string;
  readonly policyRevisionRef: string;
  readonly state: "admitted" | "aborted" | "rejected";
  readonly expectedVersion: bigint;
  readonly expiresAt: string;
}

export interface AssetUploadSession {
  readonly sessionRef: string;
  readonly intentRef: string;
  readonly siteRef: string;
  readonly subjectRef: string;
  readonly subjectGeneration: bigint;
  readonly projectRef: string;
  readonly purpose: string;
  readonly quotaRevisionRef: string;
  readonly storageTenantRef: string;
  readonly storageRegion: string;
  readonly quarantineObjectRef: string;
  readonly protocolRevision: "s3-multipart-v1";
  readonly capabilityAudience: string;
  readonly minimumPartBytes: bigint;
  readonly maximumPartBytes: bigint;
  readonly capabilityLifetimeSeconds: number;
  readonly capabilityEpoch: bigint;
  readonly capabilityExpiresAt: string | null;
  readonly state: UploadSessionState;
  readonly expectedVersion: bigint;
  readonly expiresAt: string;
}

export function createUploadIntent(input: Readonly<{
  intentRef: string;
  siteRef: string;
  workloadIdentityId: string;
  siteReleaseRef: string;
  bindingEpoch: bigint;
  subjectRef: string;
  subjectGeneration: bigint;
  projectRef: string;
  purpose: string;
  filename: string;
  clientMediaType: string;
  expectedSize: bigint;
  expectedChecksumSha256: string;
  policy: AssetPolicySnapshot;
  now: string;
}>): AssetUploadIntent {
  identifier(input.intentRef, "ASSET_UPLOAD_INTENT_REF_INVALID");
  identifier(input.siteRef, "ASSET_SITE_REF_INVALID");
  identifier(input.workloadIdentityId, "ASSET_WORKLOAD_IDENTITY_INVALID");
  identifier(input.siteReleaseRef, "ASSET_SITE_RELEASE_INVALID");
  if (input.bindingEpoch < 1n) throw new Error("ASSET_BINDING_EPOCH_INVALID");
  identifier(input.subjectRef, "ASSET_SUBJECT_REF_INVALID");
  identifier(input.projectRef, "ASSET_PROJECT_REF_INVALID");
  bounded(input.purpose, 1, 128, "ASSET_PURPOSE_INVALID");
  if (input.purpose !== input.policy.purpose) throw new Error("ASSET_POLICY_PURPOSE_MISMATCH");
  if (input.subjectGeneration < 1n) throw new Error("ASSET_SUBJECT_GENERATION_INVALID");
  if (input.expectedSize < 1n || input.expectedSize > input.policy.maximumFileBytes) {
    throw new Error("ASSET_UPLOAD_SIZE_NOT_ALLOWED");
  }
  if (!/^[0-9a-f]{64}$/u.test(input.expectedChecksumSha256)) throw new Error("ASSET_CHECKSUM_INVALID");
  const mediaType = canonicalMediaType(input.clientMediaType);
  if (!input.policy.allowedClientMediaTypes.includes(mediaType)) throw new Error("ASSET_MEDIA_TYPE_NOT_ALLOWED");
  instant(input.now, "ASSET_UPLOAD_TIME_INVALID");
  instant(input.policy.expiresAt, "ASSET_POLICY_EXPIRY_INVALID");
  if (Date.parse(input.policy.expiresAt) <= Date.parse(input.now)) throw new Error("ASSET_POLICY_EXPIRED");
  identifier(input.policy.policyRevisionRef, "ASSET_POLICY_REVISION_INVALID");
  bounded(input.policy.storageRegion, 1, 128, "ASSET_STORAGE_REGION_INVALID");
  if (input.policy.maximumInflightBytes < input.policy.maximumFileBytes) {
    throw new Error("ASSET_POLICY_QUOTA_INVALID");
  }
  return Object.freeze({
    intentRef: input.intentRef,
    siteRef: input.siteRef,
    workloadIdentityId: input.workloadIdentityId,
    siteReleaseRef: input.siteReleaseRef,
    bindingEpoch: input.bindingEpoch,
    subjectRef: input.subjectRef,
    subjectGeneration: input.subjectGeneration,
    projectRef: input.projectRef,
    purpose: input.purpose,
    safeDisplayName: safeFilename(input.filename),
    clientMediaType: mediaType,
    expectedSize: input.expectedSize,
    expectedChecksumSha256: input.expectedChecksumSha256,
    policyRevisionRef: input.policy.policyRevisionRef,
    state: "admitted",
    expectedVersion: 1n,
    expiresAt: input.policy.expiresAt,
  });
}

export function createUploadSession(input: Readonly<{
  sessionRef: string;
  intent: AssetUploadIntent;
  quotaRevisionRef: string;
  storageTenantRef: string;
  storageRegion: string;
  quarantineObjectRef: string;
  capabilityAudience: string;
  minimumPartBytes: bigint;
  maximumPartBytes: bigint;
  capabilityLifetimeSeconds: number;
}>): AssetUploadSession {
  verifyUploadIntent(input.intent);
  if (input.intent.state !== "admitted") throw new Error("ASSET_UPLOAD_INTENT_NOT_ADMITTED");
  identifier(input.sessionRef, "ASSET_UPLOAD_SESSION_REF_INVALID");
  identifier(input.quotaRevisionRef, "ASSET_QUOTA_REVISION_INVALID");
  identifier(input.storageTenantRef, "ASSET_STORAGE_TENANT_INVALID");
  bounded(input.storageRegion, 1, 128, "ASSET_STORAGE_REGION_INVALID");
  bounded(input.quarantineObjectRef, 16, 256, "ASSET_QUARANTINE_OBJECT_REF_INVALID");
  bounded(input.capabilityAudience, 3, 256, "ASSET_CAPABILITY_AUDIENCE_INVALID");
  if (
    input.minimumPartBytes < 1n || input.maximumPartBytes < input.minimumPartBytes ||
    !Number.isInteger(input.capabilityLifetimeSeconds) || input.capabilityLifetimeSeconds < 30 ||
    input.capabilityLifetimeSeconds > 900
  ) throw new Error("ASSET_UPLOAD_PROTOCOL_POLICY_INVALID");
  return Object.freeze({
    sessionRef: input.sessionRef,
    intentRef: input.intent.intentRef,
    siteRef: input.intent.siteRef,
    subjectRef: input.intent.subjectRef,
    subjectGeneration: input.intent.subjectGeneration,
    projectRef: input.intent.projectRef,
    purpose: input.intent.purpose,
    quotaRevisionRef: input.quotaRevisionRef,
    storageTenantRef: input.storageTenantRef,
    storageRegion: input.storageRegion,
    quarantineObjectRef: input.quarantineObjectRef,
    protocolRevision: "s3-multipart-v1",
    capabilityAudience: input.capabilityAudience,
    minimumPartBytes: input.minimumPartBytes,
    maximumPartBytes: input.maximumPartBytes,
    capabilityLifetimeSeconds: input.capabilityLifetimeSeconds,
    capabilityEpoch: 0n,
    capabilityExpiresAt: null,
    state: "awaiting_capability",
    expectedVersion: 1n,
    expiresAt: input.intent.expiresAt,
  });
}

export function markUploadCapabilityIssued(
  value: AssetUploadSession,
  expectedVersion: bigint,
  capabilityEpoch: bigint,
  capabilityExpiresAt: string,
): AssetUploadSession {
  verifyUploadSession(value);
  if (
    (value.state !== "awaiting_capability" && value.state !== "uploading") ||
    value.expectedVersion !== expectedVersion || capabilityEpoch !== value.capabilityEpoch + 1n
  ) {
    throw new Error("ASSET_UPLOAD_CAPABILITY_STATE_INVALID");
  }
  instant(capabilityExpiresAt, "ASSET_UPLOAD_CAPABILITY_EXPIRY_INVALID");
  if (Date.parse(capabilityExpiresAt) > Date.parse(value.expiresAt)) {
    throw new Error("ASSET_UPLOAD_CAPABILITY_OUTLIVES_SESSION");
  }
  return Object.freeze({
    ...value,
    capabilityEpoch,
    capabilityExpiresAt,
    state: "uploading",
    expectedVersion: increment(value.expectedVersion),
  });
}

export function beginUploadCompletion(
  value: AssetUploadSession,
  expectedVersion: bigint,
): AssetUploadSession {
  verifyUploadSession(value);
  if (value.state !== "uploading" || value.expectedVersion !== expectedVersion) {
    throw new Error("ASSET_UPLOAD_COMPLETION_CONFLICT");
  }
  return Object.freeze({ ...value, state: "completing", expectedVersion: increment(value.expectedVersion) });
}

export function verifyUploadIntent(value: AssetUploadIntent): AssetUploadIntent {
  identifier(value.intentRef, "ASSET_UPLOAD_INTENT_REF_INVALID");
  identifier(value.siteRef, "ASSET_SITE_REF_INVALID");
  identifier(value.workloadIdentityId, "ASSET_WORKLOAD_IDENTITY_INVALID");
  identifier(value.siteReleaseRef, "ASSET_SITE_RELEASE_INVALID");
  if (value.bindingEpoch < 1n) throw new Error("ASSET_BINDING_EPOCH_INVALID");
  identifier(value.subjectRef, "ASSET_SUBJECT_REF_INVALID");
  identifier(value.projectRef, "ASSET_PROJECT_REF_INVALID");
  bounded(value.purpose, 1, 128, "ASSET_PURPOSE_INVALID");
  bounded(value.safeDisplayName, 1, 255, "ASSET_FILENAME_INVALID");
  canonicalMediaType(value.clientMediaType);
  if (value.subjectGeneration < 1n || value.expectedSize < 1n || value.expectedVersion < 1n) {
    throw new Error("ASSET_UPLOAD_PERSISTED_VALUE_INVALID");
  }
  if (!/^[0-9a-f]{64}$/u.test(value.expectedChecksumSha256)) throw new Error("ASSET_CHECKSUM_INVALID");
  identifier(value.policyRevisionRef, "ASSET_POLICY_REVISION_INVALID");
  instant(value.expiresAt, "ASSET_UPLOAD_EXPIRY_INVALID");
  if (!["admitted", "aborted", "rejected"].includes(value.state)) throw new Error("ASSET_UPLOAD_INTENT_STATE_INVALID");
  return Object.freeze({ ...value });
}

export function verifyUploadSession(value: AssetUploadSession): AssetUploadSession {
  identifier(value.sessionRef, "ASSET_UPLOAD_SESSION_REF_INVALID");
  identifier(value.intentRef, "ASSET_UPLOAD_INTENT_REF_INVALID");
  identifier(value.siteRef, "ASSET_SITE_REF_INVALID");
  identifier(value.subjectRef, "ASSET_SUBJECT_REF_INVALID");
  identifier(value.projectRef, "ASSET_PROJECT_REF_INVALID");
  identifier(value.quotaRevisionRef, "ASSET_QUOTA_REVISION_INVALID");
  identifier(value.storageTenantRef, "ASSET_STORAGE_TENANT_INVALID");
  bounded(value.purpose, 1, 128, "ASSET_PURPOSE_INVALID");
  bounded(value.storageRegion, 1, 128, "ASSET_STORAGE_REGION_INVALID");
  bounded(value.quarantineObjectRef, 16, 256, "ASSET_QUARANTINE_OBJECT_REF_INVALID");
  bounded(value.capabilityAudience, 3, 256, "ASSET_CAPABILITY_AUDIENCE_INVALID");
  if (
    value.subjectGeneration < 1n || value.expectedVersion < 1n || value.capabilityEpoch < 0n ||
    value.minimumPartBytes < 1n || value.maximumPartBytes < value.minimumPartBytes ||
    !Number.isInteger(value.capabilityLifetimeSeconds) || value.capabilityLifetimeSeconds < 30 ||
    value.capabilityLifetimeSeconds > 900
  ) throw new Error("ASSET_UPLOAD_SESSION_VALUE_INVALID");
  instant(value.expiresAt, "ASSET_UPLOAD_EXPIRY_INVALID");
  if (value.capabilityExpiresAt !== null) instant(value.capabilityExpiresAt, "ASSET_UPLOAD_CAPABILITY_EXPIRY_INVALID");
  if (!new Set<UploadSessionState>(["awaiting_capability", "uploading", "completing",
    "reconciling_upload", "validating", "aborting", "aborted", "rejected"]).has(value.state)) {
    throw new Error("ASSET_UPLOAD_SESSION_STATE_INVALID");
  }
  return Object.freeze({ ...value });
}

function safeFilename(value: string): string {
  if (value.length < 1 || value.length > 1024) throw new Error("ASSET_FILENAME_INVALID");
  const normalized = Array.from(value.normalize("NFKC"))
    .filter(isSafeFilenameCharacter)
    .join("")
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .at(-1)
    ?.trim() ?? "";
  if (normalized.length < 1 || normalized === "." || normalized === "..") {
    throw new Error("ASSET_FILENAME_INVALID");
  }
  const result: string[] = [];
  let utf16Length = 0;
  for (const character of normalized) {
    if (utf16Length + character.length > 255) break;
    result.push(character);
    utf16Length += character.length;
  }
  return result.join("");
}

function isSafeFilenameCharacter(character: string): boolean {
  const point = character.codePointAt(0) ?? 0;
  if (point < 32 || point === 127) return false;
  if (point >= 0x202a && point <= 0x202e) return false;
  return point < 0x2066 || point > 0x2069;
}

function canonicalMediaType(value: string): string {
  const result = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/u.test(result)) {
    throw new Error("ASSET_MEDIA_TYPE_INVALID");
  }
  return result;
}

function identifier(value: string, code: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value)) throw new Error(code);
}

function bounded(value: string, minimum: number, maximum: number, code: string): void {
  if (value.length < minimum || value.length > maximum || Array.from(value).some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127;
  })) throw new Error(code);
}

function instant(value: string, code: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(code);
}

function increment(value: bigint): bigint {
  if (value >= 9_223_372_036_854_775_807n) throw new Error("ASSET_UPLOAD_VERSION_EXHAUSTED");
  return value + 1n;
}
