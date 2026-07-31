import { describe, expect, it, vi } from "vitest";
import { InMemoryArtifactObjectStore } from "../../src/modules/artifact/index.js";
import {
  ImageOperationWorker,
  InMemoryMediaImageWorkerRepository,
  type ImageOutputTrustPort,
  type MediaImageCreditSettlementPort,
  type MediaImageSessionProjectionPort,
  type MediaImageUsagePort,
} from "../../src/modules/media/application/image-operation-worker.js";
import { DeterministicDevelopmentImageProviderAdapter } from
  "../../src/modules/media/infrastructure/dev/deterministic-image-provider.js";

describe("image.text_to_image worker closure", () => {
  it("journals the effect before the provider and closes only after Artifact, usage, Credit and Session receipts", async () => {
    const events: string[] = [];
    const repository = new InMemoryMediaImageWorkerRepository({
      operationRef: "media-operation:one",
      taskRef: "media-task:one",
      modelInvocationCommandRef: "model-invocation-command:one",
      request: { promptIntent: "fox", aspectRatio: "square_1_1", candidateCount: 1,
        outputFormat: "png", modelOptionRevisionRef: "image-option:revision:1" },
      candidateRefs: ["media-candidate:one"],
      artifactVersionRefs: ["artifact-version:one"],
      ownerScope: { siteRef: "site:one", subjectRef: "subject:one", subjectGeneration: 1n,
        projectRef: "project:one" },
      creditChildAllocationRef: "credit-child:one",
    }, events);
    const provider = new DeterministicDevelopmentImageProviderAdapter(events);
    const artifact = new InMemoryArtifactObjectStore();
    const trust: ImageOutputTrustPort = { evaluate: vi.fn(async (input) => {
      events.push("trust");
      return { kind: "allow" as const, decisionRef: "trust-output:one", contentSha256: input.contentSha256 };
    }) };
    const usage: MediaImageUsagePort = { recordAttempt: vi.fn(async () => {
      events.push("usage"); return { attemptUsageEvidenceReceiptRef: "usage-receipt:one" };
    }) };
    const credit: MediaImageCreditSettlementPort = { settleChild: vi.fn(async () => {
      events.push("credit"); return { effectBudgetCommitRef: "budget-commit:one" };
    }) };
    const projection: MediaImageSessionProjectionPort = { publish: vi.fn(async () => {
      events.push("projection"); return { projectionReceiptRef: "projection-receipt:one" };
    }) };
    const worker = new ImageOperationWorker({ repository, provider, artifact, trust, usage, credit, projection,
      clock: () => new Date("2026-07-31T12:00:00.000Z"), workerId: "worker:one" });

    expect(await worker.runOne(new AbortController().signal)).toBe("completed");
    expect(repository.inspectTerminal()?.state).toBe("completed");
    expect(repository.inspectTerminal()?.receipts).toMatchObject({
      usageEvidenceReceiptRef: "usage-receipt:one",
      effectBudgetCommitRef: "budget-commit:one",
      projectionReceiptRef: "projection-receipt:one",
      artifactFinalizationReceiptRefs: [expect.stringMatching(/^artifact-finalization:/u)],
    });
    expect(events).toEqual([
      "claim", "effect.begin", "provider.create-or-recover", "effect.record",
      "artifact.stage", "trust", "artifact.promote", "usage", "credit", "projection", "complete",
    ]);
    expect(await worker.runOne(new AbortController().signal)).toBe("idle");
    expect(provider.invocationCount).toBe(1);
  });

  it("recovers a journaled provider outcome without repeating the provider effect", async () => {
    const events: string[] = [];
    const task = InMemoryMediaImageWorkerRepository.exampleTask();
    const provider = new DeterministicDevelopmentImageProviderAdapter(events);
    const recovered = await provider.createOrRecover({ commandRef: task.modelInvocationCommandRef,
      request: task.request, signal: new AbortController().signal });
    events.length = 0;
    const repository = new InMemoryMediaImageWorkerRepository(task, events, recovered);
    const worker = new ImageOperationWorker({ repository, provider, artifact: new InMemoryArtifactObjectStore(),
      trust: { evaluate: async (input) => ({ kind: "allow", decisionRef: "trust:one",
        contentSha256: input.contentSha256 }) },
      usage: { recordAttempt: async () => ({ attemptUsageEvidenceReceiptRef: "usage:one" }) },
      credit: { settleChild: async () => ({ effectBudgetCommitRef: "budget:one" }) },
      projection: { publish: async () => ({ projectionReceiptRef: "projection:one" }) },
      workerId: "worker:one" });

    expect(await worker.runOne(new AbortController().signal)).toBe("completed");
    expect(provider.invocationCount).toBe(1);
    expect(events).not.toContain("provider.create-or-recover");
  });
});
