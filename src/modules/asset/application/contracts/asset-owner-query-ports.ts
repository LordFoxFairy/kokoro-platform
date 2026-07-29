import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { AssetUserAuthority } from "../asset-user-authority.js";

export type AssetOwnerCommandOperation = "createAssetUploadIntent" | "completeAssetUpload";

export interface StoredAssetOwnerReceipt {
  readonly commandId: string;
  readonly operation: AssetOwnerCommandOperation;
  readonly state: "pending" | "succeeded" | "failed" | "outcome_unknown";
  readonly intentRef: string | null;
  readonly sessionRef: string | null;
  readonly receivedAt: string;
  readonly updatedAt: string;
}

export interface StoredAssetUploadStatus {
  readonly intentRef: string;
  readonly sessionRef: string;
  readonly projectRef: string;
  readonly purpose: string;
  readonly safeDisplayName: string;
  readonly clientMediaType: string;
  readonly expectedSize: bigint;
  readonly expectedVersion: bigint;
  readonly sessionState: string;
  readonly candidateState: string | null;
  readonly promotionState: string | null;
  readonly rejected: boolean;
  readonly updatedAt: string;
  readonly trustedGrant: StoredTrustedAssetGrant | null;
}

export interface StoredTrustedAssetGrant {
  readonly assetRef: string;
  readonly assetVersionRef: string;
  readonly assetGrantRef: string;
  readonly projectRef: string;
  readonly purpose: string;
  readonly subjectGeneration: bigint;
  readonly eligibilityEpoch: bigint;
  readonly detectedMediaType: string;
  readonly size: bigint;
}

export interface AssetOwnerQueryRepositoryPort {
  loadUploadStatus(
    transaction: PlatformTransaction,
    input: Readonly<{ authority: AssetUserAuthority; intentRef: string }>,
  ): Promise<StoredAssetUploadStatus | null>;

  loadCommand(
    transaction: PlatformTransaction,
    input: Readonly<{
      authority: AssetUserAuthority;
      environment: string;
      region: string;
      commandId: string;
      operation?: AssetOwnerCommandOperation;
    }>,
  ): Promise<StoredAssetOwnerReceipt | null>;

  loadTrustedGrant(
    transaction: PlatformTransaction,
    input: Readonly<{
      authority: AssetUserAuthority;
      assetRef: string;
      assetVersionRef: string;
      assetGrantRef: string;
      purpose: string;
      eligibilityEpoch: bigint;
    }>,
  ): Promise<StoredTrustedAssetGrant | null>;
}
