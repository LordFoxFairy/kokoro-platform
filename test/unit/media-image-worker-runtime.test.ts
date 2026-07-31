import { describe, expect, it, vi } from "vitest";
import {
  ImageOperationWorker,
  InMemoryMediaImageWorkerRepository,
  MediaImageEffectError,
  type MediaImageEffectCommandReceipt,
  type MediaImageEffectCommandResult,
  type MediaImageEffectPort,
  type MediaImageEffectView,
} from "../../src/modules/media/application/image-operation-worker.js";
import { DeterministicDevelopmentImageProviderAdapter } from
  "../../src/modules/media/infrastructure/dev/deterministic-image-provider.js";
import { artifactPort, receiptPort } from "./helpers/media-image-worker-fakes.js";

function ports(events: string[]) {
  return {
    artifact: artifactPort(events), receipts: receiptPort(),
    trust: { evaluate: vi.fn(async (input: { contentSha256: string }) => {
      events.push("trust"); return { kind: "allow" as const, decisionRef: "trust:one",
        contentSha256: input.contentSha256 };
    }) },
    usage: { recordAttempt: vi.fn(async () => { events.push("usage");
      return { attemptUsageEvidenceReceiptRef: "usage:one" }; }) },
    credit: { finalizeBudget: vi.fn(async () => { events.push("credit.finalize");
      return financialSettlement("one"); }) },
    projection: { publish: vi.fn(async (input: { state: string }) => {
      events.push(`projection.${input.state}`); return { projectionReceiptRef: `projection:${input.state}` };
    }) },
  };
}

