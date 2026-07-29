import { describe, expect, it } from "vitest";
import type { BlobCandidate } from "../../src/modules/asset/domain/blob-candidate.js";
import {
  evaluateAssetScan,
  type AssetInspectionPolicy,
  type AssetScanObservation,
} from "../../src/modules/asset/domain/scan-evaluation.js";

const candidate: BlobCandidate = Object.freeze({
  candidateRef: "blob_candidate_01",
  siteRef: "site_01",
  subjectRef: "subject_01",
  subjectGeneration: 4n,
  projectRef: "project_01",
  purpose: "chat.attachment",
  intentRef: "upload_intent_01",
  sessionRef: "upload_session_01",
  storageTenantRef: "storage_tenant_01",
  storageRegion: "us-east-1",
  quarantineObjectRef: "quarantine/opaque_0123456789",
  providerVersionRef: "provider_version_01",
  providerEtagDigest: "b".repeat(64),
  observedSize: 1234n,
  checksumSha256: "a".repeat(64),
  clientMediaType: "image/png",
  policyRevisionRef: "asset_policy_01",
  state: "scanning",
  expectedVersion: 2n,
  completionRequestedAt: "2026-07-28T12:01:00.000Z",
  observedAt: "2026-07-28T12:01:05.000Z",
});
const policy: AssetInspectionPolicy = Object.freeze({
  policyRevisionRef: "asset_policy_01",
  purpose: "chat.attachment",
  allowedDetectedMediaTypes: Object.freeze(["image/png", "image/jpeg"]),
  scannerDefinitionRef: "scanner_clamav",
  scannerRevisionRef: "scanner_revision_01",
  signatureRevisionRef: "signature_revision_01",
  contentSafetyRequired: true,
});
const observation: AssetScanObservation = Object.freeze({
  scannerDefinitionRef: "scanner_clamav",
  scannerRevisionRef: "scanner_revision_01",
  signatureRevisionRef: "signature_revision_01",
  detectedMediaType: "image/png",
  magicSignatureRef: "png_signature_v1",
  containerSummaryDigest: "c".repeat(64),
  malwareDisposition: "clean",
  contentSafetyDisposition: "allow",
  evidenceRef: "scan_evidence_01",
  evidenceDigest: "d".repeat(64),
  occurredAt: "2026-07-28T12:02:00.000Z",
});

describe("Asset scan evaluation", () => {
  it("admits promotion only from exact pinned scanner evidence and detected media policy", () => {
    expect(evaluateAssetScan({ evaluationRef: "scan_evaluation_01", candidate,
      policy, observation })).toEqual({
      disposition: "clean",
      evaluation: expect.objectContaining({
        evaluationRef: "scan_evaluation_01",
        candidateRef: "blob_candidate_01",
        outcome: "clean",
        detectedMediaType: "image/png",
        scannerRevisionRef: "scanner_revision_01",
        policyRevisionRef: "asset_policy_01",
      }),
    });
  });

  it("rejects a client/detected type conflict and positive malware evidence", () => {
    expect(evaluateAssetScan({ evaluationRef: "scan_evaluation_02", candidate,
      policy, observation: { ...observation, detectedMediaType: "image/jpeg" } })).toMatchObject({
      disposition: "rejected",
      code: "ASSET_DETECTED_MEDIA_TYPE_CONFLICT",
      evaluation: { outcome: "rejected" },
    });
    expect(evaluateAssetScan({ evaluationRef: "scan_evaluation_03", candidate,
      policy, observation: { ...observation, malwareDisposition: "detected" } })).toMatchObject({
      disposition: "rejected",
      code: "ASSET_MALWARE_DETECTED",
      evaluation: { outcome: "rejected" },
    });
  });

  it("fails closed when a required scanner or content decision is unavailable", () => {
    expect(evaluateAssetScan({ evaluationRef: "scan_evaluation_04", candidate,
      policy, observation: { ...observation, malwareDisposition: "unavailable" } })).toMatchObject({
      disposition: "unavailable",
      code: "ASSET_MALWARE_SCAN_UNAVAILABLE",
      evaluation: { outcome: "unavailable" },
    });
    expect(evaluateAssetScan({ evaluationRef: "scan_evaluation_05", candidate,
      policy, observation: { ...observation, contentSafetyDisposition: "unavailable" } })).toMatchObject({
      disposition: "unavailable",
      code: "ASSET_CONTENT_SAFETY_UNAVAILABLE",
      evaluation: { outcome: "unavailable" },
    });
  });

  it("refuses stale or unpinned scanner evidence instead of silently accepting it", () => {
    expect(() => evaluateAssetScan({ evaluationRef: "scan_evaluation_06", candidate,
      policy, observation: { ...observation, scannerRevisionRef: "scanner_revision_02" } }))
      .toThrow("ASSET_SCANNER_EVIDENCE_REVISION_MISMATCH");
    expect(() => evaluateAssetScan({ evaluationRef: "scan_evaluation_07", candidate,
      policy, observation: { ...observation, occurredAt: "2026-07-28T12:00:00.000Z" } }))
      .toThrow("ASSET_SCAN_PRECEDES_OBJECT_OBSERVATION");
  });
});
