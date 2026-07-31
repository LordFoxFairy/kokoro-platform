import { describe, expect, it, vi } from "vitest";
import { createImageEffectAttempt, imageEffectUsageFactDigest, type ImageEffectAttempt,
  type ImageEffectProviderObservation } from
  "../../src/modules/model-gateway/domain/image-effect.js";
import { ImageEffectDispatchWorker, type CertifiedImageEffectProvider, type ImageEffectDispatchClaim } from
  "../../src/modules/model-gateway/application/image-effect-worker.js";

const SUBMITTED_OBSERVATION = { kind: "submitted", eventRef: "event:one", sequence: 1n,
  observationDigest: "a".repeat(64), observedAt: "2026-07-31T12:00:00.000Z",
  providerOperationRef: "provider:one" } as const satisfies ImageEffectProviderObservation;
const USAGE_FACT = Object.freeze({ evidenceKind: "measured" as const,
  dimensions: Object.freeze([Object.freeze({ dimensionKey: "image", sourceUnit: "output", quantity: 1n })]),
  attemptOutcome: "succeeded" as const, occurredAt: "2026-07-31T12:01:00.000Z",
  sourceDigest: "9".repeat(64) });
const OBSERVATIONS: readonly ImageEffectProviderObservation[] = [
  SUBMITTED_OBSERVATION,
  { kind: "succeeded", eventRef: "event:two", sequence: 2n, observationDigest: "b".repeat(64),
    observedAt: "2026-07-31T12:01:00.000Z", outcomeEvidenceRef: "outcome:one",
    outcomeEvidenceDigest: "c".repeat(64), usageEvidenceRef: "usage:one",
    usageEvidenceDigest: imageEffectUsageFactDigest(USAGE_FACT), usageFact: USAGE_FACT,
    outputs: [{ candidateRef: "candidate:one",
      stableOutputSlotRef: "slot:one", providerOutputFactRef: "output:one",
      retrievalGrantHandle: "r".repeat(32), mediaType: "image/png", width: 1024, height: 1024,
      declaredByteSize: 4096n }] },
];

