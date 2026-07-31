import type {
  ArtifactByteRange,
  ArtifactOwnerScope,
  ArtifactReadyReceipt,
  ArtifactStagedReceipt,
  ArtifactTrustDecision,
} from "../domain/artifact.js";
import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";

export interface ArtifactObjectStore {
  stage(input: Readonly<{
    ownerScope: ArtifactOwnerScope;
    artifactRef: string;
    artifactVersionRef: string;
    bytes: Uint8Array;
    mediaType: "image/png" | "image/jpeg" | "image/webp";
  }>): Promise<ArtifactStagedReceipt>;
  promote(input: Readonly<{
    stagedReceipt: ArtifactStagedReceipt;
    trustDecision: ArtifactTrustDecision;
  }>): Promise<ArtifactReadyReceipt>;
  cleanupStaged(input: Readonly<{
    ownerScope: ArtifactOwnerScope;
    artifactRef: string;
    artifactVersionRef: string;
    stagedObjectRef: string;
  }>, signal: AbortSignal): Promise<void>;
  describeReady(input: Readonly<{
    ownerScope: ArtifactOwnerScope;
    artifactRef: string;
    artifactVersionRef: string;
  }>): Promise<ArtifactReadyReceipt | null>;
  openReady(input: Readonly<{
    ownerScope: ArtifactOwnerScope;
    artifactRef: string;
    artifactVersionRef: string;
    range?: ArtifactByteRange | undefined;
    signal: AbortSignal;
  }>): Promise<Readonly<{
    body: AsyncIterable<Uint8Array>;
    byteSize: number;
    mediaType: "image/png" | "image/jpeg" | "image/webp";
  }>>;
}

export type ArtifactDeliveryPurpose = "preview" | "download" | "export";

export type ArtifactDeliveryWorkloadBinding = Readonly<{
  siteRef: string;
  siteReleaseRef: string;
  workloadIdentityRef: string;
  workloadBindingEpoch: bigint;
  siteSecurityEpoch: bigint;
}>;

export type StoredArtifactDeliveryAuthorization = Readonly<{
  authorizationRef: string;
  capabilityDigest: string;
  ownerScope: ArtifactOwnerScope;
  artifactRef: string;
  artifactVersionRef: string;
  purpose: ArtifactDeliveryPurpose;
  suggestedFileName?: string | undefined;
  audience: "site-bff.artifact-delivery";
  workload: ArtifactDeliveryWorkloadBinding;
  issuedAt: string;
  expiresAt: string;
  revocationEpoch: bigint;
  revokedAt?: string | undefined;
}>;

export interface ArtifactDeliveryAuthorizationRepository {
  create(record: StoredArtifactDeliveryAuthorization): Promise<void>;
  findByCapabilityDigest(capabilityDigest: string): Promise<StoredArtifactDeliveryAuthorization | null>;
  findByReference(authorizationRef: string): Promise<StoredArtifactDeliveryAuthorization | null>;
  revoke(input: Readonly<{ authorizationRef: string; revokedAt: string; expectedRevocationEpoch: bigint }>):
    Promise<StoredArtifactDeliveryAuthorization | null>;
}

export interface ArtifactDeliveryCapabilityCodecPort {
  issue(): Readonly<{ deliveryCapability: string; capabilityDigest: string }>;
  verify(deliveryCapability: string): string;
}

export interface ArtifactOwnerCursorCodec {
  encode(value: Readonly<Record<string, string>>): string;
  decode(value: string): Readonly<Record<string, string>>;
}

export interface ArtifactSummaryRecord extends Record<string, unknown> {
  artifactRef: string;
  currentArtifactVersionRef: string;
  availability: string;
  title: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface ArtifactVersionRecord extends Record<string, unknown> {
  artifactRef: string;
  artifactVersionRef: string;
  availability: string;
  ownerVersion: bigint | string;
  versionNumber: bigint | string;
  sourceArtifactVersionRefs: unknown;
  byteSize: bigint | string | null;
  mediaType: string | null;
  width: number | null;
  height: number | null;
  createdAt: Date | string;
}

/** Application port; SQL functions and transaction details stay behind infrastructure. */
export interface ArtifactPublicRepository {
  listArtifacts(transaction: PlatformTransaction, input: Readonly<{
    createdBefore: string | null;
    artifactRefBefore: string | null;
    limit: number;
  }>): Promise<readonly ArtifactSummaryRecord[]>;
  getArtifact(transaction: PlatformTransaction, artifactRef: string):
    Promise<ArtifactSummaryRecord | null>;
  listVersions(transaction: PlatformTransaction, input: Readonly<{
    artifactRef: string;
    createdBefore: string | null;
    artifactVersionRefBefore: string | null;
    limit: number;
  }>): Promise<readonly ArtifactVersionRecord[]>;
  getVersion(transaction: PlatformTransaction, artifactRef: string, artifactVersionRef: string):
    Promise<ArtifactVersionRecord | null>;
  createAuthorization(transaction: PlatformTransaction,
    record: StoredArtifactDeliveryAuthorization): Promise<void>;
  revokeAuthorization(transaction: PlatformTransaction, input: Readonly<{
    authorizationRef: string;
    revokedAt: string;
    reason?: string | undefined;
  }>): Promise<Readonly<{
    state: "revoked" | "already_revoked" | "expired";
    revokedAt: string;
  }> | null>;
}

export type ArtifactDeliveryAuditRecord = Readonly<{
  redemptionRef: string;
  authorizationRef: string;
  requestRef: string;
  workload: ArtifactDeliveryWorkloadBinding;
  rangeHeader?: string | undefined;
  attemptedAt: string;
  /** `stream_completed` means the server consumed and emitted the exact object bytes; it is not a client receipt. */
  state: "pending" | "stream_completed" | "failed";
  streamCompletedAt?: string | undefined;
  bytesEmitted?: bigint | undefined;
  failureCode?: "range_rejected" | "storage_failed" | "client_aborted" | undefined;
}>;

export interface ArtifactDeliveryAuditRepository {
  begin(record: ArtifactDeliveryAuditRecord): Promise<void>;
  completeStream(input: Readonly<{
    redemptionRef: string;
    streamCompletedAt: string;
    bytesEmitted: bigint;
  }>): Promise<void>;
  fail(input: Readonly<{
    redemptionRef: string;
    failedAt: string;
    failureCode: NonNullable<ArtifactDeliveryAuditRecord["failureCode"]>;
  }>): Promise<void>;
}
