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

export type TrustedBlobObservation =
  | Readonly<{ disposition: "absent"; observedAt: string }>
  | Readonly<{
    disposition: "present";
    providerVersionRef: string;
    providerEtagDigest: string;
    size: bigint;
    checksumSha256: string;
    observedAt: string;
  }>;

export type TrustedBlobDecision =
  | Readonly<{ disposition: "retry"; code: "ASSET_TRUSTED_OBJECT_NOT_VISIBLE" }>
  | Readonly<{
    disposition: "rejected";
    code: "ASSET_TRUSTED_OBJECT_SIZE_MISMATCH" | "ASSET_TRUSTED_OBJECT_CHECKSUM_MISMATCH";
  }>
  | Readonly<{ disposition: "ready"; observation: Extract<TrustedBlobObservation, { disposition: "present" }> }>;

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

export function evaluateTrustedBlobObservation(input: Readonly<{
  promotion: AssetPromotionIntent;
  observation: TrustedBlobObservation;
}>): TrustedBlobDecision {
  if (!new Set<AssetPromotionIntent["state"]>([
    "pending_copy", "observing_copy", "ready_to_finalize",
  ]).has(input.promotion.state)) {
    throw new Error("ASSET_PROMOTION_NOT_OBSERVABLE");
  }
  if (!Number.isFinite(Date.parse(input.observation.observedAt)) ||
      Date.parse(input.observation.observedAt) < Date.parse(input.promotion.createdAt)) {
    throw new Error("ASSET_TRUSTED_OBJECT_OBSERVATION_TIME_INVALID");
  }
  if (input.observation.disposition === "absent") {
    return Object.freeze({ disposition: "retry", code: "ASSET_TRUSTED_OBJECT_NOT_VISIBLE" });
  }
  identifier(input.observation.providerVersionRef, "ASSET_TRUSTED_PROVIDER_VERSION_INVALID");
  digest(input.observation.providerEtagDigest, "ASSET_TRUSTED_PROVIDER_ETAG_INVALID");
  digest(input.observation.checksumSha256, "ASSET_TRUSTED_OBJECT_CHECKSUM_INVALID");
  if (input.observation.size !== input.promotion.size) {
    return Object.freeze({ disposition: "rejected", code: "ASSET_TRUSTED_OBJECT_SIZE_MISMATCH" });
  }
  if (input.observation.checksumSha256 !== input.promotion.checksumSha256) {
    return Object.freeze({ disposition: "rejected", code: "ASSET_TRUSTED_OBJECT_CHECKSUM_MISMATCH" });
  }
  return Object.freeze({ disposition: "ready", observation: input.observation });
}

export function verifyAssetPromotionIntent(value: AssetPromotionIntent): AssetPromotionIntent {
  for (const [candidate, code] of [
    [value.promotionRef, "ASSET_PROMOTION_REF_INVALID"],
    [value.siteRef, "ASSET_SITE_REF_INVALID"],
    [value.subjectRef, "ASSET_SUBJECT_REF_INVALID"],
    [value.projectRef, "ASSET_PROJECT_REF_INVALID"],
    [value.intentRef, "ASSET_UPLOAD_INTENT_REF_INVALID"],
    [value.sessionRef, "ASSET_UPLOAD_SESSION_REF_INVALID"],
    [value.candidateRef, "ASSET_BLOB_CANDIDATE_REF_INVALID"],
    [value.evaluationRef, "ASSET_SCAN_EVALUATION_REF_INVALID"],
    [value.policyRevisionRef, "ASSET_POLICY_REVISION_INVALID"],
    [value.assetRef, "ASSET_REF_INVALID"],
    [value.assetVersionRef, "ASSET_VERSION_REF_INVALID"],
    [value.blobRef, "ASSET_BLOB_REF_INVALID"],
    [value.storageTenantRef, "ASSET_STORAGE_TENANT_INVALID"],
    [value.quarantineProviderVersionRef, "ASSET_PROVIDER_VERSION_INVALID"],
  ] as const) identifier(candidate, code);
  bounded(value.quarantineObjectRef, 8, 256, "ASSET_QUARANTINE_OBJECT_REF_INVALID");
  bounded(value.trustedObjectRef, 8, 256, "ASSET_TRUSTED_OBJECT_REF_INVALID");
  digest(value.checksumSha256, "ASSET_PROMOTION_CHECKSUM_INVALID");
  if (
    value.subjectGeneration < 1n || value.size < 1n || value.expectedVersion < 1n ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !new Set<AssetPromotionIntent["state"]>(["pending_copy", "observing_copy",
      "ready_to_finalize", "completed", "rejected"]).has(value.state)
  ) throw new Error("ASSET_PROMOTION_VALUE_INVALID");
  return Object.freeze({ ...value });
}

function identifier(value: string, code: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value)) throw new Error(code);
}

function bounded(value: string, minimum: number, maximum: number, code: string): void {
  if (value.length < minimum || value.length > maximum) throw new Error(code);
}

function digest(value: string, code: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(code);
}
