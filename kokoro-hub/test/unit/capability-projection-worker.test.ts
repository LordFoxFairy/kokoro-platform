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
  it("releases a claimed lease when shutdown wins the claim race", async () => {
    let resolveClaim!: (value: CapabilityProjectionDelivery | null) => void;
    const claim = new Promise<CapabilityProjectionDelivery | null>((resolve) => {
      resolveClaim = resolve;
    });
    const releaseProjection = vi.fn().mockResolvedValue(undefined);
    const completeProjection = vi.fn().mockResolvedValue(undefined);
    const deferProjection = vi.fn().mockResolvedValue(undefined);
    const project = vi.fn().mockResolvedValue(undefined);
    const repository = repositoryStub({
      pending: delivery(),
      deferProjection,
      releaseProjection,
      completeProjection,
      claimProjection: vi.fn().mockReturnValue(claim),
    });
    const worker = new CapabilityProjectionWorker({
      repository,
      client: { project },
      clock: () => new Date("2026-07-29T12:00:00.000Z"),
      leaseId: () => "lease-1",
    });
    const controller = new AbortController();
    const tick = worker.tick(controller.signal);

    controller.abort(new Error("HUB_SHUTDOWN"));
    resolveClaim(delivery());

    await expect(tick).resolves.toBe("idle");
    expect(releaseProjection).toHaveBeenCalledWith({
      siteId: "site-a",
      siteReleaseRef: "release-7",
      leaseId: "lease-1",
    });
    expect(project).not.toHaveBeenCalled();
    expect(completeProjection).not.toHaveBeenCalled();
    expect(deferProjection).not.toHaveBeenCalled();
  });

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
  releaseProjection?: ReturnType<typeof vi.fn>;
  completeProjection?: ReturnType<typeof vi.fn>;
  claimProjection?: ReturnType<typeof vi.fn>;
}>): CapabilityPublicationRepository {
  return {
    freeze: vi.fn(),
    get: vi.fn(),
    findByAgentCatalogRef: vi.fn(),
    claimProjection: input.claimProjection ?? vi.fn().mockResolvedValue(input.pending),
    completeProjection: input.completeProjection ?? vi.fn(),
    deferProjection: input.deferProjection,
    releaseProjection: input.releaseProjection ?? vi.fn(),
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
