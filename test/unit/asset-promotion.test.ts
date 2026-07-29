import { describe, expect, it } from "vitest";
import type { AssetPromotionIntent } from "../../src/modules/asset/domain/promotion-intent.js";
import { evaluateTrustedBlobObservation } from "../../src/modules/asset/domain/promotion-intent.js";

const promotion: AssetPromotionIntent = Object.freeze({
  promotionRef: "promotion_01", siteRef: "site_01", subjectRef: "subject_01",
  subjectGeneration: 4n, projectRef: "project_01", purpose: "chat.attachment",
  intentRef: "upload_intent_01", sessionRef: "upload_session_01",
  candidateRef: "blob_candidate_01", evaluationRef: "scan_evaluation_01",
  policyRevisionRef: "asset_policy_01", assetRef: "asset_01",
  assetVersionRef: "asset_version_01", blobRef: "blob_01",
  storageTenantRef: "storage_tenant_01", storageRegion: "us-east-1",
  quarantineObjectRef: "quarantine/opaque_0123456789",
  quarantineProviderVersionRef: "provider_version_01", trustedObjectRef: "trusted/blob_01",
  checksumSha256: "a".repeat(64), size: 1234n, detectedMediaType: "image/png",
  state: "observing_copy", expectedVersion: 2n, createdAt: "2026-07-28T12:02:01.000Z",
});

describe("Asset trusted-blob promotion", () => {
  it("accepts only an exact immutable trusted-object observation", () => {
    expect(evaluateTrustedBlobObservation({ promotion, observation: {
      disposition: "present", providerVersionRef: "trusted_version_01",
      providerEtagDigest: "b".repeat(64), size: 1234n, checksumSha256: "a".repeat(64),
      observedAt: "2026-07-28T12:02:05.000Z",
    } })).toMatchObject({ disposition: "ready", observation: {
      providerVersionRef: "trusted_version_01", checksumSha256: "a".repeat(64),
    } });
  });

  it("retries copy propagation absence and rejects any trusted-object mismatch", () => {
    expect(evaluateTrustedBlobObservation({ promotion, observation: {
      disposition: "absent", observedAt: "2026-07-28T12:02:05.000Z",
    } })).toEqual({ disposition: "retry", code: "ASSET_TRUSTED_OBJECT_NOT_VISIBLE" });
    expect(evaluateTrustedBlobObservation({ promotion, observation: {
      disposition: "present", providerVersionRef: "trusted_version_01",
      providerEtagDigest: "b".repeat(64), size: 1235n, checksumSha256: "a".repeat(64),
      observedAt: "2026-07-28T12:02:05.000Z",
    } })).toEqual({ disposition: "rejected", code: "ASSET_TRUSTED_OBJECT_SIZE_MISMATCH" });
  });
});
