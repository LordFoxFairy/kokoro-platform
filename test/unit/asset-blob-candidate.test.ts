import { describe, expect, it } from "vitest";
import {
  evaluateQuarantineObservation,
  type QuarantineObjectObservation,
} from "../../src/modules/asset/domain/blob-candidate.js";
import {
  beginUploadCompletion,
  createUploadIntent,
  createUploadSession,
} from "../../src/modules/asset/domain/upload-intent.js";

const intent = createUploadIntent({
  intentRef: "upload_intent_01", siteRef: "site_01", workloadIdentityId: "workload_01",
  siteReleaseRef: "release_01", bindingEpoch: 7n, subjectRef: "subject_01", subjectGeneration: 4n,
  projectRef: "project_01", purpose: "chat.attachment", filename: "photo.png",
  clientMediaType: "image/png", expectedSize: 1234n, expectedChecksumSha256: "a".repeat(64),
  policy: { policyRevisionRef: "asset_policy_01", purpose: "chat.attachment", storageRegion: "us-east-1",
    maximumFileBytes: 10_000_000n, maximumInflightBytes: 100_000_000n,
    allowedClientMediaTypes: ["image/png"], expiresAt: "2026-07-29T12:00:00.000Z" },
  now: "2026-07-28T12:00:00.000Z",
});
const uploading = {
  ...createUploadSession({ sessionRef: "upload_session_01", intent,
    quotaRevisionRef: "quota_revision_01", storageTenantRef: "storage_tenant_01",
    storageRegion: "us-east-1", quarantineObjectRef: "quarantine/opaque_0123456789",
    capabilityAudience: "https://upload.example.test", minimumPartBytes: 100n,
    maximumPartBytes: 10_000_000n, capabilityLifetimeSeconds: 300 }),
  state: "uploading" as const, capabilityEpoch: 1n,
  capabilityExpiresAt: "2026-07-28T12:05:00.000Z", expectedVersion: 2n,
};
const completing = beginUploadCompletion(uploading, 2n, "2026-07-28T12:01:00.000Z");
const present: QuarantineObjectObservation = Object.freeze({
  disposition: "present", providerVersionRef: "provider_version_01",
  providerEtagDigest: "b".repeat(64), size: 1234n, checksumSha256: "a".repeat(64),
  observedAt: "2026-07-28T12:01:05.000Z",
});

describe("Blob candidate admission", () => {
  it("admits only the exact opaque object, size and strong checksum frozen by the upload intent", () => {
    expect(evaluateQuarantineObservation({ candidateRef: "blob_candidate_01", intent,
      session: completing, observation: present })).toEqual({
      disposition: "candidate",
      candidate: {
        candidateRef: "blob_candidate_01", siteRef: "site_01", subjectRef: "subject_01",
        subjectGeneration: 4n, projectRef: "project_01", purpose: "chat.attachment",
        intentRef: "upload_intent_01", sessionRef: "upload_session_01",
        storageTenantRef: "storage_tenant_01", storageRegion: "us-east-1",
        quarantineObjectRef: "quarantine/opaque_0123456789",
        providerVersionRef: "provider_version_01", providerEtagDigest: "b".repeat(64),
        observedSize: 1234n, checksumSha256: "a".repeat(64), clientMediaType: "image/png",
        state: "checksum_verified", expectedVersion: 1n,
        completionRequestedAt: "2026-07-28T12:01:00.000Z",
        observedAt: "2026-07-28T12:01:05.000Z",
      },
    });
  });

  it("retries provider absence and requires a bounded streaming checksum when HEAD has none", () => {
    expect(evaluateQuarantineObservation({ candidateRef: "blob_candidate_01", intent,
      session: completing, observation: { disposition: "absent",
        observedAt: "2026-07-28T12:01:05.000Z" } })).toEqual({
      disposition: "retry", code: "ASSET_QUARANTINE_OBJECT_NOT_VISIBLE",
    });
    expect(evaluateQuarantineObservation({ candidateRef: "blob_candidate_01", intent,
      session: completing, observation: { ...present, checksumSha256: null } })).toEqual({
      disposition: "checksum_required", maximumBytes: 1234n,
    });
  });

  it("rejects size/checksum mismatch and any stale owner state before scan or promotion", () => {
    expect(evaluateQuarantineObservation({ candidateRef: "blob_candidate_01", intent,
      session: completing, observation: { ...present, size: 1235n } })).toEqual({
      disposition: "rejected", code: "ASSET_OBJECT_SIZE_MISMATCH",
    });
    expect(evaluateQuarantineObservation({ candidateRef: "blob_candidate_01", intent,
      session: completing, observation: { ...present, checksumSha256: "c".repeat(64) } })).toEqual({
      disposition: "rejected", code: "ASSET_OBJECT_CHECKSUM_MISMATCH",
    });
    expect(() => evaluateQuarantineObservation({ candidateRef: "blob_candidate_01", intent,
      session: { ...completing, state: "aborted" }, observation: present }))
      .toThrow("ASSET_UPLOAD_NOT_COMPLETING");
  });
});
