import type { Readable } from "node:stream";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { AssetUploadCapabilityClaims } from "./asset-upload-ports.js";

export type AssetMultipartState =
  | "initiating"
  | "uploading"
  | "completing"
  | "uploaded"
  | "aborting"
  | "aborted"
  | "integrity_rejected"
  | "outcome_unknown";

export type AssetMultipartOutcomeOperation = "initiate" | "complete" | "abort";

export interface StoredAssetMultipartUpload {
  readonly uploadRef: string;
  readonly siteRef: string;
  readonly intentRef: string;
  readonly sessionRef: string;
  readonly clientUploadId: string;
  readonly providerUploadId: string | null;
  readonly capabilityEpoch: bigint;
  readonly state: AssetMultipartState;
  readonly outcomeOperation: AssetMultipartOutcomeOperation | null;
  readonly expectedVersion: bigint;
  readonly initiationIdempotencyKey: string;
  readonly initiationRequestDigest: string;
  readonly initiationReceiptRef: string;
  readonly initiationEffectToken: string | null;
  readonly initiationEffectLeaseExpiresAt: string | null;
  readonly completionIdempotencyKey: string | null;
  readonly completionRequestDigest: string | null;
  readonly completionReceiptRef: string | null;
  readonly completionEffectToken: string | null;
  readonly completionEffectLeaseExpiresAt: string | null;
  readonly abortIdempotencyKey: string | null;
  readonly abortRequestDigest: string | null;
  readonly abortReceiptRef: string | null;
  readonly abortEffectToken: string | null;
  readonly abortEffectLeaseExpiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredAssetMultipartPart {
  readonly partNumber: number;
  readonly partReceipt: string;
  readonly providerEtag: string | null;
  readonly size: bigint;
  readonly checksumSha256: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly state: "pending" | "retryable" | "committed" | "outcome_unknown";
  readonly expectedVersion: bigint;
  readonly effectToken: string | null;
  readonly effectLeaseExpiresAt: string | null;
}

export interface AuthorizedAssetMultipartSnapshot {
  readonly claims: AssetUploadCapabilityClaims;
  readonly upload: StoredAssetMultipartUpload | null;
  readonly parts: readonly StoredAssetMultipartPart[];
}

export interface AssetMultipartUnitOfWorkPort {
  execute<Result>(
    claims: AssetUploadCapabilityClaims,
    operation: string,
    work: (transaction: PlatformTransaction) => Promise<Result>,
  ): Promise<Result>;
}

export interface AssetMultipartRepositoryPort {
  readAuthorized(
    transaction: PlatformTransaction,
    claims: AssetUploadCapabilityClaims,
    uploadRef?: string,
  ): Promise<AuthorizedAssetMultipartSnapshot | null>;
  claimInitiation(
    transaction: PlatformTransaction,
    input: Readonly<{
      claims: AssetUploadCapabilityClaims;
      uploadRef: string;
      clientUploadId: string;
      idempotencyKey: string;
      requestDigest: string;
      receiptRef: string;
      effectToken: string;
      effectLeaseExpiresAt: string;
      now: string;
    }>,
  ): Promise<AuthorizedAssetMultipartSnapshot>;
  recordInitiated(
    transaction: PlatformTransaction,
    input: Readonly<{
      claims: AssetUploadCapabilityClaims;
      uploadRef: string;
      expectedVersion: bigint;
      providerUploadId: string;
      effectToken: string;
      now: string;
    }>,
  ): Promise<AuthorizedAssetMultipartSnapshot>;
  recordInitiationUnknown(
    transaction: PlatformTransaction,
    input: Readonly<{
      claims: AssetUploadCapabilityClaims;
      uploadRef: string;
      expectedVersion: bigint;
      effectToken: string;
      now: string;
    }>,
  ): Promise<AuthorizedAssetMultipartSnapshot>;
  releaseInitiation(
    transaction: PlatformTransaction,
    input: Readonly<{
      claims: AssetUploadCapabilityClaims;
      uploadRef: string;
      expectedVersion: bigint;
      effectToken: string;
      now: string;
    }>,
  ): Promise<AuthorizedAssetMultipartSnapshot>;
  claimPart(
    transaction: PlatformTransaction,
    input: Readonly<{
      claims: AssetUploadCapabilityClaims;
      uploadRef: string;
      partNumber: number;
      partReceipt: string;
      size: bigint;
      checksumSha256: string;
      idempotencyKey: string;
      requestDigest: string;
      effectToken: string;
      effectLeaseExpiresAt: string;
      now: string;
    }>,
  ): Promise<AuthorizedAssetMultipartSnapshot>;
  finishPart(
    transaction: PlatformTransaction,
    input: Readonly<{
      claims: AssetUploadCapabilityClaims;
      uploadRef: string;
      partNumber: number;
      expectedPartVersion: bigint;
      effectToken: string;
      providerEtag: string | null;
      state: "committed" | "outcome_unknown";
      now: string;
    }>,
  ): Promise<AuthorizedAssetMultipartSnapshot>;
  releasePart(
    transaction: PlatformTransaction,
    input: Readonly<{
      claims: AssetUploadCapabilityClaims;
      uploadRef: string;
      partNumber: number;
      expectedPartVersion: bigint;
      effectToken: string;
      now: string;
    }>,
  ): Promise<AuthorizedAssetMultipartSnapshot>;
  beginCompletion(
    transaction: PlatformTransaction,
    input: Readonly<{
      claims: AssetUploadCapabilityClaims;
      uploadRef: string;
      expectedVersion: bigint;
      idempotencyKey: string;
      requestDigest: string;
      receiptRef: string;
      effectToken: string;
      effectLeaseExpiresAt: string;
      now: string;
    }>,
  ): Promise<AuthorizedAssetMultipartSnapshot>;
  claimCompletionEffect(
    transaction: PlatformTransaction,
    input: Readonly<{
      claims: AssetUploadCapabilityClaims;
      uploadRef: string;
      expectedVersion: bigint;
      effectToken: string;
      effectLeaseExpiresAt: string;
      now: string;
    }>,
  ): Promise<AuthorizedAssetMultipartSnapshot>;
  releaseCompletionEffect(
    transaction: PlatformTransaction,
    input: Readonly<{
      claims: AssetUploadCapabilityClaims;
      uploadRef: string;
      expectedVersion: bigint;
      effectToken: string;
      now: string;
    }>,
  ): Promise<AuthorizedAssetMultipartSnapshot>;
  finishCompletion(
    transaction: PlatformTransaction,
    input: Readonly<{
      claims: AssetUploadCapabilityClaims;
      uploadRef: string;
      expectedVersion: bigint;
      effectToken: string;
      state: "uploaded" | "outcome_unknown";
      now: string;
    }>,
  ): Promise<AuthorizedAssetMultipartSnapshot>;
  rejectIntegrity(
    transaction: PlatformTransaction,
    input: Readonly<{
      claims: AssetUploadCapabilityClaims;
      uploadRef: string;
      expectedVersion: bigint;
      safeReasonCode: "UPLOAD_PART_INVALID";
      effectOperation: "complete" | "abort";
      effectToken: string;
      eventId: string;
      correlationId: string;
      now: string;
    }>,
  ): Promise<AuthorizedAssetMultipartSnapshot>;
  beginAbort(
    transaction: PlatformTransaction,
    input: Readonly<{
      claims: AssetUploadCapabilityClaims;
      uploadRef: string;
      expectedVersion: bigint;
      idempotencyKey: string;
      requestDigest: string;
      receiptRef: string;
      effectToken: string;
      effectLeaseExpiresAt: string;
      now: string;
    }>,
  ): Promise<AuthorizedAssetMultipartSnapshot>;
  claimAbortEffect(
    transaction: PlatformTransaction,
    input: Readonly<{
      claims: AssetUploadCapabilityClaims;
      uploadRef: string;
      expectedVersion: bigint;
      effectToken: string;
      effectLeaseExpiresAt: string;
      now: string;
    }>,
  ): Promise<AuthorizedAssetMultipartSnapshot>;
  releaseAbortEffect(
    transaction: PlatformTransaction,
    input: Readonly<{
      claims: AssetUploadCapabilityClaims;
      uploadRef: string;
      expectedVersion: bigint;
      effectToken: string;
      now: string;
    }>,
  ): Promise<AuthorizedAssetMultipartSnapshot>;
  finishAbort(
    transaction: PlatformTransaction,
    input: Readonly<{
      claims: AssetUploadCapabilityClaims;
      uploadRef: string;
      expectedVersion: bigint;
      effectToken: string;
      state: "aborted" | "uploaded" | "outcome_unknown";
      now: string;
    }>,
  ): Promise<AuthorizedAssetMultipartSnapshot>;
}

export interface AssetMultipartStorePort {
  initiate(input: Readonly<{
    storageTenantRef: string;
    storageRegion: string;
    objectRef: string;
    uploadRef: string;
    signal: AbortSignal;
  }>): Promise<string>;
  recoverInitiation(input: Readonly<{
    storageTenantRef: string;
    storageRegion: string;
    objectRef: string;
    signal: AbortSignal;
  }>): Promise<string | null>;
  putPart(input: Readonly<{
    storageTenantRef: string;
    storageRegion: string;
    objectRef: string;
    providerUploadId: string;
    partNumber: number;
    declaredSize: bigint;
    checksumSha256: string;
    body: Readable;
    signal: AbortSignal;
  }>): Promise<string>;
  complete(input: Readonly<{
    storageTenantRef: string;
    storageRegion: string;
    objectRef: string;
    providerUploadId: string;
    parts: readonly Readonly<{
      partNumber: number;
      providerEtag: string;
      checksumSha256: string;
    }>[];
    signal: AbortSignal;
  }>): Promise<void>;
  abort(input: Readonly<{
    storageTenantRef: string;
    storageRegion: string;
    objectRef: string;
    providerUploadId: string;
    signal: AbortSignal;
  }>): Promise<"aborted" | "already_absent">;
  observeCompleted(input: Readonly<{
    storageTenantRef: string;
    storageRegion: string;
    objectRef: string;
    expectedSize: bigint;
    expectedChecksumSha256: string;
    signal: AbortSignal;
  }>): Promise<"absent" | "exact">;
}

/** The provider effect may have committed although its transport result was not observed. */
export class AssetMultipartProviderOutcomeUnknownError extends Error {
  override readonly name = "AssetMultipartProviderOutcomeUnknownError";
}

/** The provider or request rejected deterministically; repeating the same bytes is safe. */
export class AssetMultipartProviderRejectedError extends Error {
  override readonly name = "AssetMultipartProviderRejectedError";
}
