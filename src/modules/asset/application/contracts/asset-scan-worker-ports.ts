import type { OutboxEvent } from "../../../../shared/outbox-inbox/outbox.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { BlobCandidate } from "../../domain/blob-candidate.js";
import type { AssetPromotionIntent } from "../../domain/promotion-intent.js";
import type {
  AssetInspectionPolicy,
  AssetScanEvaluation,
  AssetScanObservation,
} from "../../domain/scan-evaluation.js";
import type { AssetCleanupGroupPlan } from "./asset-cleanup-worker-ports.js";

export type AssetScanWork =
  | Readonly<{ disposition: "work"; candidate: BlobCandidate }>
  | Readonly<{ disposition: "terminal" | "superseded" }>;

export type PersistedAssetScanDecision =
  | Readonly<{
    disposition: "clean";
    evaluation: AssetScanEvaluation;
    promotion: AssetPromotionIntent;
    promotionEvent: OutboxEvent;
  }>
  | Readonly<{
    disposition: "rejected";
    code: string;
    evaluation: AssetScanEvaluation;
    rejectionRef: string;
    cleanupPlan: AssetCleanupGroupPlan;
  }>
  | Readonly<{
    disposition: "unavailable";
    code: string;
    evaluation: AssetScanEvaluation;
  }>;

export interface AssetScanWorkerRepositoryPort {
  claimScanWork(
    transaction: PlatformTransaction,
    input: Readonly<{
      eventId: string;
      siteRef: string;
      candidateRef: string;
      expectedVersion: bigint;
    }>,
  ): Promise<AssetScanWork>;
  recordDecision(
    transaction: PlatformTransaction,
    input: Readonly<{
      expectedCandidateVersion: bigint;
      decision: PersistedAssetScanDecision;
    }>,
  ): Promise<"committed" | "superseded">;
}

export interface AssetInspectionPolicyResolverPort {
  resolve(input: Readonly<{
    siteRef: string;
    policyRevisionRef: string;
    purpose: string;
  }>): Promise<AssetInspectionPolicy>;
}

export interface AssetSecurityScannerPort {
  inspect(input: Readonly<{
    storageTenantRef: string;
    storageRegion: string;
    quarantineObjectRef: string;
    providerVersionRef: string;
    expectedChecksumSha256: string;
    maximumBytes: bigint;
    policy: AssetInspectionPolicy;
  }>): Promise<AssetScanObservation>;
}
