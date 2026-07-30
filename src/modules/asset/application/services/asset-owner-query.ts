import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { AssetUnitOfWorkPort } from "../contracts/asset-upload-ports.js";
import type {
  AssetAttachmentIntent,
  AssetOwnerQueryRepositoryPort,
  StoredAssetUploadStatus,
  StoredTrustedAssetGrant,
} from "../contracts/asset-owner-query-ports.js";
import { resolveAssetUserAuthority, type AssetOwnerAuthority } from "../asset-user-authority.js";

export interface AssetUploadStatusView {
  readonly intentRef: string;
  readonly sessionRef: string;
  readonly projectRef: string;
  readonly purpose: string;
  readonly safeDisplayName: string;
  readonly clientMediaType: string;
  readonly expectedSize: string;
  readonly expectedVersion: string;
  readonly stage: "upload_interrupted" | "uploading" | "upload_verification" | "scan_waiting" |
    "scanning" | "promotion_recovering" | "ready" | "rejected" | "aborted";
  readonly terminal: boolean;
  readonly retryClass: "never" | "immediate" | "after_delay" | "after_user_action";
  readonly retryAfter: string | null;
  readonly safeReasonCode: string | null;
  readonly trustedGrant: TrustedAssetGrantView | null;
}

export interface TrustedAssetGrantView {
  readonly assetRef: string;
  readonly assetVersionRef: string;
  readonly assetGrantRef: string;
  readonly projectRef: string;
  readonly purpose: string;
  readonly subjectGeneration: string;
  readonly eligibilityEpoch: string;
  readonly detectedMediaType: string;
  readonly size: string;
  readonly state: "ready";
}

export interface AssetUploadCommandView {
  readonly receipt: Readonly<{
    commandId: string;
    receiptRef: string;
    operation: "create_asset_upload_intent" | "complete_asset_upload";
    state: "pending" | "succeeded" | "failed" | "outcome_unknown";
    receivedAt: string;
    updatedAt: string;
  }>;
  readonly upload: AssetUploadStatusView | null;
}

export interface ReadySessionAttachmentView {
  readonly assetRef: string;
  readonly assetVersionRef: string;
  readonly assetGrantRef: string;
  readonly checksumSha256: string;
  readonly safeDisplayName: string;
  readonly detectedMediaType: string;
  readonly sizeBytes: bigint;
  readonly eligibilityEpoch: bigint;
}

export class AssetOwnerQueryService {
  constructor(private readonly dependencies: Readonly<{
    unitOfWork: AssetUnitOfWorkPort | null;
    repository: AssetOwnerQueryRepositoryPort;
  }>) {}

  static forInternalOwner(repository: AssetOwnerQueryRepositoryPort): AssetOwnerQueryService {
    return new AssetOwnerQueryService({ unitOfWork: null, repository });
  }

  getUploadStatus(input: Readonly<{
    context: VerifiedRequestSecurityContext;
    intentRef: string;
  }>): Promise<AssetUploadStatusView> {
    return this.readStatus(input.context, "getAssetUploadStatus", input.intentRef);
  }

  async resolveSessionAttachments(input: Readonly<{
    transaction: PlatformTransaction;
    authority: AssetOwnerAuthority;
    purpose: string;
    attachments: readonly AssetAttachmentIntent[];
  }>): Promise<readonly ReadySessionAttachmentView[]> {
    const stored = await this.dependencies.repository.loadSessionAttachments(input.transaction, {
      authority: input.authority,
      purpose: input.purpose,
      attachments: input.attachments,
    });
    if (stored === null) throw new Error("ASSET_NOT_ACCEPTED");
    return Object.freeze(stored.map((value, index) => {
      const expected = input.attachments[index];
      if (
        expected === undefined || value.assetRef !== expected.assetRef ||
        value.assetVersionRef !== expected.assetVersionRef || value.assetGrantRef !== expected.assetGrantRef ||
        value.projectRef !== input.authority.projectRef || value.purpose !== input.purpose ||
        value.subjectGeneration !== input.authority.subjectGeneration
      ) throw new Error("ASSET_OWNER_ATTACHMENT_CORRUPT");
      return Object.freeze({
        assetRef: value.assetRef,
        assetVersionRef: value.assetVersionRef,
        assetGrantRef: value.assetGrantRef,
        checksumSha256: value.checksumSha256,
        safeDisplayName: value.safeDisplayName,
        detectedMediaType: value.detectedMediaType,
        sizeBytes: value.size,
        eligibilityEpoch: value.eligibilityEpoch,
      });
    }));
  }

  async readCommand(input: Readonly<{
    context: VerifiedRequestSecurityContext;
    commandId: string;
    requestOperation: "createAssetUploadIntent" | "completeAssetUpload" | "recoverAssetUploadCommand";
  }>): Promise<AssetUploadCommandView> {
    const authority = resolveAssetUserAuthority(input.context, input.requestOperation);
    const expectedOperation = input.requestOperation === "recoverAssetUploadCommand"
      ? undefined
      : input.requestOperation;
    const receipt = await this.userUnitOfWork().execute(
      { context: input.context, operation: input.requestOperation },
      (transaction) => this.dependencies.repository.loadCommand(transaction, {
        authority,
        environment: input.context.environment,
        region: input.context.region,
        commandId: input.commandId,
        ...(expectedOperation === undefined ? {} : { operation: expectedOperation }),
      }),
    );
    if (receipt === null) throw new Error("ASSET_NOT_ACCEPTED");
    const upload = receipt.intentRef === null
      ? null
      : await this.readStatus(input.context, input.requestOperation, receipt.intentRef);
    return Object.freeze({
      receipt: Object.freeze({
        commandId: receipt.commandId,
        receiptRef: `asset-command:${receipt.commandId}`,
        operation: receipt.operation === "createAssetUploadIntent"
          ? "create_asset_upload_intent" as const
          : "complete_asset_upload" as const,
        state: receipt.state,
        receivedAt: receipt.receivedAt,
        updatedAt: receipt.updatedAt,
      }),
      upload,
    });
  }

