import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { CommandIdentity, CommandReceipt, JsonValue } from "../../../../shared/outbox-inbox/receipt.js";
import type { AssetPolicySnapshot, AssetUploadIntent, AssetUploadSession } from "../../domain/upload-intent.js";

export interface AssetUnitOfWorkPort {
  execute<Result>(
    fence: Readonly<{ context: VerifiedRequestSecurityContext; operation: string }>,
    work: (transaction: PlatformTransaction) => Promise<Result>,
  ): Promise<Result>;
}

export interface AssetPolicyResolution {
  readonly policy: AssetPolicySnapshot;
  readonly quotaRevisionRef: string;
  readonly storageTenantRef: string;
  readonly uploadAudience: string;
  readonly allowedOrigins: readonly string[];
  readonly minimumPartBytes: bigint;
  readonly maximumPartBytes: bigint;
  readonly capabilityLifetimeSeconds: number;
}

export interface AssetPolicyResolverPort {
  resolve(input: Readonly<{
    siteRef: string;
    siteReleaseRef: string;
    bindingEpoch: bigint;
    subjectRef: string;
    subjectGeneration: bigint;
    projectRef: string;
    purpose: string;
    clientMediaType: string;
    expectedSize: bigint;
    now: string;
  }>): Promise<AssetPolicyResolution>;
}

export type ClaimUploadIntentResult =
  | Readonly<{ disposition: "created" | "replay"; intent: AssetUploadIntent; session: AssetUploadSession }>
  | Readonly<{ disposition: "conflict" }>;

export interface AssetUploadRepositoryPort {
  claimUploadIntent(
    transaction: PlatformTransaction,
    input: Readonly<{
      intent: AssetUploadIntent;
      session: AssetUploadSession;
      idempotencyKey: string;
      requestDigest: string;
      maximumInflightBytes: bigint;
      maximumReadyBytes: bigint;
    }>,
  ): Promise<ClaimUploadIntentResult>;

  markCapabilityIssued(
    transaction: PlatformTransaction,
    input: Readonly<{
      siteRef: string;
      intentRef: string;
      expectedVersion: bigint;
      capabilityEpoch: bigint;
      expiresAt: string;
    }>,
  ): Promise<AssetUploadSession>;
}

export interface AssetUploadCommandReceiptPort {
  begin(transaction: PlatformTransaction, identity: CommandIdentity): Promise<CommandReceipt>;
  recordOutcome(
    transaction: PlatformTransaction,
    identity: CommandIdentity,
    outcome: Readonly<{
      state: "succeeded" | "failed" | "outcome_unknown";
      result: JsonValue | null;
      resultDigest: string;
    }>,
  ): Promise<CommandReceipt>;
}

export interface AssetUploadCapability {
  readonly protocolRevision: "s3-multipart-v1";
  readonly uploadEndpoint: string;
  readonly credential: string;
  readonly capabilityEpoch: bigint;
  readonly expiresAt: string;
  readonly minimumPartBytes: bigint;
  readonly maximumPartBytes: bigint;
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

export interface AssetUploadCapabilityIssuerPort {
  /**
   * Issues an opaque, initially inactive credential. The upload data plane MUST
   * authorize every use against the owner's current (sessionRef, capabilityEpoch)
   * projection; it must never return a standalone object-store credential.
   */
  issue(input: Readonly<{
    audience: string;
    storageTenantRef: string;
    storageRegion: string;
    siteRef: string;
    workloadIdentityId: string;
    siteReleaseRef: string;
    bindingEpoch: bigint;
    subjectRef: string;
    subjectGeneration: bigint;
    projectRef: string;
    purpose: string;
    intentRef: string;
    sessionRef: string;
    quarantineObjectRef: string;
    expectedSize: bigint;
    expectedChecksumSha256: string;
    capabilityEpoch: bigint;
    expiresAt: string;
    minimumPartBytes: bigint;
    maximumPartBytes: bigint;
    allowedOrigins: readonly string[];
  }>): Promise<AssetUploadCapability>;
}
