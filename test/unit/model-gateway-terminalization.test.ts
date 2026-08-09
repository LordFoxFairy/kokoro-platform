import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ModelGatewayService,
  type ModelGatewayFrameWaiter,
  type ModelGatewayInvocationRecord,
  type ModelGatewayOutcomeUnknownAuthority,
  type ModelGatewayProviderOutcome,
  type ModelGatewayProviderPort,
  type ModelGatewayRepository,
  type ModelGatewayRequest,
  type ModelGatewayStreamFrame,
  type ModelGatewayStreamPayload,
  type ModelGatewayStreamingRepository,
  type ModelGatewayUnitOfWork,
  type ModelGatewayUsageOwnerPort,
  type ModelInvocationAuthorization,
} from "../../src/modules/model-gateway/application/model-gateway-service.js";

type UnitOfWorkOperation = "prepare" | "attach" | "claim" | "frame" |
  "finalize" | "unknown";

type HarnessStats = {
  localPrepareCalls: number;
  providerEffectCalls: number;
  finalizeAttemptCalls: number;
  markUnknownCalls: number;
  ownerEvidenceRefs: string[];
  operations: Map<UnitOfWorkOperation, number>;
};

type HarnessInput = Readonly<{
  repository?: TerminalizationMemoryRepository;
  outcome?: ModelGatewayProviderOutcome;
  includeContentDelta?: boolean;
  finalizeAttempt?: (
    call: number,
    evidenceRef: string,
  ) => Promise<Readonly<{ evidenceRef: string; revision: bigint }>>;
  markUnknown?: (
    call: number,
    ownerEvidenceRef: string,
  ) => Promise<Readonly<{
    state: "outcome_unknown";
    fenceEpoch: bigint;
    attemptAuthorizationRef: string;
  }>>;
  afterExecute?: (operation: UnitOfWorkOperation, call: number) => Promise<void> | void;
  scanDispatchCandidates?: ModelGatewayUnitOfWork["scanDispatchCandidates"];
  clock?: () => Date;
  terminalizationRetryInitialMs?: number;
  terminalizationRetryMaximumMs?: number;
  instanceRef?: string;
  dispatchRecoveryAfterMs?: number;
}>;

