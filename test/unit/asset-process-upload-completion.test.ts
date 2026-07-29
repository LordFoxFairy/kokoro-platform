import { describe, expect, it, vi } from "vitest";
import type { PlatformTransaction } from "../../src/shared/unit-of-work/index.js";
import { ProcessUploadCompletionService } from
  "../../src/modules/asset/application/services/process-upload-completion.js";
import { beginUploadCompletion, createUploadIntent, createUploadSession } from
  "../../src/modules/asset/domain/upload-intent.js";

const transaction = Object.freeze({}) as PlatformTransaction;
const intent = createUploadIntent({
  intentRef: "upload_intent_01", siteRef: "site_01", workloadIdentityId: "workload_01",
  siteReleaseRef: "release_01", bindingEpoch: 7n, subjectRef: "subject_01", subjectGeneration: 4n,
  projectRef: "project_01", purpose: "chat.attachment", filename: "photo.png",
  clientMediaType: "image/png", expectedSize: 1234n, expectedChecksumSha256: "a".repeat(64),
  policy: { policyRevisionRef: "asset_policy_01", purpose: "chat.attachment", storageRegion: "us-east-1",
    maximumFileBytes: 10_000_000n, maximumInflightBytes: 100_000_000n,
    maximumReadyBytes: 1_000_000_000n,
    allowedClientMediaTypes: ["image/png"], expiresAt: "2026-07-29T12:00:00.000Z" },
  now: "2026-07-28T12:00:00.000Z",
});
const session = beginUploadCompletion({
  ...createUploadSession({ sessionRef: "upload_session_01", intent,
    quotaRevisionRef: "quota_revision_01", storageTenantRef: "storage_tenant_01",
    storageRegion: "us-east-1", quarantineObjectRef: "quarantine/opaque_0123456789",
    capabilityAudience: "https://upload.example.test", minimumPartBytes: 100n,
    maximumPartBytes: 10_000_000n, capabilityLifetimeSeconds: 300 }),
  state: "uploading", capabilityEpoch: 1n,
  capabilityExpiresAt: "2026-07-28T12:05:00.000Z", expectedVersion: 2n,
}, 2n, "2026-07-28T12:01:00.000Z");
const command = Object.freeze({ eventId: "event_completion_01", siteRef: "site_01",
  intentRef: "upload_intent_01", sessionRef: "upload_session_01", expectedVersion: 3n,
  correlationId: "correlation_01" });

describe("ProcessUploadCompletionService", () => {
  it("observes an exact immutable provider version and atomically queues scanning", async () => {
    const harness = fixture({ checksumSha256: "a".repeat(64) });
    await expect(harness.service.execute(command)).resolves.toEqual({
      disposition: "accepted", candidateRef: "blob_candidate_01",
    });
    expect(harness.computeSha256).not.toHaveBeenCalled();
    expect(harness.commitCandidate).toHaveBeenCalledWith(transaction, expect.objectContaining({
      candidate: expect.objectContaining({ providerVersionRef: "provider_version_01",
        policyRevisionRef: "asset_policy_01", state: "checksum_verified" }),
      expectedSessionVersion: 3n,
      scanEvent: expect.objectContaining({ eventType: "asset.scan.requested",
        causationId: "event_completion_01" }),
    }));
  });

  it("streams the exact provider version with a hard byte cap when HEAD lacks a strong checksum", async () => {
    const harness = fixture({ checksumSha256: null });
    await expect(harness.service.execute(command)).resolves.toMatchObject({ disposition: "accepted" });
    expect(harness.computeSha256).toHaveBeenCalledWith({
      storageTenantRef: "storage_tenant_01", storageRegion: "us-east-1",
      quarantineObjectRef: "quarantine/opaque_0123456789",
      providerVersionRef: "provider_version_01", maximumBytes: 1234n,
    });
  });

  it("retries absence without state mutation and rejects mismatches with durable cleanup", async () => {
    const absent = fixture({ disposition: "absent" });
    await expect(absent.service.execute(command)).resolves.toEqual({
      disposition: "retry", code: "ASSET_QUARANTINE_OBJECT_NOT_VISIBLE",
    });
    expect(absent.commitCandidate).not.toHaveBeenCalled();
    expect(absent.rejectCompletion).not.toHaveBeenCalled();

    const mismatch = fixture({ checksumSha256: "c".repeat(64) });
    await expect(mismatch.service.execute(command)).resolves.toEqual({
      disposition: "rejected", code: "ASSET_OBJECT_CHECKSUM_MISMATCH",
    });
    expect(mismatch.rejectCompletion).toHaveBeenCalledWith(transaction, expect.objectContaining({
      reasonCode: "ASSET_OBJECT_CHECKSUM_MISMATCH",
      cleanupPlan: {
        cleanupGroupRef: "cleanup_group_01",
        terminalReservationState: "released",
        targets: [expect.objectContaining({
          cleanupRef: "cleanup_quarantine_01",
          objectRole: "quarantine",
          objectRef: "quarantine/opaque_0123456789",
          providerVersionRef: "provider_version_01",
          retainedBytes: 1234n,
          cleanupEvent: expect.objectContaining({ eventType: "asset.object.cleanup.requested" }),
        })],
      },
    }));
  });

  it("acks a completion that lost the abort/finalization CAS without recreating authority", async () => {
    const harness = fixture({ checksumSha256: "a".repeat(64), commit: "superseded" });
    await expect(harness.service.execute(command)).resolves.toEqual({ disposition: "superseded" });
  });
});

function fixture(input: Readonly<{
  disposition?: "present" | "absent";
  checksumSha256?: string | null;
  commit?: "committed" | "replay" | "superseded";
}>) {
  const commitCandidate = vi.fn(async () => input.commit ?? "committed" as const);
  const rejectCompletion = vi.fn(async () => "rejected" as const);
  const computeSha256 = vi.fn(async () => "a".repeat(64));
  const references = input.disposition !== "absent" && input.checksumSha256 === "c".repeat(64)
    ? ["blob_candidate_01", "cleanup_group_01", "cleanup_quarantine_01", "cleanup_event_01",
      "rejection_01"]
    : ["blob_candidate_01", "scan_event_01"];
  const service = new ProcessUploadCompletionService({
    unitOfWork: { execute: async (_operation, work) => work(transaction) },
    repository: {
      loadCompletionWork: async () => ({ disposition: "work", intent, session }),
      commitCandidate,
      rejectCompletion,
    },
    objectStore: {
      observe: async () => input.disposition === "absent"
        ? { disposition: "absent", observedAt: "2026-07-28T12:01:05.000Z" }
        : { disposition: "present", providerVersionRef: "provider_version_01",
          providerEtagDigest: "b".repeat(64), size: 1234n,
          checksumSha256: input.checksumSha256 === undefined
            ? "a".repeat(64)
            : input.checksumSha256,
          observedAt: "2026-07-28T12:01:05.000Z" },
      computeSha256,
    },
    reference: () => references.shift() ?? "fallback_reference",
  });
  return { service, commitCandidate, rejectCompletion, computeSha256 };
}