describe("production Media image worker owner boundaries", () => {
  it("uses the pre-materialized Root Create axes, then pages immutable evidence before output access", async () => {
    const events: string[] = [];
    const repository = new InMemoryMediaImageWorkerRepository(undefined, events);
    const gateway = new DeterministicDevelopmentImageProviderAdapter(events);
    const create = vi.spyOn(gateway, "create");
    const getEvidence = vi.spyOn(gateway, "getEvidence");
    const dependencies = ports(events);
    const worker = new ImageOperationWorker({ repository, effect: gateway, ...dependencies,
      workerId: "worker:one", leaseMs: 300, leaseHeartbeatMs: 20 });

    expect(await worker.runOneCycle({ signal: new AbortController().signal })).toBe("completed");
    expect(events).toContain("lease.renew");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      modelInvocationCommandRef: "model-invocation-command:example",
      callerRequestFingerprint: "a".repeat(64), definitionRoleRef: "image-role:example",
      operationInputRevisionRef: "media-input-revision:example",
      operationInputRevisionDigest: "c".repeat(64),
      effectBudgetCommitRef: "effect-budget-commit:example", effectBudgetCommitDigest: "d".repeat(64),
      trustEffectAllowReceiptRef: "trust-effect-allow:example",
      trustEffectAllowReceiptDigest: "e".repeat(64), modelOptionRevisionRef: "image-option:example",
      attemptOrdinal: 1,
    }));
    expect(getEvidence).toHaveBeenCalledWith(expect.objectContaining({
      afterEvidenceSequence: 0n, limit: 64,
    }));
    expect(dependencies.artifact.issueRecoverReadAndStageOutput).toHaveBeenCalledWith(
      expect.objectContaining({ logicalInvocationRef: expect.stringMatching(/^image-invocation:/u),
        outputEvidenceRef: expect.stringContaining("image-effect-output"),
        outputEvidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        outputAccessRequestFingerprint: "f".repeat(64) }), expect.any(AbortSignal));
  });

  it("cancels before any Gateway effect and returns the Credit child allocation", async () => {
    const events: string[] = [];
    const repository = new InMemoryMediaImageWorkerRepository(undefined, events);
    repository.requestCancellation("cancel-intent:one");
    const gateway = new DeterministicDevelopmentImageProviderAdapter(events);
    const dependencies = ports(events);
    const worker = new ImageOperationWorker({ repository, effect: gateway, ...dependencies, workerId: "worker:one" });

    expect(await worker.runOne(new AbortController().signal)).toBe("canceled");
    expect(gateway.invocationCount).toBe(0);
    expect(dependencies.usage.recordAttempt).not.toHaveBeenCalled();
    expect(dependencies.credit.finalizeBudget).toHaveBeenCalledOnce();
  });

  it("recovers a lost Create response by the original command and never creates twice", async () => {
    const events: string[] = [];
    const repository = new InMemoryMediaImageWorkerRepository(undefined, events);
    const gateway = new DeterministicDevelopmentImageProviderAdapter(events);
    const create = vi.fn(async (input: Parameters<MediaImageEffectPort["create"]>[0]) => {
      await gateway.create(input);
      throw new MediaImageEffectError({ code: "MODEL_GATEWAY_RESPONSE_LOST", disposition: "response_lost" });
    });
    const recoverByCommand = vi.fn(gateway.recoverByCommand.bind(gateway));
    const effect: MediaImageEffectPort = { create, recoverByCommand,
      getByCommand: gateway.getByCommand.bind(gateway), getEvidence: gateway.getEvidence.bind(gateway),
      requestCancel: gateway.requestCancel.bind(gateway) };
    const worker = new ImageOperationWorker({ repository, effect, ...ports(events), workerId: "worker:one" });

    expect(await worker.runOneCycle({ signal: new AbortController().signal })).toBe("reconciling");
    expect(await worker.runOneCycle({ signal: new AbortController().signal })).toBe("completed");
    expect(create).toHaveBeenCalledOnce();
    expect(recoverByCommand).toHaveBeenCalledWith(expect.objectContaining({
      callerCommandRef: "model-invocation-command:example",
    }));
  });

  it("journals a lost cancel response and recovers the cancel command before retrying the effect", async () => {
    const cancel = Object.freeze({ cancelIntentReceiptRef: "cancel-intent:one",
      cancelCommandRef: "image-cancel:one", callerRequestFingerprint: "7".repeat(64) });
    const task = Object.freeze({ ...InMemoryMediaImageWorkerRepository.exampleTask(), cancelEffectCommand: cancel });
    const accepted: MediaImageEffectView = Object.freeze({ logicalInvocationRef: "image-invocation:one",
      modelInvocationCommandRef: task.modelInvocationCommandRef, ownerVersion: 1n, currentAttemptOrdinal: 1,
      state: "accepted", observedAt: "2099-01-01T00:00:00.000Z" });
    const createResult = Object.freeze({ receipt: commandReceipt("create_committed"), invocation: accepted });
    const checkpoint = Object.freeze({ effectState: "recorded" as const, effectReceipt: createResult.receipt,
      effectView: accepted, cancelState: "none" as const,
      evidence: Object.freeze({ nextEvidenceSequence: 0n, caughtUp: false, facts: Object.freeze([]) }),
      artifacts: Object.freeze([{ candidateOrdinal: 1 }]) });
    const repository = new InMemoryMediaImageWorkerRepository(task, [], checkpoint);
    const canceled = terminalView("canceled", false);
    const cancelResult: MediaImageEffectCommandResult = Object.freeze({
      receipt: commandReceipt("cancel_intent_committed", cancel.cancelCommandRef,
        cancel.callerRequestFingerprint), invocation: canceled });
    const requestCancel = vi.fn(async () => { throw new MediaImageEffectError({
      code: "MODEL_GATEWAY_CANCEL_RESPONSE_LOST", disposition: "response_lost" }); });
    const recoverByCommand = vi.fn(async () => cancelResult);
    const effect: MediaImageEffectPort = { create: vi.fn(async () => createResult), recoverByCommand,
      getByCommand: vi.fn(async () => accepted), getEvidence: vi.fn(async () => { throw new Error("UNREACHABLE"); }),
      requestCancel };
    const worker = new ImageOperationWorker({ repository, effect, ...ports([]), workerId: "worker:one" });

    expect(await worker.runOneCycle({ signal: new AbortController().signal })).toBe("reconciling");
    expect(repository.inspectCheckpoint().cancelState).toBe("outcome_unknown");
    expect(await worker.runOneCycle({ signal: new AbortController().signal })).toBe("canceled");
    expect(requestCancel).toHaveBeenCalledOnce();
    expect(recoverByCommand).toHaveBeenCalledWith(expect.objectContaining({ callerCommandRef: cancel.cancelCommandRef }));
  });

  it("rejects a contradictory terminal view before durable evidence or staging", async () => {
    const events: string[] = [];
    const repository = new InMemoryMediaImageWorkerRepository(undefined, events);
    const gateway = new DeterministicDevelopmentImageProviderAdapter(events);
    const baseGetEvidence = gateway.getEvidence.bind(gateway);
    const getEvidence = vi.fn(async (input: Parameters<MediaImageEffectPort["getEvidence"]>[0]) => {
      const page = await baseGetEvidence(input);
      return Object.freeze({ ...page,
        invocation: Object.freeze({ ...page.invocation, ownerVersion: page.invocation.ownerVersion + 1n }),
        evidenceFacts: Object.freeze([...page.evidenceFacts, ...page.evidenceFacts.slice(0, 1)
          .map((fact) => Object.freeze({ ...fact, evidenceSequence: page.nextEvidenceSequence + 1n }))]),
        nextEvidenceSequence: page.nextEvidenceSequence + 1n,
      });
    });
    const effect: MediaImageEffectPort = { create: gateway.create.bind(gateway),
      recoverByCommand: gateway.recoverByCommand.bind(gateway), getByCommand: gateway.getByCommand.bind(gateway),
      getEvidence, requestCancel: gateway.requestCancel.bind(gateway) };
    const dependencies = ports(events);
    const worker = new ImageOperationWorker({ repository, effect, ...dependencies, workerId: "worker:one" });

    expect(await worker.runOneCycle({ signal: new AbortController().signal })).toBe("reconciling");
    expect(dependencies.artifact.issueRecoverReadAndStageOutput).not.toHaveBeenCalled();
    expect(repository.inspectCheckpoint().evidence.nextEvidenceSequence).toBe(0n);
  });

  it("rejects duplicate evidence refs across a page even when sequences are contiguous", async () => {
    const repository = new InMemoryMediaImageWorkerRepository();
    const gateway = new DeterministicDevelopmentImageProviderAdapter();
    const baseGetEvidence = gateway.getEvidence.bind(gateway);
    const effect: MediaImageEffectPort = { create: gateway.create.bind(gateway),
      recoverByCommand: gateway.recoverByCommand.bind(gateway), getByCommand: gateway.getByCommand.bind(gateway),
      getEvidence: async (input) => {
        const page = await baseGetEvidence(input);
        const duplicate = Object.freeze({ ...page.evidenceFacts[0]!,
          evidenceSequence: page.nextEvidenceSequence + 1n });
        return Object.freeze({ ...page, evidenceFacts: Object.freeze([...page.evidenceFacts, duplicate]),
          nextEvidenceSequence: duplicate.evidenceSequence });
      }, requestCancel: gateway.requestCancel.bind(gateway) };
    const dependencies = ports([]);
    const worker = new ImageOperationWorker({ repository, effect, ...dependencies, workerId: "worker:one" });

    expect(await worker.runOneCycle({ signal: new AbortController().signal })).toBe("reconciling");
    expect(repository.inspectCheckpoint().evidence.facts).toHaveLength(0);
  });

  it("requires a new planned authorization after definitely-not-submitted and exposes no Attach shortcut", async () => {
    const repository = new InMemoryMediaImageWorkerRepository();
    const result = Object.freeze({ receipt: commandReceipt("definitely_not_submitted") });
    const effect: MediaImageEffectPort = { create: vi.fn(async () => result),
      recoverByCommand: vi.fn(async () => result), getByCommand: vi.fn(async () => { throw new Error("UNREACHABLE"); }),
      getEvidence: vi.fn(async () => { throw new Error("UNREACHABLE"); }),
      requestCancel: vi.fn(async () => result) };
    const worker = new ImageOperationWorker({ repository, effect, ...ports([]), workerId: "worker:one" });

    expect(await worker.runOneCycle({ signal: new AbortController().signal })).toBe("reconciling");
    expect(effect.getByCommand).not.toHaveBeenCalled();
    expect("attach" in effect).toBe(false);
  });

  it("closes failed owner state only from canonical outcome/usage evidence, never provider refs", async () => {
    const repository = new InMemoryMediaImageWorkerRepository();
    const view = terminalView("failed", true);
    const result: MediaImageEffectCommandResult = Object.freeze({ receipt: commandReceipt("create_committed"),
      invocation: view });
    const effect: MediaImageEffectPort = { create: vi.fn(async () => result),
      recoverByCommand: vi.fn(async () => result), getByCommand: vi.fn(async () => view),
      getEvidence: vi.fn(async () => { throw new Error("UNREACHABLE"); }),
      requestCancel: vi.fn(async () => result) };
    const dependencies = ports([]);
    const worker = new ImageOperationWorker({ repository, effect, ...dependencies, workerId: "worker:one" });

    expect(await worker.runOne(new AbortController().signal)).toBe("failed");
    expect(dependencies.usage.recordAttempt).toHaveBeenCalledWith(expect.objectContaining({
      logicalInvocationRef: "image-invocation:one",
      canonicalOutcomeEvidence: { ref: "outcome:one", digest: "1".repeat(64) },
      usageEvidence: { ref: "usage:owner", digest: "2".repeat(64) }, outputEvidence: [],
    }));
    expect(JSON.stringify(repository.inspectTerminal())).not.toContain("provider");
  });
});

