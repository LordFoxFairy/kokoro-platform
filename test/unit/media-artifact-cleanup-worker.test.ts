import { describe, expect, it, vi } from "vitest";
import {
  MediaArtifactCleanupWorker,
  type MediaArtifactCleanupRepository,
} from "../../src/modules/media/application/media-artifact-cleanup-worker.js";

describe("Media staged artifact cleanup worker", () => {
  it("heartbeats, deletes through Artifact owner, and commits the exact lease fence", async () => {
    const events: string[] = [];
    const task = { artifactVersionRef: "artifact-version:one", artifactRef: "artifact:one",
      stagedObjectRef: "staged-object:one", leaseEpoch: 2n, leaseToken: "clear-cleanup-lease-token",
      ownerScope: { siteRef: "site:one", subjectRef: "subject:one", subjectGeneration: 1n,
        projectRef: "project:one" } };
    const repository: MediaArtifactCleanupRepository = {
      claim: vi.fn(async () => { events.push("claim"); return task; }),
      renewLease: vi.fn(async () => { events.push("renew"); }),
      complete: vi.fn(async () => { events.push("complete"); }),
      retryOrDeadLetter: vi.fn(async () => "retry" as const),
      releaseOwnedLeases: vi.fn(async () => undefined),
    };
    const cleanup = { cleanupStaged: vi.fn(async () => { events.push("delete"); }) };
    const worker = new MediaArtifactCleanupWorker({ repository, cleanup, workerId: "worker:one",
      leaseMs: 300, leaseHeartbeatMs: 20 });

    expect(await worker.runOneCycle({ signal: new AbortController().signal })).toBe("completed");
    expect(events).toContain("renew");
    expect(events.indexOf("delete")).toBeLessThan(events.indexOf("complete"));
    expect(repository.complete).toHaveBeenCalledWith(task);
  });

  it("returns cleanup leases during drain without deleting more objects", async () => {
    const repository: MediaArtifactCleanupRepository = { claim: vi.fn(async () => null),
      renewLease: vi.fn(async () => undefined), complete: vi.fn(async () => undefined),
      retryOrDeadLetter: vi.fn(async () => "retry" as const), releaseOwnedLeases: vi.fn(async () => undefined) };
    const cleanup = { cleanupStaged: vi.fn(async () => undefined) };
    const worker = new MediaArtifactCleanupWorker({ repository, cleanup, workerId: "worker:one" });
    await worker.stopClaiming();
    expect(await worker.runOneCycle({ signal: new AbortController().signal })).toBe("idle");
    await worker.returnLeases("shutdown");
    expect(repository.releaseOwnedLeases).toHaveBeenCalledWith({ workerId: "worker:one", reason: "shutdown" });
  });
});
