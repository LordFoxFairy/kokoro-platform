import { describe, expect, it, vi } from "vitest";
import type { PlatformTransaction } from "../../src/shared/unit-of-work/index.js";
import { ProcessAssetObjectCleanupService } from
  "../../src/modules/asset/application/services/process-asset-object-cleanup.js";

const transaction = Object.freeze({}) as PlatformTransaction;
const cleanup = Object.freeze({
  cleanupRef: "cleanup_quarantine_01",
  cleanupGroupRef: "cleanup_group_01",
  siteRef: "site_01",
  intentRef: "upload_intent_01",
  sessionRef: "upload_session_01",
  storageTenantRef: "storage_tenant_01",
  storageRegion: "us-east-1",
  objectRole: "quarantine" as const,
  objectRef: "quarantine/opaque_0123456789",
  providerVersionRef: "provider_version_01",
  retainedBytes: 1234n,
  state: "deleting" as const,
  expectedVersion: 2n,
});
const command = Object.freeze({
  eventId: "cleanup_event_01",
  siteRef: "site_01",
  cleanupRef: "cleanup_quarantine_01",
  expectedVersion: 1n,
  correlationId: "correlation_01",
});

describe("ProcessAssetObjectCleanupService", () => {
  it("deletes the exact immutable object version before releasing retained quota", async () => {
    const harness = fixture();
    await expect(harness.service.execute(command)).resolves.toEqual({ disposition: "completed" });
    expect(harness.deleteExact).toHaveBeenCalledWith({
      storageTenantRef: "storage_tenant_01",
      storageRegion: "us-east-1",
      objectRef: "quarantine/opaque_0123456789",
      providerVersionRef: "provider_version_01",
      expectedSize: 1234n,
    });
    expect(harness.completeCleanup).toHaveBeenCalledWith(transaction, expect.objectContaining({
      cleanup,
      expectedCleanupVersion: 2n,
      receiptRef: "cleanup_receipt_01",
      deletion: {
        disposition: "confirmed_absent",
        providerDisposition: "deleted",
        observedAt: "2026-07-28T12:03:00.000Z",
      },
    }));
  });

  it("persists retry state without releasing retained quota when exact absence is unproven", async () => {
    const harness = fixture({ deleteDisposition: "retry" });
    await expect(harness.service.execute(command)).resolves.toEqual({
      disposition: "retry",
      code: "ASSET_OBJECT_DELETE_OUTCOME_UNKNOWN",
    });
    expect(harness.markCleanupRetry).toHaveBeenCalledWith(transaction, {
      siteRef: "site_01",
      cleanupRef: "cleanup_quarantine_01",
      expectedVersion: 2n,
      reasonCode: "ASSET_OBJECT_DELETE_OUTCOME_UNKNOWN",
    });
    expect(harness.completeCleanup).not.toHaveBeenCalled();
  });

  it("acks a terminal or superseded cleanup event without another storage effect", async () => {
    const harness = fixture({ claim: "terminal" });
    await expect(harness.service.execute(command)).resolves.toEqual({ disposition: "superseded" });
    expect(harness.deleteExact).not.toHaveBeenCalled();
  });
});

function fixture(input: Readonly<{
  claim?: "work" | "terminal";
  deleteDisposition?: "confirmed_absent" | "retry";
}> = {}) {
  const deleteExact = vi.fn(async () => input.deleteDisposition === "retry"
    ? Object.freeze({ disposition: "retry" as const,
      code: "ASSET_OBJECT_DELETE_OUTCOME_UNKNOWN" })
    : Object.freeze({ disposition: "confirmed_absent" as const,
      providerDisposition: "deleted" as const,
      observedAt: "2026-07-28T12:03:00.000Z" }));
  const markCleanupRetry = vi.fn(async () => "committed" as const);
  const completeCleanup = vi.fn(async () => "committed" as const);
  const service = new ProcessAssetObjectCleanupService({
    unitOfWork: { execute: async (_scope, work) => work(transaction) },
    repository: {
      claimCleanupWork: async () => input.claim === "terminal"
        ? { disposition: "terminal" }
        : { disposition: "work", cleanup },
      markCleanupRetry,
      completeCleanup,
    },
    objectStore: { deleteExact },
    reference: () => "cleanup_receipt_01",
  });
  return { service, deleteExact, markCleanupRetry, completeCleanup };
}