describe("image-effect dispatch worker", () => {
  it("starts Provider I/O through a certified adapter and commits every fenced observation", async () => {
    const attempt = createImageEffectAttempt({ attemptRef: "attempt:one", ordinal: 1,
      budgetCommitRef: "budget:one", budgetCommitDigest: "e".repeat(64),
      providerOperationKey: "provider-key:one" });
    const record = vi.fn(async (
      _claim: ImageEffectDispatchClaim,
      _observation: ImageEffectProviderObservation,
      persistedAttempt: ImageEffectAttempt,
    ) => persistedAttempt);
    const begin = vi.fn(async () => ({ firstObservation: SUBMITTED_OBSERVATION,
      observations: stream(OBSERVATIONS.slice(1)) }));
    const worker = new ImageEffectDispatchWorker({
      repository: {
        claim: async () => ({ siteId: "site:one", attemptRef: "attempt:one", logicalInvocationRef: "invocation:one",
          dispatchOwnerRef: "worker:one", dispatchFence: 3n }),
        load: async () => ({ siteId: "site:one", logicalInvocationRef: "invocation:one",
          definitionRoleRef: "image.text_to_image.v1", modelOptionRevisionRef: "option:one",
          deploymentRef: "deployment:one", adapterKind: "certified-image-v1",
          providerModel: "provider-model:one", operationInputRevisionRef: "input:one",
          operationInputRevisionDigest: "f".repeat(64), sourceGrantRefs: ["source:one"],
          logicalOutputSlots: [{ candidateRef: "candidate:one", stableOutputSlotRef: "slot:one" }],
          attempt }),
        heartbeat: async () => true,
        recordObservation: record,
        recordStartAmbiguity: vi.fn(),
        recordStreamAmbiguity: vi.fn(),
        deadLetterBeforeProviderIo: vi.fn(),
      },
      secrets: { withSourceGrants: async (_claim, work) => work([{ sourceVersionRef: "source:one",
        purposeGrantHandle: new TextEncoder().encode("s".repeat(32)) }]) },
      provider: { certification: () => ({ adapterKind: "certified-image-v1",
        protocol: "kokoro.image-provider-effects.v1", idempotency: "provider-operation-key" }), begin },
      dispatchOwnerRef: "worker:one",
      leaseMilliseconds: 30_000,
    });
    expect(await worker.runOne()).toBe(true);
    expect(begin).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[1]?.[2].state).toBe("succeeded");
  });

  it("rejects an uncertified adapter before any work can be claimed", () => {
    expect(() => new ImageEffectDispatchWorker({
      repository: {} as never,
      secrets: {} as never,
      provider: { certification: () => ({ adapterKind: "fake", protocol: "fake", idempotency: "none" }),
        begin: vi.fn() },
      dispatchOwnerRef: "worker:one",
      leaseMilliseconds: 30_000,
    })).toThrow("IMAGE_EFFECT_PROVIDER_CERTIFICATION_INVALID");
  });

  it("records submission-unknown ownership when begin throws after crossing the Provider boundary", async () => {
    const attempt = createImageEffectAttempt({ attemptRef: "attempt:one", ordinal: 1,
      budgetCommitRef: "budget:one", budgetCommitDigest: "e".repeat(64),
      providerOperationKey: "provider-key:one" });
    const startUnknown = vi.fn(async () => ({ ...attempt, state: "submission_unknown" as const }));
    const deadLetter = vi.fn(async () => true);
    const worker = new ImageEffectDispatchWorker({
      repository: {
        ...repositoryFor(attempt),
        recordStartAmbiguity: startUnknown,
        deadLetterBeforeProviderIo: deadLetter,
      },
      secrets: { withSourceGrants: async (_claim, work) => work([]) },
      provider: certifiedProvider(async () => { throw new Error("PROVIDER_RESPONSE_LOST"); }),
      dispatchOwnerRef: "worker:one", leaseMilliseconds: 30_000,
    });
    await expect(worker.runOne()).rejects.toThrow("PROVIDER_RESPONSE_LOST");
    expect(startUnknown).toHaveBeenCalledOnce();
    expect(deadLetter).not.toHaveBeenCalled();
  });

  it("does not mutate owner state after the dispatch signal is already aborted", async () => {
    const attempt = createImageEffectAttempt({ attemptRef: "attempt:one", ordinal: 1,
      budgetCommitRef: "budget:one", budgetCommitDigest: "e".repeat(64),
      providerOperationKey: "provider-key:one" });
    const repository = repositoryFor(attempt);
    const begin = vi.fn();
    const worker = new ImageEffectDispatchWorker({
      repository,
      secrets: { withSourceGrants: async (_claim, work) => work([]) },
      provider: certifiedProvider(begin),
      dispatchOwnerRef: "worker:one", leaseMilliseconds: 30_000,
    });
    const controller = new AbortController();
    controller.abort(new Error("STOP_REQUESTED"));
    await expect(worker.runOne(controller.signal)).rejects.toThrow("STOP_REQUESTED");
    expect(begin).not.toHaveBeenCalled();
    expect(repository.recordStartAmbiguity).not.toHaveBeenCalled();
    expect(repository.recordStreamAmbiguity).not.toHaveBeenCalled();
    expect(repository.deadLetterBeforeProviderIo).not.toHaveBeenCalled();
  });

  it("durably records start ambiguity when ordinary shutdown aborts begin after Provider I/O starts", async () => {
    const attempt = createImageEffectAttempt({ attemptRef: "attempt:one", ordinal: 1,
      budgetCommitRef: "budget:one", budgetCommitDigest: "e".repeat(64),
      providerOperationKey: "provider-key:one" });
    const repository = repositoryFor(attempt);
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const begin: CertifiedImageEffectProvider["begin"] = async (_context, _grants, signal) => {
      notifyStarted();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const worker = new ImageEffectDispatchWorker({
      repository,
      secrets: { withSourceGrants: async (_claim, work) => work([]) },
      provider: certifiedProvider(begin),
      dispatchOwnerRef: "worker:one", leaseMilliseconds: 30_000,
    });
    const controller = new AbortController();
    const running = worker.runOne(controller.signal);
    await started;
    controller.abort(new Error("STOP_REQUESTED"));
    await expect(running).rejects.toThrow("STOP_REQUESTED");
    expect(repository.recordStartAmbiguity).toHaveBeenCalledWith(expect.anything(),
      "IMAGE_EFFECT_WORKER_ABORTED_AFTER_PROVIDER_IO");
    expect(repository.deadLetterBeforeProviderIo).not.toHaveBeenCalled();
  });
});

function repositoryFor(attempt: ImageEffectAttempt) {
  return {
    claim: async () => ({ siteId: "site:one", attemptRef: "attempt:one", logicalInvocationRef: "invocation:one",
      dispatchOwnerRef: "worker:one", dispatchFence: 3n }),
    load: async () => ({ siteId: "site:one", logicalInvocationRef: "invocation:one",
      definitionRoleRef: "image.text_to_image.v1", modelOptionRevisionRef: "option:one",
      deploymentRef: "deployment:one", adapterKind: "certified-image-v1", providerModel: "provider-model:one",
      operationInputRevisionRef: "input:one", operationInputRevisionDigest: "f".repeat(64), sourceGrantRefs: [],
      logicalOutputSlots: [{ candidateRef: "candidate:one", stableOutputSlotRef: "slot:one" }], attempt }),
    heartbeat: async () => true,
    recordObservation: vi.fn(async (_claim, _observation, persisted: ImageEffectAttempt) => persisted),
    recordStartAmbiguity: vi.fn(async () => attempt),
    recordStreamAmbiguity: vi.fn(async () => attempt),
    deadLetterBeforeProviderIo: vi.fn(async () => true),
  };
}

function certifiedProvider(begin: CertifiedImageEffectProvider["begin"]): CertifiedImageEffectProvider {
  return { certification: () => ({ adapterKind: "certified-image-v1", protocol: "kokoro.image-provider-effects.v1",
    idempotency: "provider-operation-key" }), begin };
}

async function* stream(values: readonly ImageEffectProviderObservation[]) {
  for (const value of values) yield value;
}
