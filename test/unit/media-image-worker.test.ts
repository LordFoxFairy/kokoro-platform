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
      finalizeBudget: vi.fn(async () => { events.push("credit.finalize");
        return financialSettlement("one"); }),
    };
    const projection: MediaImageSessionProjectionPort = { publish: vi.fn(async () => {
      events.push("projection"); return { projectionReceiptRef: "projection-receipt:one" };
    }) };
    const receipts = receiptPort();
    const effectClosure = vi.spyOn(receipts, "effectClosure");
    const finalTerminal = vi.spyOn(receipts, "finalTerminal");
    const worker = new ImageOperationWorker({ repository, effect, artifact, receipts,
      trust: { evaluate: vi.fn(async (input) => { events.push("trust");
        return { kind: "allow" as const, decisionRef: "trust:one", contentSha256: input.contentSha256 }; }) },
      usage, credit, projection, clock: () => new Date("2026-07-31T12:00:00.000Z"),
      workerId: "worker:one" });

    expect(await worker.runOne(new AbortController().signal)).toBe("completed");
    expect(repository.inspectTerminal()?.receipts).toMatchObject({
      effectBudgetCommitRef: "effect-budget-commit:example",
      usageEvidenceReceiptRef: "usage-receipt:one",
      financialReceiptRef: "financial:one",
      allocationClosureReceiptRef: "allocation-closure:one",
      actualCost: "80",
      refundedCredit: "20",
      creditUnit: "credit",
      projectionReceiptRef: "projection-receipt:one",
    });
    expect(events.indexOf("effect.prepare")).toBeLessThan(events.indexOf("gateway.create"));
    expect(events).toContain("trust.record");
    expect(events).toContain("usage.record");
    expect(effectClosure.mock.invocationCallOrder[0]).toBeLessThan(finalTerminal.mock.invocationCallOrder[0]!);
    expect(credit.finalizeBudget).toHaveBeenCalledWith(expect.objectContaining({
      effectClosureReceiptRef: "media-effect-closure:completed:media-operation:example",
    }));
    expect(finalTerminal).toHaveBeenCalledWith(expect.objectContaining({
      effectClosureReceiptRef: "media-effect-closure:completed:media-operation:example",
      financial: expect.objectContaining({ financialReceiptRef: "financial:one" }),
    }));
    expect(projection.publish).toHaveBeenCalledWith(expect.objectContaining({
      terminalReceiptRef: "media-terminal:completed:media-operation:example:financial:one",
    }), expect.any(AbortSignal));
    expect(await worker.runOne(new AbortController().signal)).toBe("idle");
    expect(effect.invocationCount).toBe(1);
  });

  it("fails a single Trust-restricted output without publishing Artifact ready", async () => {
    const events: string[] = [];
    const repository = new InMemoryMediaImageWorkerRepository(undefined, events);
    const artifact = artifactPort(events);
    const credit: MediaImageCreditSettlementPort = {
      finalizeBudget: vi.fn(async () => financialSettlement("restricted")),
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
    expect(credit.finalizeBudget).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
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
    const creditFinalize = vi.fn(async () => financialSettlement("partial"));
    const worker = new ImageOperationWorker({ repository,
      effect, artifact, receipts: receiptPort(),
      trust: { evaluate: trust },
      usage: { recordAttempt: usage },
      credit: { finalizeBudget: creditFinalize },
      projection: { publish: projection }, workerId: "worker:one" });

    expect(await worker.runOne(new AbortController().signal)).toBe("reconciling");
    expect(await worker.runOne(new AbortController().signal)).toBe("partial");
    expect(trust).toHaveBeenCalledTimes(2);
    expect(artifact.issueRecoverReadAndStageOutput).toHaveBeenCalledTimes(2);
    expect(artifact.promote).toHaveBeenCalledTimes(1);
    expect(effect.invocationCount).toBe(1);
    expect(usage).toHaveBeenCalledTimes(1);
    expect(creditFinalize).toHaveBeenCalledTimes(1);
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
      credit: { finalizeBudget: vi.fn(async () => financialSettlement("failed")) },
      projection: { publish: vi.fn(async () => ({ projectionReceiptRef: "projection:failed" })) },
      workerId: "worker:one" });

    expect(await worker.runOne(new AbortController().signal)).toBe("failed");
    expect(repository.inspectTerminal()).toMatchObject({ state: "failed", failureCause: {
      kind: "partial_completion_forbidden", candidateRef: "media-candidate:two",
      restrictionReceiptRef: "trust-restriction:two",
    } });
  });

  it("finalizes a Direct Studio root budget without fabricating an Agent child", async () => {
    const base = InMemoryMediaImageWorkerRepository.exampleTask();
    const directBudget = Object.freeze({ kind: "direct_root" as const,
      executionBudgetRootRef: "credit-root:direct", rootHoldRef: "credit-hold:direct",
      executionManifestRef: "execution-manifest:direct",
      rootAllocationRef: "credit-allocation:direct", rootAllocationRevision: 1n,
      rootAllocationEpoch: 1n, authorizationSegmentRef: "credit-segment:direct",
      authorizationSegmentVersion: 2n, reservedCeiling: 100n, unit: "credit" });
    const repository = new InMemoryMediaImageWorkerRepository(Object.freeze({ ...base,
      creditBudget: directBudget }));
    const finalizeBudget = vi.fn(async () => financialSettlement("direct"));
    const worker = new ImageOperationWorker({ repository,
      effect: new DeterministicDevelopmentImageProviderAdapter(), artifact: artifactPort([]), receipts: receiptPort(),
      trust: { evaluate: vi.fn(async (input) => ({ kind: "allow" as const, decisionRef: "trust:direct",
        contentSha256: input.contentSha256 })) },
      usage: { recordAttempt: vi.fn(async () => ({ attemptUsageEvidenceReceiptRef: "usage:direct" })) },
      credit: { finalizeBudget },
      projection: { publish: vi.fn(async () => ({ projectionReceiptRef: "projection:direct" })) },
      workerId: "worker:direct" });

    expect(await worker.runOne(new AbortController().signal)).toBe("completed");
    expect(finalizeBudget).toHaveBeenCalledWith(expect.objectContaining({ budget: directBudget,
      outcome: "completed", usage: expect.objectContaining({ attemptUsageEvidenceReceiptRef: "usage:direct" }) }));
  });

  it("keeps the operation reconciling when Credit cannot materialize a certified financial closure", async () => {
    const repository = new InMemoryMediaImageWorkerRepository();
    const projection = vi.fn(async () => ({ projectionReceiptRef: "projection:must-not-run" }));
    const worker = new ImageOperationWorker({ repository,
      effect: new DeterministicDevelopmentImageProviderAdapter(), artifact: artifactPort([]), receipts: receiptPort(),
      trust: { evaluate: vi.fn(async (input) => ({ kind: "allow" as const, decisionRef: "trust:one",
        contentSha256: input.contentSha256 })) },
      usage: { recordAttempt: vi.fn(async () => ({ attemptUsageEvidenceReceiptRef: "usage:opaque" })) },
      credit: { finalizeBudget: vi.fn(async () => ({ kind: "reconciliation_required" as const,
        reconciliationReceiptRef: "reconciliation:usage-materialization", code: "TYPED_USAGE_FACT_UNAVAILABLE" })) },
      projection: { publish: projection }, workerId: "worker:one" });

    expect(await worker.runOne(new AbortController().signal)).toBe("reconciling");
    expect(projection).not.toHaveBeenCalled();
    expect(repository.inspectTerminal()).toBeUndefined();
    expect(repository.inspectState().operation).toBe("reconciling");
  });

  it.each([
    ["unit mismatch", { actualCost: "80", refundedCredit: "20", unit: "other-credit" }],
    ["non-conserving amounts", { actualCost: "79", refundedCredit: "20", unit: "credit" }],
  ])("rejects a Credit settlement with %s before projection", async (_case, override) => {
    const repository = new InMemoryMediaImageWorkerRepository();
    const projection = vi.fn(async () => ({ projectionReceiptRef: "projection:must-not-run" }));
    const worker = new ImageOperationWorker({ repository,
      effect: new DeterministicDevelopmentImageProviderAdapter(), artifact: artifactPort([]), receipts: receiptPort(),
      trust: { evaluate: vi.fn(async (input) => ({ kind: "allow" as const, decisionRef: "trust:one",
        contentSha256: input.contentSha256 })) },
      usage: { recordAttempt: vi.fn(async () => ({ attemptUsageEvidenceReceiptRef: "usage:one" })) },
      credit: { finalizeBudget: vi.fn(async () => Object.freeze({ ...financialSettlement("invalid"),
        ...override })) },
      projection: { publish: projection }, workerId: "worker:one" });

    expect(await worker.runOne(new AbortController().signal)).toBe("reconciling");
    expect(projection).not.toHaveBeenCalled();
    expect(repository.inspectTerminal()).toBeUndefined();
  });

  it("revalidates a persisted financial checkpoint against the task budget before projection", async () => {
    const base = InMemoryMediaImageWorkerRepository.exampleTask();
    const checkpoint = Object.freeze({ effectState: "none" as const, cancelState: "none" as const,
      evidence: Object.freeze({ nextEvidenceSequence: 0n, caughtUp: false, facts: Object.freeze([]) }),
      artifacts: Object.freeze([Object.freeze({ candidateOrdinal: 1 })]),
      financialClosure: Object.freeze({ ...financialSettlement("persisted"), refundedCredit: "19" }) });
    const repository = new InMemoryMediaImageWorkerRepository(base, [], checkpoint);
    const projection = vi.fn(async () => ({ projectionReceiptRef: "projection:must-not-run" }));
    const worker = new ImageOperationWorker({ repository,
      effect: new DeterministicDevelopmentImageProviderAdapter(), artifact: artifactPort([]), receipts: receiptPort(),
      trust: { evaluate: vi.fn(async (input) => ({ kind: "allow" as const, decisionRef: "trust:one",
        contentSha256: input.contentSha256 })) },
      usage: { recordAttempt: vi.fn(async () => ({ attemptUsageEvidenceReceiptRef: "usage:one" })) },
      credit: { finalizeBudget: vi.fn(async () => financialSettlement("must-not-run")) },
      projection: { publish: projection }, workerId: "worker:one" });

    expect(await worker.runOne(new AbortController().signal)).toBe("reconciling");
    expect(projection).not.toHaveBeenCalled();
    expect(repository.inspectTerminal()).toBeUndefined();
  });

});

function financialSettlement(suffix: string) {
  return Object.freeze({ kind: "settled" as const, financialReceiptRef: `financial:${suffix}`,
    allocationClosureReceiptRef: `allocation-closure:${suffix}`, actualCost: "80",
    refundedCredit: "20", unit: "credit" });
}

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
