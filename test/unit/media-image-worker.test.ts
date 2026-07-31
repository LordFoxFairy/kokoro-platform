import { describe, expect, it, vi } from "vitest";
import {
  ImageOperationWorker,
  InMemoryMediaImageWorkerRepository,
  type MediaImageCreditSettlementPort,
  type MediaImageSessionProjectionPort,
  type MediaImageUsagePort,
} from "../../src/modules/media/application/image-operation-worker.js";
import { DeterministicDevelopmentImageProviderAdapter } from
  "../../src/modules/media/infrastructure/dev/deterministic-image-provider.js";
import { artifactPort, receiptPort } from "./helpers/media-image-worker-fakes.js";

describe("image.text_to_image worker closure", () => {
  it("commits the owner journal before Gateway Create and closes from owner receipts", async () => {
    const events: string[] = [];
    const repository = new InMemoryMediaImageWorkerRepository(undefined, events);
    const effect = new DeterministicDevelopmentImageProviderAdapter(events);
    const artifact = artifactPort(events);
    const usage: MediaImageUsagePort = { recordAttempt: vi.fn(async () => {
      events.push("usage"); return { attemptUsageEvidenceReceiptRef: "usage-receipt:one" };
    }) };
    const credit: MediaImageCreditSettlementPort = {
      releaseChild: vi.fn(async () => ({ allocationReturnReceiptRef: "return:released" })),
      returnChild: vi.fn(async () => { events.push("credit.return");
        return { allocationReturnReceiptRef: "return:one" }; }),
    };
    const projection: MediaImageSessionProjectionPort = { publish: vi.fn(async () => {
      events.push("projection"); return { projectionReceiptRef: "projection-receipt:one" };
    }) };
    const worker = new ImageOperationWorker({ repository, effect, artifact, receipts: receiptPort(),
      trust: { evaluate: vi.fn(async (input) => { events.push("trust");
        return { kind: "allow" as const, decisionRef: "trust:one", contentSha256: input.contentSha256 }; }) },
      usage, credit, projection, clock: () => new Date("2026-07-31T12:00:00.000Z"),
      workerId: "worker:one" });

    expect(await worker.runOne(new AbortController().signal)).toBe("completed");
    expect(repository.inspectTerminal()?.receipts).toMatchObject({
      effectBudgetCommitRef: "effect-budget-commit:example",
      usageEvidenceReceiptRef: "usage-receipt:one",
      allocationReturnReceiptRef: "return:one",
      projectionReceiptRef: "projection-receipt:one",
    });
    expect(events.indexOf("effect.prepare")).toBeLessThan(events.indexOf("gateway.create"));
    expect(events).toContain("trust.record");
    expect(events).toContain("usage.record");
    expect(await worker.runOne(new AbortController().signal)).toBe("idle");
    expect(effect.invocationCount).toBe(1);
  });

  it("fails a single Trust-restricted output without publishing Artifact ready", async () => {
    const events: string[] = [];
    const repository = new InMemoryMediaImageWorkerRepository(undefined, events);
    const artifact = artifactPort(events);
    const credit: MediaImageCreditSettlementPort = {
      releaseChild: vi.fn(async () => ({ allocationReturnReceiptRef: "return:released" })),
      returnChild: vi.fn(async () => ({ allocationReturnReceiptRef: "return:restricted" })),
    };
    const projection: MediaImageSessionProjectionPort = { publish: vi.fn(async () =>
      ({ projectionReceiptRef: "projection:restricted" })) };
    const worker = new ImageOperationWorker({ repository,
      effect: new DeterministicDevelopmentImageProviderAdapter(events), artifact, receipts: receiptPort(),
      trust: { evaluate: vi.fn(async (input) => ({ kind: "restrict" as const,
        decisionRef: "trust-restriction:one", contentSha256: input.contentSha256,
        reasonCode: "publication_policy" })) },
      usage: { recordAttempt: vi.fn(async () => ({ attemptUsageEvidenceReceiptRef: "usage:restricted" })) },
      credit, projection, workerId: "worker:one" });

    expect(await worker.runOne(new AbortController().signal)).toBe("failed");
    expect(artifact.promote).not.toHaveBeenCalled();
    expect(credit.returnChild).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    expect(projection.publish).toHaveBeenCalledWith(expect.objectContaining({
      state: "failed", artifactVersionRefs: [],
    }), expect.any(AbortSignal));
    expect(repository.inspectTerminal()).toMatchObject({ state: "failed", failureCause: {
      kind: "minimum_ready_candidates_not_met", candidateRef: "media-candidate:example",
      outputEvidenceRef: expect.stringContaining("image-effect-output"),
      outputEvidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      restrictionReceiptRef: "trust-restriction:one",
    } });
  });

  it("resumes mixed ready/restricted output closure as partial without repeating owner effects", async () => {
    const events: string[] = [];
    const task = twoCandidateTask();
    const repository = new InMemoryMediaImageWorkerRepository(task, events);
    const artifact = artifactPort(events);
    const trust = vi.fn(async (input: { artifactVersionRef: string; contentSha256: string }) =>
      input.artifactVersionRef === "artifact-version:two"
        ? { kind: "restrict" as const, decisionRef: "trust-restriction:two",
            contentSha256: input.contentSha256, reasonCode: "publication_policy" }
        : { kind: "allow" as const, decisionRef: "trust-allow:one", contentSha256: input.contentSha256 });
    const projection = vi.fn()
      .mockRejectedValueOnce(new Error("SESSION_PROJECTION_RESPONSE_LOST"))
      .mockResolvedValue({ projectionReceiptRef: "projection:partial" });
    const effect = new DeterministicDevelopmentImageProviderAdapter(events);
    const usage = vi.fn(async () => ({ attemptUsageEvidenceReceiptRef: "usage:partial" }));
    const creditReturn = vi.fn(async () => ({ allocationReturnReceiptRef: "return:partial" }));
    const worker = new ImageOperationWorker({ repository,
      effect, artifact, receipts: receiptPort(),
      trust: { evaluate: trust },
      usage: { recordAttempt: usage },
      credit: { releaseChild: vi.fn(async () => ({ allocationReturnReceiptRef: "return:released" })),
        returnChild: creditReturn },
      projection: { publish: projection }, workerId: "worker:one" });

    expect(await worker.runOne(new AbortController().signal)).toBe("reconciling");
    expect(await worker.runOne(new AbortController().signal)).toBe("partial");
    expect(trust).toHaveBeenCalledTimes(2);
    expect(artifact.issueRecoverReadAndStageOutput).toHaveBeenCalledTimes(2);
    expect(artifact.promote).toHaveBeenCalledTimes(1);
    expect(effect.invocationCount).toBe(1);
    expect(usage).toHaveBeenCalledTimes(1);
    expect(creditReturn).toHaveBeenCalledTimes(1);
    expect(projection).toHaveBeenLastCalledWith(expect.objectContaining({
      state: "partial", artifactVersionRefs: ["artifact-version:example"],
    }), expect.any(AbortSignal));
  });

  it("fails mixed output when the frozen Definition forbids partial completion", async () => {
    const events: string[] = [];
    const task = Object.freeze({ ...twoCandidateTask(),
      definitionPolicy: Object.freeze({ partialCompletion: "forbidden" as const, minimumReadyCandidates: 1 }),
    });
    const repository = new InMemoryMediaImageWorkerRepository(task, events);
    const worker = new ImageOperationWorker({ repository,
      effect: new DeterministicDevelopmentImageProviderAdapter(events), artifact: artifactPort(events),
      receipts: receiptPort(), trust: { evaluate: vi.fn(async (input) =>
        input.artifactVersionRef === "artifact-version:two"
          ? { kind: "restrict" as const, decisionRef: "trust-restriction:two",
              contentSha256: input.contentSha256, reasonCode: "publication_policy" }
          : { kind: "allow" as const, decisionRef: "trust-allow:one",
              contentSha256: input.contentSha256 }) },
      usage: { recordAttempt: vi.fn(async () => ({ attemptUsageEvidenceReceiptRef: "usage:forbidden" })) },
      credit: { releaseChild: vi.fn(async () => ({ allocationReturnReceiptRef: "return:released" })),
        returnChild: vi.fn(async () => ({ allocationReturnReceiptRef: "return:failed" })) },
      projection: { publish: vi.fn(async () => ({ projectionReceiptRef: "projection:failed" })) },
      workerId: "worker:one" });

    expect(await worker.runOne(new AbortController().signal)).toBe("failed");
    expect(repository.inspectTerminal()).toMatchObject({ state: "failed", failureCause: {
      kind: "partial_completion_forbidden", candidateRef: "media-candidate:two",
      restrictionReceiptRef: "trust-restriction:two",
    } });
  });

});