function commandReceipt(
  kind: MediaImageEffectCommandReceipt["kind"],
  callerCommandRef = "model-invocation-command:example",
  requestDigest = "a".repeat(64),
): MediaImageEffectCommandReceipt {
  return Object.freeze({ receiptRef: `image-effect-receipt:sha256:${"8".repeat(64)}`,
    receiptDigest: "8".repeat(64), requestDigest, callerCommandRef, kind,
    ...(["create_committed", "cancel_intent_committed"].includes(kind)
      ? { logicalInvocationRef: "image-invocation:one" } : {}),
    receiptVersion: 1n,
    recordedAt: "2099-01-01T00:00:00.000Z" });
}

function financialSettlement(suffix: string) {
  return Object.freeze({ kind: "settled" as const, financialReceiptRef: `financial:${suffix}`,
    allocationClosureReceiptRef: `allocation-closure:${suffix}`, actualCost: "80",
    refundedCredit: "20", unit: "credit" });
}

function terminalView(state: "failed" | "canceled", withUsage: boolean): MediaImageEffectView {
  return Object.freeze({ logicalInvocationRef: "image-invocation:one",
    modelInvocationCommandRef: "model-invocation-command:example", ownerVersion: 1n,
    currentAttemptOrdinal: 1, state, canonicalOutcomeEvidence: { ref: "outcome:one", digest: "1".repeat(64) },
    ...(withUsage ? { usageEvidence: { ref: "usage:owner", digest: "2".repeat(64) } } : {}),
    observedAt: "2099-01-01T00:00:00.000Z" });
}