  async getTrustedGrant(input: Readonly<{
    context: VerifiedRequestSecurityContext;
    assetRef: string;
    assetVersionRef: string;
    assetGrantRef: string;
    purpose: string;
    eligibilityEpoch: bigint;
  }>): Promise<TrustedAssetGrantView> {
    const operation = "getTrustedAssetGrant";
    const authority = resolveAssetUserAuthority(input.context, operation);
    const grant = await this.userUnitOfWork().execute(
      { context: input.context, operation },
      (transaction) => this.dependencies.repository.loadTrustedGrant(transaction, {
        authority,
        assetRef: input.assetRef,
        assetVersionRef: input.assetVersionRef,
        assetGrantRef: input.assetGrantRef,
        purpose: input.purpose,
        eligibilityEpoch: input.eligibilityEpoch,
      }),
    );
    if (grant === null) throw new Error("ASSET_NOT_ACCEPTED");
    return trustedGrant(grant);
  }

  private async readStatus(
    context: VerifiedRequestSecurityContext,
    operation: "createAssetUploadIntent" | "completeAssetUpload" | "getAssetUploadStatus" |
      "recoverAssetUploadCommand",
    intentRef: string,
  ): Promise<AssetUploadStatusView> {
    const authority = resolveAssetUserAuthority(context, operation);
    const stored = await this.userUnitOfWork().execute(
      { context, operation },
      (transaction) => this.dependencies.repository.loadUploadStatus(transaction, { authority, intentRef }),
    );
    if (stored === null) throw new Error("ASSET_NOT_ACCEPTED");
    return uploadStatus(stored);
  }

  private userUnitOfWork(): AssetUnitOfWorkPort {
    if (this.dependencies.unitOfWork === null) throw new Error("ASSET_USER_UNIT_OF_WORK_REQUIRED");
    return this.dependencies.unitOfWork;
  }
}

function uploadStatus(value: StoredAssetUploadStatus): AssetUploadStatusView {
  const state = ownerStage(value);
  const retryAfter = state.retryClass === "after_delay"
    ? new Date(Date.parse(value.updatedAt) + 2_000).toISOString()
    : null;
  return Object.freeze({
    intentRef: value.intentRef,
    sessionRef: value.sessionRef,
    projectRef: value.projectRef,
    purpose: value.purpose,
    safeDisplayName: value.safeDisplayName,
    clientMediaType: value.clientMediaType,
    expectedSize: value.expectedSize.toString(),
    expectedVersion: value.expectedVersion.toString(),
    ...state,
    retryAfter,
    trustedGrant: state.stage === "ready" && value.trustedGrant !== null
      ? trustedGrant(value.trustedGrant)
      : null,
  });
}

function ownerStage(value: StoredAssetUploadStatus): Pick<AssetUploadStatusView,
  "stage" | "terminal" | "retryClass" | "safeReasonCode"> {
  if (value.sessionState === "completed" && value.trustedGrant !== null) {
    return { stage: "ready", terminal: true, retryClass: "never", safeReasonCode: null };
  }
  if (value.sessionState === "rejected" || value.rejected || value.candidateState === "rejected" || value.promotionState === "rejected") {
    return { stage: "rejected", terminal: true, retryClass: "never", safeReasonCode: "ASSET_NOT_ACCEPTED" };
  }
  if (value.sessionState === "aborted") {
    return { stage: "aborted", terminal: true, retryClass: "never", safeReasonCode: null };
  }
  if (value.sessionState === "awaiting_capability") {
    return { stage: "upload_interrupted", terminal: false, retryClass: "immediate", safeReasonCode: null };
  }
  if (value.sessionState === "uploading") {
    return { stage: "uploading", terminal: false, retryClass: "after_user_action", safeReasonCode: null };
  }
  if (["completing", "reconciling_upload", "aborting"].includes(value.sessionState)) {
    return { stage: "upload_verification", terminal: false, retryClass: "after_delay", safeReasonCode: null };
  }
  if (value.candidateState === "scan_unavailable") {
    return { stage: "scan_waiting", terminal: false, retryClass: "after_delay", safeReasonCode: null };
  }
  if (value.candidateState === "checksum_verified" || value.candidateState === "scanning") {
    return { stage: "scanning", terminal: false, retryClass: "after_delay", safeReasonCode: null };
  }
  return { stage: "promotion_recovering", terminal: false, retryClass: "after_delay", safeReasonCode: null };
}

function trustedGrant(value: StoredTrustedAssetGrant): TrustedAssetGrantView {
  return Object.freeze({
    assetRef: value.assetRef,
    assetVersionRef: value.assetVersionRef,
    assetGrantRef: value.assetGrantRef,
    projectRef: value.projectRef,
    purpose: value.purpose,
    subjectGeneration: value.subjectGeneration.toString(),
    eligibilityEpoch: value.eligibilityEpoch.toString(),
    detectedMediaType: value.detectedMediaType,
    size: value.size.toString(),
    state: "ready" as const,
  });
}