function twoCandidateTask() {
  const base = InMemoryMediaImageWorkerRepository.exampleTask();
  return Object.freeze({ ...base,
    definitionPolicy: Object.freeze({ partialCompletion: "allowed" as const, minimumReadyCandidates: 1 }),
    request: Object.freeze({ ...base.request, candidateCount: 2 as const }),
    createEffectCommand: Object.freeze({ ...base.createEffectCommand,
      logicalOutputSlots: Object.freeze([base.createEffectCommand.logicalOutputSlots[0]!, Object.freeze({
        candidateOrdinal: 2, candidateRef: "media-candidate:two", stableOutputSlotRef: "image-slot:two",
      })]) }),
    candidateRefs: Object.freeze([base.candidateRefs[0]!, "media-candidate:two"]),
    stableOutputSlotRefs: Object.freeze([base.stableOutputSlotRefs[0]!, "image-slot:two"]),
    artifactRefs: Object.freeze([base.artifactRefs[0]!, "artifact:two"]),
    artifactVersionRefs: Object.freeze([base.artifactVersionRefs[0]!, "artifact-version:two"]),
    outputAccessCommandRefs: Object.freeze([base.outputAccessCommandRefs[0]!, "output-access:two"]),
    outputAccessRequestFingerprints: Object.freeze([base.outputAccessRequestFingerprints[0]!, "6".repeat(64)]),
  });
}