describe("ModelGatewayService provider terminalization", () => {
  afterEach(() => vi.useRealTimers());

  it("A: converts a non-commit finalize failure immediately to one durable outcome_unknown terminal", async () => {
    const privateFailureText = "private database detail that must never enter evidence";
    const privateRetryText = "different private retry detail";
    const harness = createHarness({
      includeContentDelta: true,
      finalizeAttempt: async () => { throw new Error(privateFailureText); },
      markUnknown: async (call) => {
        if (call === 1) throw new Error(privateRetryText);
        return unknownReceipt();
      },
    });
    const alternate = createHarness({
      includeContentDelta: true,
      finalizeAttempt: async () => { throw new TypeError("unrelated private driver text"); },
    });

    try {
      const first = await collectWithDeadline(harness.service);
      expect(first.map(({ payload }) => payload.kind)).toEqual([
        "accepted", "content_delta", "outcome_unknown",
      ]);
      expect(harness.stats.providerEffectCalls).toBe(1);
      expect(harness.stats.finalizeAttemptCalls).toBe(1);
      expect(harness.stats.markUnknownCalls).toBe(2);
      expect(operationCount(harness.stats, "unknown")).toBe(2);
      expect(new Set(harness.stats.ownerEvidenceRefs)).toHaveLength(1);
      expect(harness.repository.record?.ownerEvidenceRef).toMatch(
        /^model-gateway-terminalization:sha256:[0-9a-f]{64}$/u,
      );
      expect(harness.repository.record?.ownerEvidenceRef).not.toContain(privateFailureText);
      expect(harness.repository.record?.ownerEvidenceRef).not.toContain(privateRetryText);

      await collectWithDeadline(alternate.service);
      expect(alternate.repository.record?.ownerEvidenceRef)
        .toBe(harness.repository.record?.ownerEvidenceRef);
      expect(alternate.repository.record?.ownerEvidenceRef)
        .not.toContain("unrelated private driver text");

      const attached = await collectWithDeadline(harness.service);
      expect(attached).toEqual(first);
      expect(harness.stats.localPrepareCalls).toBe(2);
      expect(harness.stats.providerEffectCalls).toBe(1);
      expect(harness.repository.terminalFrames()).toHaveLength(1);
    } finally {
      await Promise.all([harness.service.shutdown(), alternate.service.shutdown()]);
    }
  });

  it("B: keeps the dispatch active and exponentially retries only terminalization", async () => {
    vi.useFakeTimers({ now: new Date("2029-01-01T00:00:00.000Z") });
    const harness = createHarness({
      outcome: unknownOutcome("c"),
      terminalizationRetryInitialMs: 10,
      terminalizationRetryMaximumMs: 40,
      markUnknown: async (call) => {
        if (call < 3) throw new Error("TRANSIENT_TERMINALIZATION_FAILURE");
        return unknownReceipt();
      },
    });
    const controller = new AbortController();
    const collected = collect(harness.service.stream(invocation(controller.signal)));

    try {
      await vi.advanceTimersByTimeAsync(0);
      await flushMicrotasks();
      expect(harness.stats.markUnknownCalls).toBe(1);
      expect(harness.service.activeDispatchCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(9);
      expect(harness.stats.markUnknownCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.stats.markUnknownCalls).toBe(2);
      expect(harness.service.activeDispatchCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(19);
      expect(harness.stats.markUnknownCalls).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      await flushMicrotasks();

      expect(harness.stats.markUnknownCalls).toBe(3);
      expect(new Set(harness.stats.ownerEvidenceRefs)).toEqual(new Set([
        `provider-outcome:sha256:${"c".repeat(64)}`,
      ]));
      expect(harness.service.activeDispatchCount()).toBe(0);
      expect(harness.stats.localPrepareCalls).toBe(1);
      expect(harness.stats.providerEffectCalls).toBe(1);
      expect((await collected).map(({ payload }) => payload.kind)).toEqual([
        "accepted", "outcome_unknown",
      ]);
    } finally {
      controller.abort("test-complete");
      await harness.service.shutdown();
    }
  });

  it("B: renews the durable owner lease past its original expiry while terminalization retries", async () => {
    vi.useFakeTimers({ now: new Date("2029-01-01T00:00:00.000Z") });
    const repository = new TerminalizationMemoryRepository();
    let expiredRecoveryAttempts = 0;
    let terminalUnknownAttempts = 0;
    const harness = createHarness({
      repository,
      instanceRef: "model-gateway:terminalization-owner",
      outcome: unknownOutcome("c"),
      clock: () => new Date(Date.now()),
      dispatchRecoveryAfterMs: 3_000,
      terminalizationRetryInitialMs: 500,
      terminalizationRetryMaximumMs: 1_000,
      markUnknown: async () => {
        terminalUnknownAttempts += 1;
        if (terminalUnknownAttempts < 5) throw new Error("TRANSIENT_TERMINALIZATION_FAILURE");
        return unknownReceipt();
      },
    });
    const scanner = createHarness({
      repository,
      instanceRef: "model-gateway:independent-scanner",
      clock: () => new Date(Date.now()),
      scanDispatchCandidates: async () => {
        const leaseExpiresAt = Date.parse(repository.record?.dispatchLeaseExpiresAt ?? "");
        if (repository.record?.state === "dispatching" && leaseExpiresAt <= Date.now()) {
          expiredRecoveryAttempts += 1;
          return [{
            modelAuthorizationHandle: authorizationHandle,
            logicalCallRef: "logical-call-1",
          }];
        }
        return [];
      },
    });
    const controller = new AbortController();
    scanner.service.start();
    const collected = collect(harness.service.stream(invocation(controller.signal)));

    try {
      await vi.advanceTimersByTimeAsync(3_250);
      await flushMicrotasks();

      expect(repository.heartbeatCalls).toBeGreaterThanOrEqual(1);
      expect(Date.parse(repository.record?.dispatchLeaseExpiresAt ?? "")).toBeGreaterThan(Date.now());
      expect(expiredRecoveryAttempts).toBe(0);
      expect(scanner.stats.markUnknownCalls).toBe(0);
      expect(harness.service.activeDispatchCount()).toBe(1);
      expect(harness.stats.providerEffectCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(500);
      await flushMicrotasks();
      expect((await collected).map(({ payload }) => payload.kind)).toEqual([
        "accepted", "outcome_unknown",
      ]);
      expect(repository.record?.ownerEvidenceRef)
        .toBe(`provider-outcome:sha256:${"c".repeat(64)}`);
      expect(harness.service.activeDispatchCount()).toBe(0);
      expect(harness.stats.providerEffectCalls).toBe(1);
    } finally {
      controller.abort("test-complete");
      await Promise.all([harness.service.shutdown(), scanner.service.shutdown()]);
    }
  });

  it("B: renews before every supported one-second lease can expire", async () => {
    vi.useFakeTimers({ now: new Date("2029-01-01T00:00:00.000Z") });
    const harness = createHarness({
      outcome: unknownOutcome("f"),
      clock: () => new Date(Date.now()),
      dispatchRecoveryAfterMs: 1_000,
      terminalizationRetryInitialMs: 500,
      terminalizationRetryMaximumMs: 500,
      markUnknown: async (call) => {
        if (call < 4) throw new Error("TRANSIENT_TERMINALIZATION_FAILURE");
        return unknownReceipt();
      },
    });
    const controller = new AbortController();
    const collected = collect(harness.service.stream(invocation(controller.signal)));

    try {
      await vi.advanceTimersByTimeAsync(1_250);
      await flushMicrotasks();

      expect(harness.repository.heartbeatCalls).toBeGreaterThanOrEqual(2);
      expect(Date.parse(harness.repository.record?.dispatchLeaseExpiresAt ?? ""))
        .toBeGreaterThan(Date.now());
      expect(harness.repository.record?.state).toBe("dispatching");
      expect(harness.service.activeDispatchCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(300);
      await flushMicrotasks();
      expect((await collected).map(({ payload }) => payload.kind)).toEqual([
        "accepted", "outcome_unknown",
      ]);
      expect(harness.stats.providerEffectCalls).toBe(1);
    } finally {
      controller.abort("test-complete");
      await harness.service.shutdown();
    }
  });

  it.each([
    ["same instance", "model-gateway:recovery-scanner"],
    ["independent instance", "model-gateway:active-owner"],
  ])("B: %s recovery rechecks an expired observation after the active owner renews", async (
    _label,
    activeOwnerRef,
  ) => {
    const repository = new TerminalizationMemoryRepository();
    repository.record = dispatchingRecord({
      ownerInstanceRef: activeOwnerRef,
      leaseExpiresAt: "2029-01-01T00:00:01.000Z",
    });
    let scans = 0;
    const scanner = createHarness({
      repository,
      instanceRef: "model-gateway:recovery-scanner",
      clock: () => new Date("2029-01-01T00:00:02.000Z"),
      scanDispatchCandidates: async () => scans++ === 0
        ? [{ modelAuthorizationHandle: authorizationHandle, logicalCallRef: "logical-call-1" }]
        : [],
      afterExecute: (operation, call) => {
        if (operation !== "attach" || call !== 1 || repository.record === null) return;
        repository.record = Object.freeze({
          ...repository.record,
          dispatchLeaseExpiresAt: "2029-01-01T00:00:10.000Z",
          updatedAt: "2029-01-01T00:00:02.000Z",
        });
      },
    });

    try {
      scanner.service.start();
      await waitFor(() => operationCount(scanner.stats, "unknown") >= 1);

      expect(scanner.stats.localPrepareCalls).toBe(0);
      expect(scanner.stats.providerEffectCalls).toBe(0);
      expect(scanner.stats.markUnknownCalls).toBe(0);
      expect(repository.record?.state).toBe("dispatching");
      expect(repository.record?.dispatchOwnerRef).toBe(activeOwnerRef);
      expect(repository.record?.dispatchLeaseExpiresAt).toBe("2029-01-01T00:00:10.000Z");
      expect(repository.terminalFrames()).toHaveLength(0);
    } finally {
      await scanner.service.shutdown();
    }
  });

  it("B: keeps a caller attached when its expired observation loses to an owner renewal", async () => {
    const repository = new TerminalizationMemoryRepository();
    const expired = dispatchingRecord({
      ownerInstanceRef: "model-gateway:active-owner",
      leaseExpiresAt: "2029-01-01T00:00:01.000Z",
    });
    repository.record = expired;
    repository.seedFrame({ kind: "accepted" });
    const harness = createHarness({
      repository,
      instanceRef: "model-gateway:attaching-caller",
      clock: () => new Date("2029-01-01T00:00:02.000Z"),
      afterExecute: (operation, call) => {
        if (operation !== "prepare" || call !== 1 || repository.record === null) return;
        repository.record = Object.freeze({
          ...repository.record,
          dispatchLeaseExpiresAt: "2029-01-01T00:00:10.000Z",
          updatedAt: "2029-01-01T00:00:02.000Z",
        });
      },
    });
    const controller = new AbortController();
    const completion = collect(harness.service.stream(invocation(controller.signal)));
    const terminal = setTimeout(() => {
      if (repository.record === null) return;
      repository.record = Object.freeze({
        ...repository.record,
        state: "outcome_unknown",
        fenceEpoch: 2n,
        ownerEvidenceRef: `provider-outcome:sha256:${"9".repeat(64)}`,
        updatedAt: "2029-01-01T00:00:03.000Z",
      });
      repository.seedFrame({ kind: "outcome_unknown" });
    }, 10);

    try {
      await expect(completion).resolves.toMatchObject([
        { payload: { kind: "accepted" } },
        { payload: { kind: "outcome_unknown" } },
      ]);
      expect(harness.stats.markUnknownCalls).toBe(0);
      expect(harness.stats.localPrepareCalls).toBe(1);
      expect(harness.stats.providerEffectCalls).toBe(0);
      expect(repository.terminalFrames()).toHaveLength(1);
    } finally {
      clearTimeout(terminal);
      controller.abort("test-complete");
      await harness.service.shutdown();
    }
  });

  it("C: replays a commit-ambiguous successful finalize without downgrading or duplicating its terminal", async () => {
    const harness = createHarness({
      afterExecute: (operation, call) => {
        if (operation === "finalize" && call === 1) {
          throw new Error("COMMIT_ACK_LOST_AFTER_SUCCESSFUL_FINALIZE");
        }
      },
    });

    try {
      const frames = await collectWithDeadline(harness.service);
      await waitFor(() => operationCount(harness.stats, "unknown") === 1);

      expect(frames.map(({ payload }) => payload.kind)).toEqual(["accepted", "completed"]);
      expect(harness.repository.record?.state).toBe("succeeded");
      expect(harness.repository.terminalFrames().map(({ payload }) => payload.kind))
        .toEqual(["completed"]);
      expect(harness.stats.providerEffectCalls).toBe(1);
      expect(harness.stats.finalizeAttemptCalls).toBe(1);
      expect(harness.stats.markUnknownCalls).toBe(0);
      expect(harness.service.activeDispatchCount()).toBe(0);
    } finally {
      await harness.service.shutdown();
    }
  });

  it("D: replays a commit-ambiguous outcome_unknown without duplicating its terminal", async () => {
    const harness = createHarness({
      outcome: unknownOutcome("d"),
      terminalizationRetryInitialMs: 5,
      terminalizationRetryMaximumMs: 20,
      afterExecute: (operation, call) => {
        if (operation === "unknown" && call === 1) {
          throw new Error("COMMIT_ACK_LOST_AFTER_OUTCOME_UNKNOWN");
        }
      },
    });

    try {
      const frames = await collectWithDeadline(harness.service);
      await waitFor(() => operationCount(harness.stats, "unknown") === 2);

      expect(frames.map(({ payload }) => payload.kind)).toEqual([
        "accepted", "outcome_unknown",
      ]);
      expect(harness.repository.record?.state).toBe("outcome_unknown");
      expect(harness.repository.terminalFrames().map(({ payload }) => payload.kind))
        .toEqual(["outcome_unknown"]);
      expect(harness.stats.markUnknownCalls).toBe(1);
      expect(harness.stats.providerEffectCalls).toBe(1);
      expect(harness.service.activeDispatchCount()).toBe(0);
    } finally {
      await harness.service.shutdown();
    }
  });

  it("E: shutdown leaves a persistently unterminated effect for restart maintenance to mark unknown without a provider", async () => {
    const repository = new TerminalizationMemoryRepository();
    const first = createHarness({
      repository,
      outcome: unknownOutcome("e"),
      terminalizationRetryInitialMs: 5,
      terminalizationRetryMaximumMs: 20,
      markUnknown: async () => { throw new Error("DATABASE_STILL_UNAVAILABLE"); },
      clock: () => new Date("2029-01-01T00:00:00.000Z"),
    });
    const controller = new AbortController();
    const iterator = first.service.stream(invocation(controller.signal))[Symbol.asyncIterator]();

    expect((await iterator.next()).value?.payload.kind).toBe("accepted");
    await waitFor(() => first.stats.markUnknownCalls >= 1);
    expect(first.service.activeDispatchCount()).toBe(1);
    expect(first.stats.providerEffectCalls).toBe(1);

    await first.service.shutdown();
    controller.abort("first-process-stopped");
    await iterator.return?.();
    expect(first.service.activeDispatchCount()).toBe(0);
    expect(repository.record?.state).toBe("dispatching");

    let scans = 0;
    const restarted = createHarness({
      repository,
      clock: () => new Date("2029-01-01T00:00:02.000Z"),
      scanDispatchCandidates: async () => scans++ === 0
        ? [{ modelAuthorizationHandle: authorizationHandle, logicalCallRef: "logical-call-1" }]
        : [],
    });
    try {
      restarted.service.start();
      await waitFor(() => repository.record?.state === "outcome_unknown");

      expect(restarted.stats.localPrepareCalls).toBe(0);
      expect(restarted.stats.providerEffectCalls).toBe(0);
      expect(restarted.stats.markUnknownCalls).toBe(1);
      expect(repository.terminalFrames().map(({ payload }) => payload.kind))
        .toEqual(["outcome_unknown"]);
      expect(repository.record?.ownerEvidenceRef).toMatch(
        /^model-gateway-owner-expired:sha256:[0-9a-f]{64}$/u,
      );
    } finally {
      await restarted.service.shutdown();
    }
  });
});

class TerminalizationMemoryRepository implements ModelGatewayRepository,
  ModelGatewayStreamingRepository, ModelGatewayFrameWaiter {
  record: ModelGatewayInvocationRecord | null = null;
  request: ModelGatewayRequest | null = null;
  readonly frames: ModelGatewayStreamFrame[] = [];
  heartbeatCalls = 0;
  readonly #waiters = new Set<() => void>();

  async lockInvocation(_transaction: never, input: Readonly<{ logicalCallRef: string }>) {
    return this.record?.logicalCallRef === input.logicalCallRef ? this.record : null;
  }

  async reserveCapacity() {}

  async persistAccepted(
    _transaction: never,
    record: ModelGatewayInvocationRecord,
    request: ModelGatewayRequest,
  ) {
    this.record = record;
    this.request = request;
    return this.append({ kind: "accepted" });
  }

  async loadRequest() {
    if (this.request === null) throw new Error("TEST_PERSISTED_REQUEST_MISSING");
    return this.request;
  }

  async claimInvocation(_transaction: never, input: Readonly<{
    record: ModelGatewayInvocationRecord;
    ownerInstanceRef: string;
    leaseExpiresAt: string;
  }>) {
    if (this.record?.state !== "queued") return null;
    this.record = Object.freeze({
      ...input.record,
      state: "dispatching" as const,
      dispatchOwnerRef: input.ownerInstanceRef,
      dispatchFence: 1n,
      dispatchLeaseExpiresAt: input.leaseExpiresAt,
    });
    return this.record;
  }

  async appendFrame(_transaction: never, input: Readonly<{
    payload: Extract<ModelGatewayStreamPayload,
      { kind: "content_delta" | "reasoning_delta" | "tool_call_delta" }>;
  }>) {
    return this.append(input.payload);
  }

  async heartbeat(_transaction: never, input: Readonly<{
    record: ModelGatewayInvocationRecord;
    ownerInstanceRef: string;
    leaseExpiresAt: string;
  }>) {
    if (this.record?.state !== "dispatching" ||
        this.record.dispatchOwnerRef !== input.ownerInstanceRef ||
        this.record.dispatchFence !== input.record.dispatchFence ||
        Date.parse(this.record.dispatchLeaseExpiresAt ?? "") <= Date.now()) {
      throw new Error("TEST_HEARTBEAT_FENCE_LOST");
    }
    this.heartbeatCalls += 1;
    this.record = Object.freeze({
      ...this.record,
      dispatchLeaseExpiresAt: input.leaseExpiresAt,
    });
  }

  async persistTerminal(_transaction: never, record: ModelGatewayInvocationRecord) {
    this.record = record;
  }

  async persistOutcomeUnknown(
    _transaction: never,
    record: ModelGatewayInvocationRecord,
    authority: ModelGatewayOutcomeUnknownAuthority,
  ) {
    const current = this.record;
    const authorized = current?.state === "dispatching" && (
      authority.kind === "owned"
        ? current.dispatchOwnerRef === authority.ownerInstanceRef &&
          current.dispatchFence === authority.dispatchFence
        : current.dispatchOwnerRef === authority.observedOwnerInstanceRef &&
          current.dispatchFence === authority.observedDispatchFence &&
          current.dispatchLeaseExpiresAt === authority.observedLeaseExpiresAt
    );
    if (!authorized) throw new Error("TEST_UNKNOWN_AUTHORITY_LOST");
    this.record = record;
  }

  async appendTerminalFrame(
    _transaction: never,
    _record: ModelGatewayInvocationRecord,
    payload: Extract<ModelGatewayStreamPayload,
      { kind: "completed" | "failed" | "outcome_unknown" }>,
  ) {
    return this.append(payload);
  }

  async listFrames(_transaction: never, input: Readonly<{ afterSequence: bigint }>) {
    return this.frames.filter(({ sequence }) => sequence > input.afterSequence);
  }

  async waitForFrame(
    _invocationRef: string,
    afterSequence: bigint,
    signal: AbortSignal,
    maximumWaitMs: number,
  ): Promise<void> {
    if (this.frames.some(({ sequence }) => sequence > afterSequence)) return;
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        this.#waiters.delete(finish);
        resolve();
      };
      const aborted = () => {
        clearTimeout(timer);
        this.#waiters.delete(finish);
        reject(signal.reason);
      };
      const timer = setTimeout(finish, maximumWaitMs);
      timer.unref();
      this.#waiters.add(finish);
      signal.addEventListener("abort", aborted, { once: true });
    });
  }

  terminalFrames(): readonly ModelGatewayStreamFrame[] {
    return this.frames.filter(({ payload }) =>
      payload.kind === "completed" || payload.kind === "failed" ||
      payload.kind === "outcome_unknown");
  }

  seedFrame(payload: ModelGatewayStreamPayload): ModelGatewayStreamFrame {
    return this.append(payload);
  }

  private append(payload: ModelGatewayStreamPayload): ModelGatewayStreamFrame {
    const previousFrameDigest = this.frames.at(-1)?.frameDigest ?? "0".repeat(64);
    const sequence = BigInt(this.frames.length + 1);
    const frame = Object.freeze({
      invocationRef: this.record?.invocationRef ?? "invocation-1",
      attemptRef: this.record?.attemptRef ?? "attempt-1",
      sequence,
      previousFrameDigest,
      frameDigest: sha256(`${sequence}:${previousFrameDigest}:${payload.kind}`),
      payload,
    });
    this.frames.push(frame);
    for (const waiter of [...this.#waiters]) waiter();
    return frame;
  }
}

function createHarness(input: HarnessInput = {}) {
  const repository = input.repository ?? new TerminalizationMemoryRepository();
  const stats: HarnessStats = {
    localPrepareCalls: 0,
    providerEffectCalls: 0,
    finalizeAttemptCalls: 0,
    markUnknownCalls: 0,
    ownerEvidenceRefs: [],
    operations: new Map(),
  };
  const resolvedAuthorization = authorization();
  const unitOfWork: ModelGatewayUnitOfWork = {
    scanDispatchCandidates: input.scanDispatchCandidates ?? (async () => []),
    execute: async (scope, work) => {
      const call = operationCount(stats, scope.operation) + 1;
      stats.operations.set(scope.operation, call);
      const value = await work({} as never, resolvedAuthorization);
      await input.afterExecute?.(scope.operation, call);
      return value;
    },
  };
  const usageOwner: ModelGatewayUsageOwnerPort = {
    prepareAttempt: async () => ({ kind: "accepted" as const, value: {
      state: "effect_committed" as const,
      attemptAuthorizationRef: "attempt-authorization-1",
      fenceEpoch: 1n,
    } }),
    finalizeAttempt: async (_transaction, finalizeInput) => {
      stats.finalizeAttemptCalls += 1;
      const receipt = input.finalizeAttempt === undefined
        ? { evidenceRef: finalizeInput.evidenceRef, revision: 1n }
        : await input.finalizeAttempt(stats.finalizeAttemptCalls, finalizeInput.evidenceRef);
      return { kind: "accepted" as const, value: receipt };
    },
    markAttemptOutcomeUnknown: async (_transaction, unknownInput) => {
      stats.markUnknownCalls += 1;
      stats.ownerEvidenceRefs.push(unknownInput.ownerEvidenceRef);
      const receipt = input.markUnknown === undefined
        ? unknownReceipt()
        : await input.markUnknown(stats.markUnknownCalls, unknownInput.ownerEvidenceRef);
      return { kind: "accepted" as const, value: receipt };
    },
  };
  const provider: ModelGatewayProviderPort = {
    prepare: () => {
      stats.localPrepareCalls += 1;
      return Object.freeze({
        gatewayModel: "chat-primary",
        requestDigest: "a".repeat(64),
        maximumDimensions: Object.freeze([
          Object.freeze({ dimensionKey: "output_tokens", sourceUnit: "token", quantity: 16n }),
        ]),
        stream: async function* () {
          stats.providerEffectCalls += 1;
          if (input.includeContentDelta === true) {
            yield Object.freeze({ kind: "content_delta" as const, content: "hello" });
          }
          yield Object.freeze({
            kind: "terminal" as const,
            outcome: input.outcome ?? succeededOutcome(),
          });
        },
      });
    },
  };
  const dependencies = {
    unitOfWork,
    repository,
    streamingRepository: repository,
    frameWaiter: repository,
    provider,
    usageOwner,
    reference: (kind: "invocation" | "evidence" | "outbox") =>
      kind === "invocation" ? "invocation-1" : "evidence-1",
    clock: input.clock ?? (() => new Date("2029-01-01T00:00:00.000Z")),
    instanceRef: input.instanceRef ?? "model-gateway:terminalization-test",
    dispatchRecoveryAfterMs: input.dispatchRecoveryAfterMs ?? 1_000,
    providerHardTimeoutMs: 1_000,
    terminalizationRetryInitialMs: input.terminalizationRetryInitialMs ?? 10,
    terminalizationRetryMaximumMs: input.terminalizationRetryMaximumMs ?? 40,
  };
  // The retry settings are deliberately part of this RED contract before the implementation adds them.
  const service = new ModelGatewayService(dependencies);
  return Object.freeze({ repository, service, stats });
}

function authorization(): ModelInvocationAuthorization {
  return Object.freeze({
    modelAuthorizationHandle: authorizationHandle,
    siteId: "site-a",
    executionManifestRef: "manifest-a",
    authorizationSegmentRef: "segment-a",
    authorizedGatewayModel: "chat-primary",
    providerModel: "provider-chat-v1",
    adapterKind: "direct",
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
}

function succeededOutcome(): Extract<ModelGatewayProviderOutcome, { kind: "succeeded" | "failed" }> {
  const responseBody = new TextEncoder().encode(
    '{"choices":[{"index":0,"message":{"content":"hello","role":"assistant"}}],"id":"chatcmpl-1"}',
  );
  return Object.freeze({
    kind: "succeeded",
    responseBody,
    usage: null,
    responseDigest: sha256(responseBody),
    sourceDigest: "b".repeat(64),
    occurredAt: "2029-01-01T00:00:01.000Z",
  });
}

function unknownOutcome(digit: string): Extract<ModelGatewayProviderOutcome, { kind: "outcome_unknown" }> {
  return Object.freeze({
    kind: "outcome_unknown",
    ownerEvidenceRef: `provider-outcome:sha256:${digit.repeat(64)}`,
  });
}

function unknownReceipt() {
  return Object.freeze({
    state: "outcome_unknown" as const,
    fenceEpoch: 2n,
    attemptAuthorizationRef: "attempt-authorization-1",
  });
}

function dispatchingRecord(input: Readonly<{
  ownerInstanceRef: string;
  leaseExpiresAt: string;
}>): ModelGatewayInvocationRecord {
  return Object.freeze({
    siteId: "site-a",
    invocationRef: "invocation-1",
    modelAuthorizationHandle: authorizationHandle,
    executionManifestRef: "manifest-a",
    authorizationSegmentRef: "segment-a",
    logicalCallRef: "logical-call-1",
    attemptRef: "attempt-1",
    producerContext: "ga-run-1",
    producerGeneration: 1n,
    requestDigest: "a".repeat(64),
    gatewayModel: "chat-primary",
    maximumDimensions: Object.freeze([
      Object.freeze({ dimensionKey: "output_tokens", sourceUnit: "token", quantity: 16n }),
    ]),
    attemptAuthorizationRef: "attempt-authorization-1",
    fenceEpoch: 1n,
    state: "dispatching",
    responseBody: null,
    usageEvidence: null,
    evidenceRef: null,
    sourceDigest: null,
    ownerEvidenceRef: null,
    dispatchOwnerRef: input.ownerInstanceRef,
    dispatchFence: 1n,
    dispatchLeaseExpiresAt: input.leaseExpiresAt,
    createdAt: "2029-01-01T00:00:00.000Z",
    updatedAt: "2029-01-01T00:00:00.000Z",
  });
}

const authorizationHandle = `model-authorization:sha256:${"f".repeat(64)}`;

function invocation(signal: AbortSignal = new AbortController().signal) {
  return Object.freeze({
    modelAuthorizationHandle: authorizationHandle,
    logicalCallRef: "logical-call-1",
    attemptRef: "attempt-1",
    producerContext: "ga-run-1",
    producerGeneration: 1n,
    request: Object.freeze({
      protocol: "openai.chat.completions.v1" as const,
      model: "chat-primary",
      messages: Object.freeze([
        Object.freeze({ role: "user" as const, content: "hello", toolCalls: Object.freeze([]) }),
      ]),
      maxOutputTokens: 16,
      tools: Object.freeze([]),
      toolChoice: "none" as const,
    }),
    afterSequence: 0n,
    signal,
  });
}

async function collectWithDeadline(service: ModelGatewayService, maximumMs = 500) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      collect(service.stream(invocation(controller.signal))),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("TEST_STREAM_TERMINAL_TIMEOUT")), maximumMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort("test-stream-complete");
  }
}

async function collect(source: AsyncIterable<ModelGatewayStreamFrame>) {
  const result: ModelGatewayStreamFrame[] = [];
  for await (const frame of source) result.push(frame);
  return result;
}

async function waitFor(predicate: () => boolean, maximumMs = 1_000): Promise<void> {
  const deadline = Date.now() + maximumMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("TEST_CONDITION_TIMEOUT");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function operationCount(stats: HarnessStats, operation: UnitOfWorkOperation): number {
  return stats.operations.get(operation) ?? 0;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
