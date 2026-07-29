import type { BlobCandidate } from "./blob-candidate.js";
import type { AssetScanEvaluation } from "./scan-evaluation.js";

export interface AssetPromotionIntent {
  readonly promotionRef: string;
  readonly siteRef: string;
  readonly subjectRef: string;
  readonly subjectGeneration: bigint;
  readonly projectRef: string;
  readonly purpose: string;
  readonly intentRef: string;
  readonly sessionRef: string;
  readonly candidateRef: string;
  readonly evaluationRef: string;
  readonly policyRevisionRef: string;
  readonly assetRef: string;
  readonly assetVersionRef: string;
  readonly blobRef: string;
  readonly storageTenantRef: string;
  readonly storageRegion: string;
  readonly quarantineObjectRef: string;
  readonly quarantineProviderVersionRef: string;
  readonly trustedObjectRef: string;
  readonly checksumSha256: string;
  readonly size: bigint;
  readonly detectedMediaType: string;
  readonly state: "pending_copy" | "observing_copy" | "ready_to_finalize" | "completed" | "rejected";
  readonly expectedVersion: bigint;
  readonly createdAt: string;
}

export function createAssetPromotionIntent(input: Readonly<{
  promotionRef: string;
  assetRef: string;
  assetVersionRef: string;
  blobRef: string;
  trustedObjectRef: string;
  candidate: BlobCandidate;
  evaluation: AssetScanEvaluation;
  createdAt: string;
}>): AssetPromotionIntent {
  for (const [value, code] of [
    [input.promotionRef, "ASSET_PROMOTION_REF_INVALID"],
    [input.assetRef, "ASSET_REF_INVALID"],
    [input.assetVersionRef, "ASSET_VERSION_REF_INVALID"],
    [input.blobRef, "ASSET_BLOB_REF_INVALID"],
  ] as const) identifier(value, code);
  bounded(input.trustedObjectRef, 8, 256, "ASSET_TRUSTED_OBJECT_REF_INVALID");
  if (
    input.candidate.state !== "scanning" || input.evaluation.outcome !== "clean" ||
    input.candidate.siteRef !== input.evaluation.siteRef ||
    input.candidate.candidateRef !== input.evaluation.candidateRef ||
    input.candidate.expectedVersion !== input.evaluation.candidateVersion ||
    input.candidate.policyRevisionRef !== input.evaluation.policyRevisionRef
  ) throw new Error("ASSET_PROMOTION_EVIDENCE_MISMATCH");
  if (!Number.isFinite(Date.parse(input.createdAt)) ||
      Date.parse(input.createdAt) < Date.parse(input.evaluation.occurredAt)) {
    throw new Error("ASSET_PROMOTION_TIME_INVALID");
  }
  return Object.freeze({
    promotionRef: input.promotionRef,
    siteRef: input.candidate.siteRef,
    subjectRef: input.candidate.subjectRef,
    subjectGeneration: input.candidate.subjectGeneration,
    projectRef: input.candidate.projectRef,
    purpose: input.candidate.purpose,
    intentRef: input.candidate.intentRef,
    sessionRef: input.candidate.sessionRef,
    candidateRef: input.candidate.candidateRef,
    evaluationRef: input.evaluation.evaluationRef,
    policyRevisionRef: input.evaluation.policyRevisionRef,
    assetRef: input.assetRef,
    assetVersionRef: input.assetVersionRef,
    blobRef: input.blobRef,
    storageTenantRef: input.candidate.storageTenantRef,
    storageRegion: input.candidate.storageRegion,
    quarantineObjectRef: input.candidate.quarantineObjectRef,
    quarantineProviderVersionRef: input.candidate.providerVersionRef,
    trustedObjectRef: input.trustedObjectRef,
    checksumSha256: input.candidate.checksumSha256,
    size: input.candidate.observedSize,
    detectedMediaType: input.evaluation.detectedMediaType,
    state: "pending_copy",
    expectedVersion: 1n,
    createdAt: input.createdAt,
  });
}

function identifier(value: string, code: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value)) throw new Error(code);
}

function bounded(value: string, minimum: number, maximum: number, code: string): void {
  if (value.length < minimum || value.length > maximum) throw new Error(code);
}
