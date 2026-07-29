import { describe, expect, it, vi } from "vitest";
import type { VerifiedRequestSecurityContext } from "../../src/shared/security-context/index.js";
import type { PlatformTransaction } from "../../src/shared/unit-of-work/index.js";
import { AssetOwnerQueryService } from "../../src/modules/asset/application/services/asset-owner-query.js";
import type { StoredAssetUploadStatus } from "../../src/modules/asset/application/contracts/asset-owner-query-ports.js";

const transaction = Object.freeze({}) as PlatformTransaction;

function context(operation: string): VerifiedRequestSecurityContext {
  return Object.freeze({
    environment: "production", region: "us-east-1",
    trustedCaller: { kind: "site_product", workloadIdentityId: "workload_01", siteId: "site_01",
      siteReleaseRef: "release_01", bindingEpoch: "7", allowedOperations: [operation] },
    actor: { kind: "user", subjectId: "subject_01", subjectGeneration: "4" },
    target: { siteId: "site_01", projectId: "project_01", purpose: operation },
  }) as unknown as VerifiedRequestSecurityContext;
}

const base: StoredAssetUploadStatus = Object.freeze({
  intentRef: "upload_intent_01", sessionRef: "upload_session_01", projectRef: "project_01",
  purpose: "chat.attachment", safeDisplayName: "photo.png", clientMediaType: "image/png",
  expectedSize: 1234n, expectedVersion: 4n, sessionState: "validating",
  candidateState: "scanning", promotionState: null, rejected: false,
  updatedAt: "2026-07-28T12:00:00.000Z", trustedGrant: null,
});

describe("AssetOwnerQueryService", () => {
  it.each([
    [{ sessionState: "awaiting_capability", candidateState: null }, "upload_interrupted"],
    [{ sessionState: "uploading", candidateState: null }, "uploading"],
    [{ sessionState: "reconciling_upload", candidateState: null }, "upload_verification"],
    [{ sessionState: "validating", candidateState: "scan_unavailable" }, "scan_waiting"],
    [{ sessionState: "validating", candidateState: "scanning" }, "scanning"],
    [{ sessionState: "validating", candidateState: "promotion_ready" }, "promotion_recovering"],
    [{ sessionState: "rejected", candidateState: "rejected" }, "rejected"],
  ] as const)("maps real worker state %j without inventing readiness", async (change, stage) => {
    const service = new AssetOwnerQueryService({
      unitOfWork: { execute: async (_fence, work) => work(transaction) },
      repository: {
        loadUploadStatus: async () => ({ ...base, ...change }),
        loadCommand: async () => null,
        loadTrustedGrant: async () => null,
      },
    });
    await expect(service.getUploadStatus({ context: context("getAssetUploadStatus"),
      intentRef: base.intentRef })).resolves.toMatchObject({ stage, trustedGrant: null });
  });

  it("publishes ready only with the exact current eligibility projection", async () => {
    const grant = Object.freeze({
      assetRef: "asset_01", assetVersionRef: "asset_version_01", assetGrantRef: "eligibility_01",
      projectRef: "project_01", purpose: "chat.attachment", subjectGeneration: 4n,
      eligibilityEpoch: 9n, detectedMediaType: "image/png", size: 1234n,
    });
    const loadTrustedGrant = vi.fn(async () => grant);
    const service = new AssetOwnerQueryService({
      unitOfWork: { execute: async (_fence, work) => work(transaction) },
      repository: {
        loadUploadStatus: async () => ({ ...base, sessionState: "completed", candidateState: "promotion_ready",
          promotionState: "completed", trustedGrant: grant }),
        loadCommand: async () => null,
        loadTrustedGrant,
      },
    });
    await expect(service.getUploadStatus({ context: context("getAssetUploadStatus"),
      intentRef: base.intentRef })).resolves.toMatchObject({
        stage: "ready", terminal: true,
        trustedGrant: { assetGrantRef: "eligibility_01", eligibilityEpoch: "9", state: "ready" },
      });
    await expect(service.getTrustedGrant({ context: context("getTrustedAssetGrant"),
      assetRef: "asset_01", assetVersionRef: "asset_version_01", assetGrantRef: "eligibility_01",
      purpose: "chat.attachment", eligibilityEpoch: 9n })).resolves.toMatchObject({
        projectRef: "project_01", subjectGeneration: "4", state: "ready",
      });
    expect(loadTrustedGrant).toHaveBeenCalledWith(transaction, expect.objectContaining({
      authority: expect.objectContaining({ siteRef: "site_01", projectRef: "project_01",
        subjectRef: "subject_01", subjectGeneration: 4n }),
      purpose: "chat.attachment", eligibilityEpoch: 9n,
    }));
  });

  it("recovers only an owner receipt and current status, never a capability", async () => {
    const service = new AssetOwnerQueryService({
      unitOfWork: { execute: async (_fence, work) => work(transaction) },
      repository: {
        loadUploadStatus: async () => base,
        loadCommand: async () => ({
          commandId: "0198f758-2534-7bbb-8bbb-0123456789ab",
          operation: "createAssetUploadIntent", state: "succeeded", intentRef: base.intentRef,
          sessionRef: base.sessionRef, receivedAt: "2026-07-28T11:59:59.000Z",
          updatedAt: "2026-07-28T12:00:00.000Z",
        }),
        loadTrustedGrant: async () => null,
      },
    });
    const result = await service.readCommand({ context: context("recoverAssetUploadCommand"),
      commandId: "0198f758-2534-7bbb-8bbb-0123456789ab", requestOperation: "recoverAssetUploadCommand" });
    expect(result).toMatchObject({ receipt: { operation: "create_asset_upload_intent", state: "succeeded" },
      upload: { stage: "scanning" } });
    expect(JSON.stringify(result)).not.toContain("credential");
  });

  it("makes cross-owner or stale eligibility mismatch indistinguishable", async () => {
    const service = new AssetOwnerQueryService({
      unitOfWork: { execute: async (_fence, work) => work(transaction) },
      repository: { loadUploadStatus: async () => null, loadCommand: async () => null,
        loadTrustedGrant: async () => null },
    });
    await expect(service.getTrustedGrant({ context: context("getTrustedAssetGrant"),
      assetRef: "asset_01", assetVersionRef: "asset_version_01", assetGrantRef: "eligibility_01",
      purpose: "chat.attachment", eligibilityEpoch: 8n })).rejects.toThrow("ASSET_NOT_ACCEPTED");
  });
});
