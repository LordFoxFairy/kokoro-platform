import { describe, expect, it, vi } from "vitest";
import type { PlatformTransaction } from "../../src/shared/unit-of-work/index.js";
import type { BlobCandidate } from "../../src/modules/asset/domain/blob-candidate.js";
import type { AssetInspectionPolicy } from "../../src/modules/asset/domain/scan-evaluation.js";
import { ProcessAssetScanService } from
  "../../src/modules/asset/application/services/process-asset-scan.js";

const transaction = Object.freeze({}) as PlatformTransaction;
const candidate: BlobCandidate = Object.freeze({
  candidateRef: "blob_candidate_01", siteRef: "site_01", subjectRef: "subject_01",
  subjectGeneration: 4n, projectRef: "project_01", purpose: "chat.attachment",
  intentRef: "upload_intent_01", sessionRef: "upload_session_01",
  storageTenantRef: "storage_tenant_01", storageRegion: "us-east-1",
  quarantineObjectRef: "quarantine/opaque_0123456789",
  providerVersionRef: "provider_version_01", providerEtagDigest: "b".repeat(64),
  observedSize: 1234n, checksumSha256: "a".repeat(64), clientMediaType: "image/png",
  policyRevisionRef: "asset_policy_01", state: "scanning", expectedVersion: 2n,
  completionRequestedAt: "2026-07-28T12:01:00.000Z",
  observedAt: "2026-07-28T12:01:05.000Z",
});
const policy: AssetInspectionPolicy = Object.freeze({
  policyRevisionRef: "asset_policy_01", purpose: "chat.attachment",
  allowedDetectedMediaTypes: Object.freeze(["image/png"]),
  scannerDefinitionRef: "scanner_clamav", scannerRevisionRef: "scanner_revision_01",
  signatureRevisionRef: "signature_revision_01", contentSafetyRequired: true,
});
const command = Object.freeze({
  eventId: "scan_event_01", siteRef: "site_01", candidateRef: "blob_candidate_01",
  expectedVersion: 1n, correlationId: "correlation_01",
});

describe("ProcessAssetScanService", () => {
  it("scans the exact immutable provider object and queues a deterministic promotion intent", async () => {
    const harness = fixture();
    await expect(harness.service.execute(command)).resolves.toEqual({
      disposition: "promotion_pending",
      assetVersionRef: "asset_version_01",
    });
    expect(harness.inspect).toHaveBeenCalledWith(expect.objectContaining({
      providerVersionRef: "provider_version_01",
      expectedChecksumSha256: "a".repeat(64),
      maximumBytes: 1234n,
      policy,
    }));
    expect(harness.recordDecision).toHaveBeenCalledWith(transaction, expect.objectContaining({
      decision: expect.objectContaining({
        disposition: "clean",
        promotion: expect.objectContaining({
          candidateRef: "blob_candidate_01",
          assetRef: "asset_01",
          assetVersionRef: "asset_version_01",
          trustedObjectRef: "trusted/blob_01",
          state: "pending_copy",
        }),
        promotionEvent: expect.objectContaining({ eventType: "asset.blob.promotion.requested" }),
      }),
    }));
  });

  it("persists unavailable evidence and retries without promotion or cleanup", async () => {
    const harness = fixture({ malwareDisposition: "unavailable" });
    await expect(harness.service.execute(command)).resolves.toEqual({
      disposition: "retry", code: "ASSET_MALWARE_SCAN_UNAVAILABLE",
    });
    expect(harness.recordDecision).toHaveBeenCalledWith(transaction, expect.objectContaining({
      decision: expect.objectContaining({ disposition: "unavailable" }),
    }));
  });

  it("persists denied evidence and queues quarantine cleanup", async () => {
    const harness = fixture({ malwareDisposition: "detected" });
    await expect(harness.service.execute(command)).resolves.toEqual({
      disposition: "rejected", code: "ASSET_MALWARE_DETECTED",
    });
    expect(harness.recordDecision).toHaveBeenCalledWith(transaction, expect.objectContaining({
      decision: expect.objectContaining({
        disposition: "rejected",
        cleanupPlan: {
          cleanupGroupRef: "cleanup_group_01",
          terminalReservationState: "released",
          targets: [expect.objectContaining({
            cleanupRef: "cleanup_quarantine_01",
            objectRole: "quarantine",
            providerVersionRef: "provider_version_01",
            retainedBytes: 1234n,
            cleanupEvent: expect.objectContaining({ eventType: "asset.object.cleanup.requested" }),
          })],
        },
      }),
    }));
  });

  it("acknowledges a superseded scan event without invoking the scanner", async () => {
    const harness = fixture({ claim: "superseded" });
    await expect(harness.service.execute(command)).resolves.toEqual({ disposition: "superseded" });
    expect(harness.inspect).not.toHaveBeenCalled();
    expect(harness.recordDecision).not.toHaveBeenCalled();
  });
});

function fixture(input: Readonly<{
  claim?: "work" | "superseded";
  malwareDisposition?: "clean" | "detected" | "unavailable";
}> = {}) {
  const inspect = vi.fn(async () => Object.freeze({
    scannerDefinitionRef: "scanner_clamav", scannerRevisionRef: "scanner_revision_01",
    signatureRevisionRef: "signature_revision_01", detectedMediaType: "image/png",
    magicSignatureRef: "png_signature_v1", containerSummaryDigest: "c".repeat(64),
    malwareDisposition: input.malwareDisposition ?? "clean" as const,
    contentSafetyDisposition: "allow" as const,
    evidenceRef: "scan_evidence_01", evidenceDigest: "d".repeat(64),
    occurredAt: "2026-07-28T12:02:00.000Z",
  }));
  const recordDecision = vi.fn(async () => "committed" as const);
  const references = input.malwareDisposition === "detected"
    ? ["scan_evaluation_01", "cleanup_group_01", "cleanup_quarantine_01", "cleanup_event_01",
      "rejection_01"]
    : ["scan_evaluation_01", "promotion_01", "asset_01", "asset_version_01",
      "blob_01", "promotion_event_01"];
  const service = new ProcessAssetScanService({
    unitOfWork: { execute: async (_scope, work) => work(transaction) },
    repository: {
      claimScanWork: async () => input.claim === "superseded"
        ? { disposition: "superseded" }
        : { disposition: "work", candidate },
      recordDecision,
    },
    policyResolver: { resolve: async () => policy },
    scanner: { inspect },
    reference: () => references.shift() ?? "fallback_reference",
  });
  return { service, inspect, recordDecision };
}
