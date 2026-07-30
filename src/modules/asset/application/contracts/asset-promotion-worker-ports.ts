import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { AssetPromotionIntent, TrustedBlobObservation } from "../../domain/promotion-intent.js";
import type { AssetCleanupGroupPlan } from "./asset-cleanup-worker-ports.js";

export type AssetPromotionWork =
  | Readonly<{ disposition: "work"; promotion: AssetPromotionIntent }>
  | Readonly<{ disposition: "terminal" | "superseded" }>;

export interface AssetPromotionWorkerRepositoryPort {
  claimPromotionWork(
    transaction: PlatformTransaction,
    input: Readonly<{
      eventId: string;
      siteRef: string;
      promotionRef: string;
      expectedVersion: bigint;
    }>,
  ): Promise<AssetPromotionWork>;
  markObserving(
    transaction: PlatformTransaction,
    input: Readonly<{ promotionRef: string; siteRef: string; expectedVersion: bigint }>,
  ): Promise<"committed" | "superseded">;
  finalizePromotion(
    transaction: PlatformTransaction,
    input: Readonly<{
      promotion: AssetPromotionIntent;
      expectedPromotionVersion: bigint;
      observation: Extract<TrustedBlobObservation, { disposition: "present" }>;
      receiptRef: string;
      referenceRef: string;
      eligibilityRef: string;
      cleanupPlan: AssetCleanupGroupPlan;
      completedAt: string;
    }>,
  ): Promise<"committed" | "superseded">;
  rejectPromotion(
    transaction: PlatformTransaction,
    input: Readonly<{
      promotionRef: string;
      siteRef: string;
      expectedVersion: bigint;
      reasonCode: string;
      rejectionRef: string;
      cleanupPlan: AssetCleanupGroupPlan;
    }>,
  ): Promise<"committed" | "superseded">;
}

export interface AssetTrustedObjectStorePort {
  copyExact(input: Readonly<{
    storageTenantRef: string;
    storageRegion: string;
    sourceObjectRef: string;
    sourceProviderVersionRef: string;
    targetObjectRef: string;
    expectedChecksumSha256: string;
    expectedSize: bigint;
    idempotencyKey: string;
  }>): Promise<Readonly<{ disposition: "accepted" | "outcome_unknown" }>>;
  observeTrusted(input: Readonly<{
    storageTenantRef: string;
    storageRegion: string;
    trustedObjectRef: string;
  }>): Promise<TrustedBlobObservation>;
}
