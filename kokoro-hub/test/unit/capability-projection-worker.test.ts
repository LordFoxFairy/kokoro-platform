import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CapabilityProjectionWorker } from
  "../../src/application/capability-projection-worker.js";
import { createEd25519CapabilityCatalogSigner } from
  "../../src/domain/capability-catalog.js";
import type {
  CapabilityProjectionDelivery,
  CapabilityPublicationRepository,
} from "../../src/domain/capability-publication-repository.js";
import { CapabilityProjectionDeliveryError } from
  "../../src/infrastructure/connect/platform-capability-projection-client.js";

describe("capability projection worker", () => {
  it("durably defers an ambiguous result with bounded backoff", async () => {
    const pending = delivery();
    const deferProjection = vi.fn().mockResolvedValue(undefined);
    const repository = repositoryStub({ pending, deferProjection });
    const worker = new CapabilityProjectionWorker({
      repository,
      client: { project: vi.fn().mockRejectedValue(
        new CapabilityProjectionDeliveryError("retry", "PROJECTION_OUTCOME_UNKNOWN"),
      ) },
      clock: () => new Date("2026-07-29T12:00:00.000Z"),
      leaseId: () => "lease-1",
    });
    await expect(worker.tick(new AbortController().signal)).resolves.toBe("deferred");
    expect(deferProjection).toHaveBeenCalledWith({
      siteId: "site-a",
      siteReleaseRef: "release-7",
      leaseId: "lease-1",
      state: "outcome_unknown",
      errorCode: "PROJECTION_OUTCOME_UNKNOWN",
      nextAttemptAt: "2026-07-29T12:00:01.000Z",
    });
  });

  it("marks a permanent Platform rejection terminal instead of retrying", async () => {
    const deferProjection = vi.fn().mockResolvedValue(undefined);
    const worker = new CapabilityProjectionWorker({
      repository: repositoryStub({ pending: delivery(), deferProjection }),
      client: { project: vi.fn().mockRejectedValue(
        new CapabilityProjectionDeliveryError("rejected", "PROJECTION_CONNECT_PERMISSION_DENIED"),
      ) },
      clock: () => new Date("2026-07-29T12:00:00.000Z"),
      leaseId: () => "lease-1",
    });
    await expect(worker.tick(new AbortController().signal)).resolves.toBe("rejected");
    expect(deferProjection).toHaveBeenCalledWith({
      siteId: "site-a",
      siteReleaseRef: "release-7",
      leaseId: "lease-1",
      state: "rejected",
      errorCode: "PROJECTION_CONNECT_PERMISSION_DENIED",
    });
  });
});

function repositoryStub(input: Readonly<{
  pending: CapabilityProjectionDelivery;
  deferProjection: ReturnType<typeof vi.fn>;
}>): CapabilityPublicationRepository {
  return {
    freeze: vi.fn(),
    get: vi.fn(),
    claimProjection: vi.fn().mockResolvedValue(input.pending),
    completeProjection: vi.fn(),
    deferProjection: input.deferProjection,
  };
}

function delivery(): CapabilityProjectionDelivery {
  const { privateKey } = generateKeyPairSync("ed25519");
  const publication = createEd25519CapabilityCatalogSigner({
    signingKeyRef: "hub-signing:revision:7",
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  }).sign({
    siteId: "site-a",
    siteReleaseRef: "release-7",
    frozenAt: "2026-07-29T12:00:00.000Z",
    snapshot: { schemaVersion: 1, agentOptions: [], tools: [], skillOptions: [], mcpOptions: [], subagents: [] },
  });
  return {
    commandId: "freeze-1",
    idempotencyKey: "release-7",
    requestDigest: "1".repeat(64),
    publication,
    recordedAt: publication.frozenAt,
    projectionState: "pending",
    replayed: false,
    leaseId: "lease-1",
    attempt: 1,
  };
}
