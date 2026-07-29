import { describe, expect, it, vi } from "vitest";
import type { PlatformTransaction } from "../../src/shared/unit-of-work/index.js";
import type { AssetPromotionIntent } from "../../src/modules/asset/domain/promotion-intent.js";
import { ProcessAssetPromotionService } from
  "../../src/modules/asset/application/services/process-asset-promotion.js";

const transaction = Object.freeze({}) as PlatformTransaction;
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
  state: "pending_copy", expectedVersion: 1n, createdAt: "2026-07-28T12:02:01.000Z",
});
const command = Object.freeze({ eventId: "promotion_event_01", siteRef: "site_01",
  promotionRef: "promotion_01", expectedVersion: 1n, correlationId: "correlation_01" });

describe("ProcessAssetPromotionService", () => {
  it("copies the exact quarantined version and atomically publishes one ready AssetVersion", async () => {
    const harness = fixture();
    await expect(harness.service.execute(command)).resolves.toEqual({
      disposition: "ready", assetRef: "asset_01", assetVersionRef: "asset_version_01",
    });
    expect(harness.copyExact).toHaveBeenCalledWith({
      storageTenantRef: "storage_tenant_01", storageRegion: "us-east-1",
      sourceObjectRef: "quarantine/opaque_0123456789", sourceProviderVersionRef: "provider_version_01",
      targetObjectRef: "trusted/blob_01", expectedChecksumSha256: "a".repeat(64),
      expectedSize: 1234n, idempotencyKey: "promotion_01",
    });
    expect(harness.finalizePromotion).toHaveBeenCalledWith(transaction, expect.objectContaining({
      expectedPromotionVersion: 1n,
      observation: expect.objectContaining({ providerVersionRef: "trusted_version_01" }),
      readyEvent: expect.objectContaining({ eventType: "asset.version.ready" }),
      receiptRef: "promotion_receipt_01",
      referenceRef: "asset_reference_01",
      eligibilityRef: "asset_eligibility_01",
    }));
  });

  it("keeps the Asset unavailable while a copied object is not yet observable", async () => {
    const harness = fixture({ observation: "absent" });
    await expect(harness.service.execute(command)).resolves.toEqual({
      disposition: "retry", code: "ASSET_TRUSTED_OBJECT_NOT_VISIBLE",
    });
    expect(harness.markObserving).toHaveBeenCalledWith(transaction, {
      promotionRef: "promotion_01", siteRef: "site_01", expectedVersion: 1n,
    });
    expect(harness.finalizePromotion).not.toHaveBeenCalled();
  });

  it("quarantines a mismatched trusted copy and queues cleanup without making it ready", async () => {
    const harness = fixture({ observation: "mismatch" });
    await expect(harness.service.execute(command)).resolves.toEqual({
      disposition: "quarantined", code: "ASSET_TRUSTED_OBJECT_SIZE_MISMATCH",
    });
    expect(harness.rejectPromotion).toHaveBeenCalledWith(transaction, expect.objectContaining({
      reasonCode: "ASSET_TRUSTED_OBJECT_SIZE_MISMATCH",
      cleanupEvent: expect.objectContaining({ eventType: "asset.trusted-copy.cleanup.requested" }),
    }));
    expect(harness.finalizePromotion).not.toHaveBeenCalled();
  });

  it("acks a terminal or superseded promotion event without another object-store effect", async () => {
    const harness = fixture({ claim: "superseded" });
    await expect(harness.service.execute(command)).resolves.toEqual({ disposition: "superseded" });
    expect(harness.copyExact).not.toHaveBeenCalled();
  });
});

function fixture(input: Readonly<{
  claim?: "work" | "superseded";
  observation?: "present" | "absent" | "mismatch";
}> = {}) {
  const copyExact = vi.fn(async () => Object.freeze({ disposition: "accepted" as const }));
  const observeTrusted = vi.fn(async () => input.observation === "absent"
    ? Object.freeze({ disposition: "absent" as const, observedAt: "2026-07-28T12:02:05.000Z" })
    : Object.freeze({ disposition: "present" as const, providerVersionRef: "trusted_version_01",
      providerEtagDigest: "b".repeat(64), size: input.observation === "mismatch" ? 1235n : 1234n,
      checksumSha256: "a".repeat(64), observedAt: "2026-07-28T12:02:05.000Z" }));
  const markObserving = vi.fn(async () => "committed" as const);
  const finalizePromotion = vi.fn(async () => "committed" as const);
  const rejectPromotion = vi.fn(async () => "committed" as const);
  const references = ["promotion_receipt_01", "asset_reference_01", "asset_eligibility_01", "ready_event_01",
    "trusted_cleanup_event_01"];
  const service = new ProcessAssetPromotionService({
    unitOfWork: { execute: async (_scope, work) => work(transaction) },
    repository: {
      claimPromotionWork: async () => input.claim === "superseded"
        ? { disposition: "superseded" }
        : { disposition: "work", promotion },
      markObserving,
      finalizePromotion,
      rejectPromotion,
    },
    objectStore: { copyExact, observeTrusted },
    reference: () => references.shift() ?? "fallback_reference",
    clock: () => new Date("2026-07-28T12:02:06.000Z"),
  });
  return { service, copyExact, observeTrusted, markObserving, finalizePromotion, rejectPromotion };
}
