import { createHash, randomUUID } from "node:crypto";
import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";
import type { UsageSettlementService } from "../../credit/application/usage-settlement-service.js";

export type ModelUsageDimension = Readonly<{
  dimensionKey: string;
  sourceUnit: string;
  quantity: bigint;
}>;

export type ModelGatewayJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ModelGatewayJsonValue[]
  | Readonly<{ [key: string]: ModelGatewayJsonValue }>;

export type ModelGatewayToolCall = Readonly<{
  id: string;
  name: string;
  arguments: Readonly<{ [key: string]: ModelGatewayJsonValue }>;
}>;

export type ModelGatewayMessage = Readonly<{
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls: readonly ModelGatewayToolCall[];
  toolCallId?: string;
  name?: string;
}>;

export type ModelGatewayToolDefinition = Readonly<{
  name: string;
  description: string;
  inputSchema: Readonly<{ [key: string]: ModelGatewayJsonValue }>;
}>;

export type ModelGatewayRequest = Readonly<{
  protocol: "openai.chat.completions.v1";
  model: string;
  messages: readonly ModelGatewayMessage[];
  maxOutputTokens: number;
  tools: readonly ModelGatewayToolDefinition[];
  toolChoice: "auto" | "none" | "required" | Readonly<{ name: string }>;
}>;

export type ModelInvocationAuthorization = Readonly<{
  modelAuthorizationHandle: string;
  siteId: string;
  executionManifestRef: string;
  authorizationSegmentRef: string;
  authorizedGatewayModel: string;
  providerModel: string;
  adapterKind: "litellm" | "direct";
  expiresAt: string;
}>;

export type ModelGatewayProviderOutcome =
  | Readonly<{
      kind: "succeeded" | "failed";
      responseBody: Uint8Array;
      usage: readonly ModelUsageDimension[] | null;
      responseDigest: string;
      // Digest of the original bounded provider response, before safe projection.
      sourceDigest: string;
      occurredAt: string;
    }>
  | Readonly<{
      kind: "outcome_unknown";
      ownerEvidenceRef: string;
    }>;

export type ModelGatewayProviderDelta =
  | Readonly<{ kind: "content_delta"; content: string }>
  | Readonly<{ kind: "reasoning_delta"; content: string }>
  | Readonly<{
      kind: "tool_call_delta";
      toolIndex: number;
      id?: string;
      name?: string;
      argumentsJsonFragment: Uint8Array;
    }>;

export type ModelGatewayProviderStreamEvent =
  | ModelGatewayProviderDelta
  | Readonly<{ kind: "terminal"; outcome: ModelGatewayProviderOutcome }>;

export interface PreparedModelProviderRequest {
  readonly gatewayModel: string;
  readonly requestDigest: string;
  readonly maximumDimensions: readonly ModelUsageDimension[];
  stream(input: Readonly<{
    signal: AbortSignal;
    providerOperationKey: string;
  }>): AsyncIterable<ModelGatewayProviderStreamEvent>;
}

export interface ModelGatewayProviderPort {
  prepare(
    request: ModelGatewayRequest,
    authorization: ModelInvocationAuthorization,
  ): PreparedModelProviderRequest;
}

export class ModelGatewayProviderRouter implements ModelGatewayProviderPort {
  readonly #adapters: Readonly<Partial<Record<
    ModelInvocationAuthorization["adapterKind"],
    ModelGatewayProviderPort
  >>>;

  constructor(adapters: Readonly<Partial<Record<
    ModelInvocationAuthorization["adapterKind"],
    ModelGatewayProviderPort
  >>>) {
    this.#adapters = Object.freeze({ ...adapters });
  }

  prepare(
    request: ModelGatewayRequest,
    authorization: ModelInvocationAuthorization,
  ): PreparedModelProviderRequest {
    if (request.model !== authorization.authorizedGatewayModel) {
      throw new Error("MODEL_GATEWAY_AUTHORIZATION_ROUTE_MISMATCH");
    }
    const adapter = this.#adapters[authorization.adapterKind];
    if (adapter === undefined) throw new Error("MODEL_GATEWAY_PROVIDER_ADAPTER_UNAVAILABLE");
    return adapter.prepare(request, authorization);
  }
}

export type ModelGatewayInvocationState =
  | "queued"
  | "dispatching"
  | "succeeded"
  | "failed"
  | "outcome_unknown";

export type ModelGatewayInvocationRecord = Readonly<{
  siteId: string;
  invocationRef: string;
  modelAuthorizationHandle: string;
  executionManifestRef: string;
  authorizationSegmentRef: string;
  logicalCallRef: string;
  attemptRef: string;
  producerContext: string;
  producerGeneration: bigint;
  requestDigest: string;
  gatewayModel: string;
  maximumDimensions: readonly ModelUsageDimension[];
  attemptAuthorizationRef: string;
  fenceEpoch: bigint;
  state: ModelGatewayInvocationState;
  responseBody: Uint8Array | null;
  usageEvidence: Readonly<{
    evidenceKind: "measured" | "unavailable";
    dimensions: readonly ModelUsageDimension[];
    attemptOutcome: "succeeded" | "failed_after_effect";
    occurredAt: string;
  }> | null;
  evidenceRef: string | null;
  sourceDigest: string | null;
  ownerEvidenceRef: string | null;
  dispatchOwnerRef?: string | null;
  dispatchFence?: bigint;
  dispatchLeaseExpiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export interface ModelGatewayRepository {
  lockInvocation(
    transaction: PlatformTransaction,
    input: Readonly<{ logicalCallRef: string }>,
  ): Promise<ModelGatewayInvocationRecord | null>;
  persistTerminal(
    transaction: PlatformTransaction,
    record: ModelGatewayInvocationRecord,
    priorState: "dispatching" | "outcome_unknown",
  ): Promise<void>;
  persistOutcomeUnknown(
    transaction: PlatformTransaction,
    record: ModelGatewayInvocationRecord,
    authority: ModelGatewayOutcomeUnknownAuthority,
  ): Promise<void>;
}

export type ModelGatewayOutcomeUnknownAuthority =
  | Readonly<{
      kind: "owned";
      ownerInstanceRef: string;
      dispatchFence: bigint;
    }>
  | Readonly<{
      kind: "expired";
      observedOwnerInstanceRef: string;
      observedDispatchFence: bigint;
      observedLeaseExpiresAt: string;
    }>;

export interface ModelGatewayUnitOfWork {
  scanDispatchCandidates(limit: number): Promise<readonly Readonly<{
    modelAuthorizationHandle: string;
    logicalCallRef: string;
  }>[]>;
  execute<Result>(
    scope: Readonly<{
      operation: "prepare" | "attach" | "claim" | "frame" | "finalize" | "unknown";
      modelAuthorizationHandle: string;
    }>,
    work: (
      transaction: PlatformTransaction,
      authorization: ModelInvocationAuthorization,
    ) => Promise<Result>,
  ): Promise<Result>;
}

export type ModelGatewayStreamPayload =
  | Readonly<{ kind: "accepted" }>
  | ModelGatewayProviderDelta
  | Readonly<{ kind: "completed" | "failed"; responseBody: Uint8Array }>
  | Readonly<{ kind: "outcome_unknown" }>;

export type ModelGatewayStreamFrame = Readonly<{
  invocationRef: string;
  attemptRef: string;
  sequence: bigint;
  previousFrameDigest: string;
  frameDigest: string;
  payload: ModelGatewayStreamPayload;
}>;

type ModelGatewayStreamAttachment = Readonly<{
  attachedToExistingInvocation: boolean;
}>;

export interface ModelGatewayStreamingRepository {
  reserveCapacity(
    transaction: PlatformTransaction,
    limits: Readonly<{ maximumActive: number; maximumQueued: number }>,
  ): Promise<void>;
  persistAccepted(
    transaction: PlatformTransaction,
    record: ModelGatewayInvocationRecord,
    request: ModelGatewayRequest,
  ): Promise<ModelGatewayStreamFrame>;
  loadRequest(
    transaction: PlatformTransaction,
    record: ModelGatewayInvocationRecord,
  ): Promise<ModelGatewayRequest>;
  claimInvocation(
    transaction: PlatformTransaction,
    input: Readonly<{
      record: ModelGatewayInvocationRecord;
      ownerInstanceRef: string;
      leaseExpiresAt: string;
    }>,
  ): Promise<ModelGatewayInvocationRecord | null>;
  appendFrame(
    transaction: PlatformTransaction,
    input: Readonly<{
      record: ModelGatewayInvocationRecord;
      ownerInstanceRef: string;
      payload: ModelGatewayProviderDelta;
    }>,
  ): Promise<ModelGatewayStreamFrame>;
  heartbeat(
    transaction: PlatformTransaction,
    input: Readonly<{
      record: ModelGatewayInvocationRecord;
      ownerInstanceRef: string;
      leaseExpiresAt: string;
    }>,
  ): Promise<void>;
  appendTerminalFrame(
    transaction: PlatformTransaction,
    record: ModelGatewayInvocationRecord,
    payload: Extract<ModelGatewayStreamPayload, { kind: "completed" | "failed" | "outcome_unknown" }>,
  ): Promise<ModelGatewayStreamFrame>;
  listFrames(
    transaction: PlatformTransaction,
    input: Readonly<{
      record: ModelGatewayInvocationRecord;
      afterSequence: bigint;
      limit: number;
    }>,
  ): Promise<readonly ModelGatewayStreamFrame[]>;
}

export interface ModelGatewayFrameWaiter {
  waitForFrame(
    invocationRef: string,
    afterSequence: bigint,
    signal: AbortSignal,
    maximumWaitMs: number,
  ): Promise<void>;
}

export type ModelGatewayUsageOwnerPort = Pick<
  UsageSettlementService,
  "prepareAttempt" | "finalizeAttempt" | "markAttemptOutcomeUnknown"
>;

type UsageOwnerOutcome<Value> =
  | Readonly<{ kind: "accepted" | "replayed"; value: Value }>
  | Readonly<{ kind: "conflict"; code: string }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "invalid_state"; code: string }>;

export type ModelGatewayInvocationResult =
  | Readonly<{
      kind: "succeeded" | "failed";
      invocationRef: string;
      attemptRef: string;
      responseBody: Uint8Array;
      replayed: boolean;
    }>
  | Readonly<{
      kind: "outcome_unknown";
      invocationRef: string;
      attemptRef: string;
      replayed: boolean;
    }>;

type ReferenceKind = "invocation" | "evidence" | "outbox";

export class ModelGatewayService {
  readonly #clock: () => Date;
  readonly #reference: (kind: ReferenceKind) => string;
  readonly #dispatchRecoveryAfterMs: number;
  readonly #instanceRef: string;
  readonly #providerHardTimeoutMs: number;
  readonly #maximumActive: number;
  readonly #maximumQueued: number;
  readonly #terminalizationRetryInitialMs: number;
  readonly #terminalizationRetryMaximumMs: number;
  readonly #shutdownController = new AbortController();
  readonly #dispatches = new Map<string, Readonly<{
    controller: AbortController;
    promise: Promise<void>;
  }>>();
  #maintenanceController: AbortController | null = null;
  #maintenancePromise: Promise<void> | null = null;

  constructor(private readonly dependencies: Readonly<{
    unitOfWork: ModelGatewayUnitOfWork;
    repository: ModelGatewayRepository;
    provider: ModelGatewayProviderPort;
    usageOwner: ModelGatewayUsageOwnerPort;
    clock?: () => Date;
    reference?: (kind: ReferenceKind) => string;
    dispatchRecoveryAfterMs?: number;
    streamingRepository: ModelGatewayStreamingRepository;
    instanceRef?: string;
    providerHardTimeoutMs?: number;
    maximumActive?: number;
    maximumQueued?: number;
    frameWaiter?: ModelGatewayFrameWaiter;
    terminalizationRetryInitialMs?: number;
    terminalizationRetryMaximumMs?: number;
  }>) {
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#reference = dependencies.reference ?? (() => randomUUID());
    this.#dispatchRecoveryAfterMs = dependencies.dispatchRecoveryAfterMs ?? 120_000;
    this.#instanceRef = dependencies.instanceRef ?? `model-gateway:${randomUUID()}`;
    this.#providerHardTimeoutMs = dependencies.providerHardTimeoutMs ?? 120_000;
    this.#maximumActive = dependencies.maximumActive ?? 64;
    this.#maximumQueued = dependencies.maximumQueued ?? 256;
    this.#terminalizationRetryInitialMs = dependencies.terminalizationRetryInitialMs ?? 100;
    this.#terminalizationRetryMaximumMs = dependencies.terminalizationRetryMaximumMs ?? 2_000;
    if (!Number.isInteger(this.#dispatchRecoveryAfterMs) ||
        this.#dispatchRecoveryAfterMs < 1_000 || this.#dispatchRecoveryAfterMs > 600_000) {
      throw new Error("MODEL_GATEWAY_DISPATCH_RECOVERY_WINDOW_INVALID");
    }
    reference(this.#instanceRef, "MODEL_GATEWAY_INSTANCE_REFERENCE_INVALID");
    if (!Number.isInteger(this.#providerHardTimeoutMs) || this.#providerHardTimeoutMs < 1_000 ||
        this.#providerHardTimeoutMs > 600_000 || !Number.isInteger(this.#maximumActive) ||
        this.#maximumActive < 1 || this.#maximumActive > 10_000 ||
        !Number.isInteger(this.#maximumQueued) || this.#maximumQueued < 1 ||
        this.#maximumQueued > 100_000) {
      throw new Error("MODEL_GATEWAY_STREAMING_LIMIT_INVALID");
    }
    if (!Number.isInteger(this.#terminalizationRetryInitialMs) ||
        this.#terminalizationRetryInitialMs < 1 || this.#terminalizationRetryInitialMs > 10_000 ||
        !Number.isInteger(this.#terminalizationRetryMaximumMs) ||
        this.#terminalizationRetryMaximumMs < this.#terminalizationRetryInitialMs ||
        this.#terminalizationRetryMaximumMs > 10_000) {
      throw new Error("MODEL_GATEWAY_TERMINALIZATION_RETRY_INVALID");
    }
  }

  async invoke(input: Readonly<{
    modelAuthorizationHandle: string;
    logicalCallRef: string;
    attemptRef: string;
    producerContext: string;
    producerGeneration: bigint;
    request: ModelGatewayRequest;
    signal: AbortSignal;
  }>): Promise<ModelGatewayInvocationResult> {
    return this.#invokeViaStream(input);
  }

  async *stream(input: Readonly<{
    modelAuthorizationHandle: string;
    logicalCallRef: string;
    attemptRef: string;
    producerContext: string;
    producerGeneration: bigint;
    request: ModelGatewayRequest;
    afterSequence: bigint;
    signal: AbortSignal;
  }>): AsyncIterable<ModelGatewayStreamFrame> {
    yield* this.#streamWithAttachment(input);
  }

  async *#streamWithAttachment(
    input: Readonly<{
      modelAuthorizationHandle: string;
      logicalCallRef: string;
      attemptRef: string;
      producerContext: string;
      producerGeneration: bigint;
      request: ModelGatewayRequest;
      afterSequence: bigint;
      signal: AbortSignal;
    }>,
    observeAttachment?: (attachment: ModelGatewayStreamAttachment) => void,
  ): AsyncIterable<ModelGatewayStreamFrame> {
    validateInvocationInput(input);
    if (input.afterSequence < 0n) throw new Error("MODEL_GATEWAY_STREAM_CURSOR_INVALID");
    const streaming = this.dependencies.streamingRepository;
    const prepared = await this.dependencies.unitOfWork.execute({
      operation: "prepare",
      modelAuthorizationHandle: input.modelAuthorizationHandle,
    }, async (transaction, authorization) => {
      const preparedProvider = this.dependencies.provider.prepare(
        input.request,
        authorization,
      );
      validatePreparedProviderRequest(preparedProvider);
      assertAuthorization(authorization, input, preparedProvider.gatewayModel, this.#now());
      const prior = await this.dependencies.repository.lockInvocation(transaction, {
        logicalCallRef: input.logicalCallRef,
      });
      if (prior !== null) {
        assertRecordAuthorization(prior, authorization);
        if (prior.attemptRef !== input.attemptRef || prior.producerContext !== input.producerContext ||
            prior.producerGeneration !== input.producerGeneration ||
            prior.requestDigest !== preparedProvider.requestDigest) {
          throw new Error("MODEL_GATEWAY_INVOCATION_IDENTITY_CONFLICT");
        }
        return Object.freeze({ kind: "existing" as const, record: prior, preparedProvider });
      }
      await streaming.reserveCapacity(transaction, {
        maximumActive: this.#maximumActive,
        maximumQueued: this.#maximumQueued,
      });
      const invocationRef = this.#reference("invocation");
      const usage = await this.dependencies.usageOwner.prepareAttempt(transaction, {
        siteId: authorization.siteId,
        authorizationSegmentRef: authorization.authorizationSegmentRef,
        executionManifestRef: authorization.executionManifestRef,
        producerKind: "model_gateway",
        producerContext: input.producerContext,
        producerGeneration: input.producerGeneration,
        attemptRef: input.attemptRef,
        logicalEffectRef: input.logicalCallRef,
        maximumDimensions: preparedProvider.maximumDimensions,
        businessOperationKey: `model-gateway:prepare:${invocationRef}`,
        requestDigest: commandDigest("prepare", {
          invocationRef,
          requestDigest: preparedProvider.requestDigest,
          attemptRef: input.attemptRef,
        }),
      });
      const attempt = requireUsageOutcome(usage, "MODEL_GATEWAY_USAGE_PREPARE");
      if (attempt.state !== "effect_committed") throw new Error("MODEL_GATEWAY_USAGE_PREPARE_RECEIPT_INVALID");
      const now = this.#now().toISOString();
      const record: ModelGatewayInvocationRecord = Object.freeze({
        siteId: authorization.siteId,
        invocationRef,
        modelAuthorizationHandle: input.modelAuthorizationHandle,
        executionManifestRef: authorization.executionManifestRef,
        authorizationSegmentRef: authorization.authorizationSegmentRef,
        logicalCallRef: input.logicalCallRef,
        attemptRef: input.attemptRef,
        producerContext: input.producerContext,
        producerGeneration: input.producerGeneration,
        requestDigest: preparedProvider.requestDigest,
        gatewayModel: preparedProvider.gatewayModel,
        maximumDimensions: Object.freeze([...preparedProvider.maximumDimensions]),
        attemptAuthorizationRef: attempt.attemptAuthorizationRef,
        fenceEpoch: attempt.fenceEpoch,
        state: "queued",
        responseBody: null,
        usageEvidence: null,
        evidenceRef: null,
        sourceDigest: null,
        ownerEvidenceRef: null,
        createdAt: now,
        updatedAt: now,
      });
      await streaming.persistAccepted(transaction, record, input.request);
      return Object.freeze({ kind: "created" as const, record, preparedProvider });
    });
    observeAttachment?.(Object.freeze({
      attachedToExistingInvocation: prepared.kind === "existing",
    }));

    let record = prepared.record;
    if (record.state === "dispatching" &&
        Date.parse(record.dispatchLeaseExpiresAt ?? record.updatedAt) <= this.#now().getTime()) {
      try {
        await this.#markOutcomeUnknown(record, `model-gateway-owner-expired:sha256:${commandDigest(
          "expired-owner", { invocationRef: record.invocationRef, requestDigest: record.requestDigest },
        )}`, expiredUnknownAuthority(record), true);
      } catch (cause) {
        if (!expiredObservationLost(cause)) throw cause;
      }
    } else if (record.state === "queued") {
      const claimed = await this.dependencies.unitOfWork.execute({
        operation: "claim",
        modelAuthorizationHandle: record.modelAuthorizationHandle,
      }, async (transaction, authorization) => {
        assertRecordAuthorization(record, authorization);
        return streaming.claimInvocation(transaction, {
          record,
          ownerInstanceRef: this.#instanceRef,
          leaseExpiresAt: new Date(this.#now().getTime() + this.#dispatchRecoveryAfterMs).toISOString(),
        });
      });
      if (claimed !== null) {
        record = claimed;
        this.#startDispatch(record, prepared.preparedProvider);
      }
    }

    let cursor = input.afterSequence;
    while (true) {
      if (input.signal.aborted) return;
      const frames = await this.dependencies.unitOfWork.execute({
        operation: "attach",
        modelAuthorizationHandle: record.modelAuthorizationHandle,
      }, async (transaction, authorization) => {
        assertRecordAuthorization(record, authorization);
        return streaming.listFrames(transaction, { record, afterSequence: cursor, limit: 128 });
      });
      for (const frame of frames) {
        if (frame.sequence <= cursor) throw new Error("MODEL_GATEWAY_STREAM_SEQUENCE_INVALID");
        cursor = frame.sequence;
        yield frame;
        if (terminalPayload(frame.payload)) return;
      }
      if (frames.length === 0) {
        if (this.dependencies.frameWaiter === undefined) {
          await abortableDelay(500, input.signal);
        } else {
          await this.dependencies.frameWaiter.waitForFrame(
            record.invocationRef,
            cursor,
            input.signal,
            2_000,
          );
        }
      }
    }
  }

  async shutdown(deadlineMs = 10_000): Promise<void> {
    if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000) {
      throw new Error("MODEL_GATEWAY_SHUTDOWN_DEADLINE_INVALID");
    }
    this.#shutdownController.abort("platform-shutdown");
    this.#maintenanceController?.abort("platform-shutdown");
    for (const dispatch of this.#dispatches.values()) dispatch.controller.abort("platform-shutdown");
    await Promise.race([
      Promise.allSettled([
        ...(this.#maintenancePromise === null ? [] : [this.#maintenancePromise]),
        ...[...this.#dispatches.values()].map(({ promise }) => promise),
      ]),
      new Promise<void>((resolveTimeout) => {
        const timer = setTimeout(resolveTimeout, deadlineMs);
        timer.unref();
      }),
    ]);
  }

  activeDispatchCount(): number { return this.#dispatches.size; }

  start(): void {
    if (this.#maintenancePromise !== null) return;
    const controller = new AbortController();
    this.#maintenanceController = controller;
    this.#maintenancePromise = this.#runMaintenance(controller.signal)
      .finally(() => {
        this.#maintenanceController = null;
        this.#maintenancePromise = null;
      });
  }

  async #runMaintenance(signal: AbortSignal): Promise<void> {
    let backoffMs = 100;
    while (!signal.aborted) {
      let candidates: readonly Readonly<{
        modelAuthorizationHandle: string;
        logicalCallRef: string;
      }>[] = [];
      try {
        candidates = await this.dependencies.unitOfWork.scanDispatchCandidates(32);
        for (const candidate of candidates) await this.#recoverCandidate(candidate);
        backoffMs = candidates.length === 0 ? Math.min(backoffMs * 2, 2_000) : 100;
      } catch {
        backoffMs = Math.min(backoffMs * 2, 2_000);
      }
      await abortableDelay(backoffMs, signal).catch(() => undefined);
    }
  }

  async #recoverCandidate(candidate: Readonly<{
    modelAuthorizationHandle: string;
    logicalCallRef: string;
  }>): Promise<void> {
    const loaded = await this.dependencies.unitOfWork.execute({
      operation: "attach",
      modelAuthorizationHandle: candidate.modelAuthorizationHandle,
    }, async (transaction, authorization) => {
      const record = await this.dependencies.repository.lockInvocation(transaction, {
        logicalCallRef: candidate.logicalCallRef,
      });
      if (record === null) return null;
      assertRecordAuthorization(record, authorization);
      if (record.state === "dispatching" &&
          Date.parse(record.dispatchLeaseExpiresAt ?? record.updatedAt) <= this.#now().getTime()) {
        return Object.freeze({ kind: "expired" as const, record });
      }
      if (record.state !== "queued") return null;
      const request = await this.dependencies.streamingRepository.loadRequest(transaction, record);
      return Object.freeze({ kind: "queued" as const, record, request, authorization });
    });
    if (loaded === null) return;
    if (loaded.kind === "expired") {
      await this.#markOutcomeUnknown(loaded.record, `model-gateway-owner-expired:sha256:${commandDigest(
        "expired-owner", {
          invocationRef: loaded.record.invocationRef,
          requestDigest: loaded.record.requestDigest,
        },
      )}`, expiredUnknownAuthority(loaded.record), true);
      return;
    }
    const prepared = this.dependencies.provider.prepare(loaded.request, loaded.authorization);
    validatePreparedProviderRequest(prepared);
    if (prepared.requestDigest !== loaded.record.requestDigest) {
      throw new Error("MODEL_GATEWAY_PERSISTED_REQUEST_DIGEST_INVALID");
    }
    const claimed = await this.dependencies.unitOfWork.execute({
      operation: "claim",
      modelAuthorizationHandle: loaded.record.modelAuthorizationHandle,
    }, async (transaction, authorization) => {
      assertRecordAuthorization(loaded.record, authorization);
      return this.dependencies.streamingRepository.claimInvocation(transaction, {
        record: loaded.record,
        ownerInstanceRef: this.#instanceRef,
        leaseExpiresAt: new Date(this.#now().getTime() + this.#dispatchRecoveryAfterMs).toISOString(),
      });
    });
    if (claimed !== null) this.#startDispatch(claimed, prepared);
  }

  async #invokeViaStream(input: Readonly<{
    modelAuthorizationHandle: string;
    logicalCallRef: string;
    attemptRef: string;
    producerContext: string;
    producerGeneration: bigint;
    request: ModelGatewayRequest;
    signal: AbortSignal;
  }>): Promise<ModelGatewayInvocationResult> {
    let accepted = false;
    let attachedToExistingInvocation = false;
    for await (const frame of this.#streamWithAttachment(
      { ...input, afterSequence: 0n },
      (attachment) => { attachedToExistingInvocation = attachment.attachedToExistingInvocation; },
    )) {
      if (frame.payload.kind === "accepted") {
        accepted = true;
        continue;
      }
      if (frame.payload.kind === "completed" || frame.payload.kind === "failed") {
        return Object.freeze({
          kind: frame.payload.kind === "completed" ? "succeeded" as const : "failed" as const,
          invocationRef: frame.invocationRef,
          attemptRef: frame.attemptRef,
          responseBody: new Uint8Array(frame.payload.responseBody),
          replayed: attachedToExistingInvocation,
        });
      }
      if (frame.payload.kind === "outcome_unknown") {
        return Object.freeze({
          kind: "outcome_unknown" as const,
          invocationRef: frame.invocationRef,
          attemptRef: frame.attemptRef,
          replayed: attachedToExistingInvocation,
        });
      }
    }
    if (input.signal.aborted && accepted) throw new Error("MODEL_GATEWAY_CALLER_DISCONNECTED");
    throw new Error("MODEL_GATEWAY_STREAM_TERMINAL_MISSING");
  }

  #startDispatch(record: ModelGatewayInvocationRecord, prepared: PreparedModelProviderRequest): void {
    if (this.#dispatches.has(record.invocationRef)) return;
    const controller = new AbortController();
    const promise = this.#runDispatch(record, prepared, controller)
      .catch(() => waitForAbort(this.#shutdownController.signal))
      .finally(() => {
        this.#dispatches.delete(record.invocationRef);
      });
    this.#dispatches.set(record.invocationRef, Object.freeze({ controller, promise }));
  }

  async #runDispatch(
    record: ModelGatewayInvocationRecord,
    prepared: PreparedModelProviderRequest,
    controller: AbortController,
  ): Promise<void> {
    const timeout = AbortSignal.timeout(this.#providerHardTimeoutMs);
    const signal = AbortSignal.any([
      controller.signal,
      timeout,
      this.#shutdownController.signal,
    ]);
    const heartbeatController = new AbortController();
    let heartbeatFailure: unknown;
    const heartbeat = this.#heartbeatLoop(record, heartbeatController.signal).catch((cause: unknown) => {
      heartbeatFailure = cause;
      controller.abort(cause);
    });
    let terminal: ModelGatewayProviderOutcome | null = null;
    try {
      try {
        const source = prepared.stream({ signal, providerOperationKey: record.invocationRef });
        for await (const event of coalesceProviderStream(source, signal)) {
          if (event.kind === "terminal") {
            terminal = event.outcome;
            break;
          }
          await this.#appendProviderFrame(record, event);
        }
      } catch (cause) {
        terminal = Object.freeze({
          kind: "outcome_unknown",
          ownerEvidenceRef: `provider-outcome:sha256:${errorDigest(cause)}`,
        });
      }
      if (heartbeatFailure !== undefined) {
        terminal = Object.freeze({
          kind: "outcome_unknown",
          ownerEvidenceRef: `provider-owner:sha256:${errorDigest(heartbeatFailure)}`,
        });
      }
      terminal ??= Object.freeze({
        kind: "outcome_unknown",
        ownerEvidenceRef: `provider-outcome:sha256:${commandDigest("terminal-missing", {
          invocationRef: record.invocationRef,
        })}`,
      });
      if (this.#shutdownController.signal.aborted) return;
      await this.#terminalizeProviderOutcome(record, terminal);
    } finally {
      heartbeatController.abort("dispatch-complete");
      await heartbeat;
    }
  }

  async #terminalizeProviderOutcome(
    record: ModelGatewayInvocationRecord,
    providerOutcome: ModelGatewayProviderOutcome,
  ): Promise<void> {
    let terminal = providerOutcome;
    let retryDelayMs = this.#terminalizationRetryInitialMs;
    while (!this.#shutdownController.signal.aborted) {
      try {
        if (terminal.kind === "outcome_unknown") {
          await this.#markOutcomeUnknown(
            record,
            terminal.ownerEvidenceRef,
            ownedUnknownAuthority(record, this.#instanceRef),
            true,
          );
        } else {
          await this.#finalize(record, terminal, "dispatching", true);
        }
        return;
      } catch {
        if (this.#shutdownController.signal.aborted) return;
        if (terminal.kind !== "outcome_unknown") {
          terminal = Object.freeze({
            kind: "outcome_unknown" as const,
            ownerEvidenceRef: terminalizationFailureEvidence(record, terminal),
          });
          continue;
        }
        try {
          await abortableDelay(retryDelayMs, this.#shutdownController.signal);
        } catch {
          return;
        }
        retryDelayMs = Math.min(retryDelayMs * 2, this.#terminalizationRetryMaximumMs);
      }
    }
  }

  async #heartbeatLoop(record: ModelGatewayInvocationRecord, signal: AbortSignal): Promise<void> {
    const intervalMs = Math.max(100, Math.min(10_000, Math.floor(this.#dispatchRecoveryAfterMs / 3)));
    while (!signal.aborted) {
      try { await abortableDelay(intervalMs, signal); } catch {
        if (signal.aborted) return;
        throw new Error("MODEL_GATEWAY_HEARTBEAT_WAIT_FAILED");
      }
      if (signal.aborted) return;
      await this.dependencies.unitOfWork.execute({
        operation: "frame",
        modelAuthorizationHandle: record.modelAuthorizationHandle,
      }, async (transaction, authorization) => {
        assertRecordAuthorization(record, authorization);
        await this.dependencies.streamingRepository.heartbeat(transaction, {
          record,
          ownerInstanceRef: this.#instanceRef,
          leaseExpiresAt: new Date(this.#now().getTime() + this.#dispatchRecoveryAfterMs).toISOString(),
        });
      });
    }
  }

  async #appendProviderFrame(
    record: ModelGatewayInvocationRecord,
    payload: ModelGatewayProviderDelta,
  ): Promise<void> {
    validateProviderDelta(payload);
    const streaming = this.dependencies.streamingRepository;
    await this.dependencies.unitOfWork.execute({
      operation: "frame",
      modelAuthorizationHandle: record.modelAuthorizationHandle,
    }, async (transaction, authorization) => {
      assertRecordAuthorization(record, authorization);
      await streaming.appendFrame(transaction, {
        record,
        ownerInstanceRef: this.#instanceRef,
        payload,
      });
    });
  }

  /**
   * Trusted provider reconciliation path. It never dispatches a second effect:
   * only a previously fenced outcome_unknown invocation can be finalized, and
   * it reuses that invocation's attempt authorization and advanced fence.
   */
  async reconcileOutcome(input: Readonly<{
    modelAuthorizationHandle: string;
    logicalCallRef: string;
    requestDigest: string;
    outcome: Extract<ModelGatewayProviderOutcome, { kind: "succeeded" | "failed" }>;
  }>): Promise<ModelGatewayInvocationResult> {
    reference(input.modelAuthorizationHandle, "MODEL_GATEWAY_AUTHORIZATION_HANDLE_INVALID");
    reference(input.logicalCallRef, "MODEL_GATEWAY_INVOCATION_REFERENCE_INVALID");
    digest(input.requestDigest, "MODEL_GATEWAY_REQUEST_DIGEST_INVALID");
    validateTerminalProviderOutcome(input.outcome);
    const prepared = await this.dependencies.unitOfWork.execute({
      operation: "finalize",
      modelAuthorizationHandle: input.modelAuthorizationHandle,
    }, async (transaction, authorization) => {
      const current = await this.dependencies.repository.lockInvocation(transaction, {
        logicalCallRef: input.logicalCallRef,
      });
      if (current === null) throw new Error("MODEL_GATEWAY_INVOCATION_NOT_FOUND");
      assertRecordAuthorization(current, authorization);
      if (current.requestDigest !== input.requestDigest) {
        throw new Error("MODEL_GATEWAY_INVOCATION_DIGEST_CONFLICT");
      }
      if (current.state === "succeeded" || current.state === "failed") {
        return Object.freeze({ kind: "replay" as const, result: result(current, true) });
      }
      if (current.state !== "outcome_unknown") {
        throw new Error("MODEL_GATEWAY_RECONCILIATION_STATE_INVALID");
      }
      return Object.freeze({ kind: "unknown" as const, record: current });
    });
    if (prepared.kind === "replay") return prepared.result;
    return this.#finalize(prepared.record, input.outcome, "outcome_unknown");
  }

  async #finalize(
    prepared: ModelGatewayInvocationRecord,
    outcome: Extract<ModelGatewayProviderOutcome, { kind: "succeeded" | "failed" }>,
    expectedPriorState: "dispatching" | "outcome_unknown",
    appendStreamTerminal = false,
  ): Promise<ModelGatewayInvocationResult> {
    validateTerminalProviderOutcome(outcome);
    return this.dependencies.unitOfWork.execute({
      operation: "finalize",
      modelAuthorizationHandle: prepared.modelAuthorizationHandle,
    }, async (transaction, authorization) => {
      assertRecordAuthorization(prepared, authorization);
      const current = await this.dependencies.repository.lockInvocation(transaction, {
        logicalCallRef: prepared.logicalCallRef,
      });
      if (current === null) throw new Error("MODEL_GATEWAY_INVOCATION_NOT_FOUND");
      if (current.state === "succeeded" || current.state === "failed") {
        return replay(current, prepared.requestDigest).result;
      }
      if (current.state !== expectedPriorState) {
        throw new Error("MODEL_GATEWAY_FINALIZE_STATE_CONFLICT");
      }
      const evidenceRef = this.#reference("evidence");
      const evidenceBase = {
        producerKind: "model_gateway" as const,
        producerContext: current.producerContext,
        producerGeneration: current.producerGeneration,
        attemptRef: current.attemptRef,
        logicalEffectRef: current.logicalCallRef,
        authorizationSegmentRef: current.authorizationSegmentRef,
        executionManifestRef: current.executionManifestRef,
        revision: 1n,
        correctionOfEvidenceRef: null,
        attemptOutcome: outcome.kind === "succeeded" ? "succeeded" as const : "failed_after_effect" as const,
        occurredAt: outcome.occurredAt,
        sourceDigest: outcome.sourceDigest,
      };
      const evidence = outcome.usage === null
        ? Object.freeze({
            ...evidenceBase,
            evidenceKind: "unavailable" as const,
            unavailableReason: "provider_usage_missing" as const,
            dimensions: Object.freeze([]) as readonly [],
          })
        : Object.freeze({
            ...evidenceBase,
            evidenceKind: "measured" as const,
            dimensions: Object.freeze([...outcome.usage]),
          });
      const finalized = await this.dependencies.usageOwner.finalizeAttempt(transaction, {
        siteId: current.siteId,
        attemptAuthorizationRef: current.attemptAuthorizationRef,
        expectedFenceEpoch: current.fenceEpoch,
        evidenceRef,
        businessOperationKey: `model-gateway:finalize:${current.invocationRef}`,
        requestDigest: commandDigest("finalize", {
          invocationRef: current.invocationRef,
          requestDigest: current.requestDigest,
          sourceDigest: outcome.sourceDigest,
        }),
        evidence,
      });
      const receipt = requireUsageOutcome(finalized, "MODEL_GATEWAY_USAGE_FINALIZE");
      if (receipt.evidenceRef !== evidenceRef || receipt.revision !== 1n) {
        throw new Error("MODEL_GATEWAY_USAGE_FINALIZE_RECEIPT_INVALID");
      }
      const terminal: ModelGatewayInvocationRecord = Object.freeze({
        ...current,
        state: outcome.kind,
        responseBody: new Uint8Array(outcome.responseBody),
        fenceEpoch: current.fenceEpoch + 1n,
        usageEvidence: Object.freeze({
          evidenceKind: evidence.evidenceKind,
          dimensions: Object.freeze([...evidence.dimensions]),
          attemptOutcome: evidence.attemptOutcome,
          occurredAt: evidence.occurredAt,
        }),
        evidenceRef,
        sourceDigest: outcome.sourceDigest,
        ownerEvidenceRef: null,
        updatedAt: this.#now().toISOString(),
      });
      await this.dependencies.repository.persistTerminal(transaction, terminal, expectedPriorState);
      if (appendStreamTerminal) {
        const streaming = this.dependencies.streamingRepository;
        if (streaming === undefined) throw new Error("MODEL_GATEWAY_STREAMING_NOT_CONFIGURED");
        await streaming.appendTerminalFrame(transaction, terminal, {
          kind: terminal.state === "succeeded" ? "completed" : "failed",
          responseBody: new Uint8Array(outcome.responseBody),
        });
      }
      return result(terminal, false);
    });
  }

  async #markOutcomeUnknown(
    prepared: ModelGatewayInvocationRecord,
    ownerEvidenceRef: string,
    authority: ModelGatewayOutcomeUnknownAuthority,
    appendStreamTerminal = false,
  ): Promise<ModelGatewayInvocationResult> {
    reference(ownerEvidenceRef, "MODEL_GATEWAY_PROVIDER_EVIDENCE_REF_INVALID");
    validateUnknownAuthority(authority);
    return this.dependencies.unitOfWork.execute({
      operation: "unknown",
      modelAuthorizationHandle: prepared.modelAuthorizationHandle,
    }, async (transaction, authorization) => {
      assertRecordAuthorization(prepared, authorization);
      const current = await this.dependencies.repository.lockInvocation(transaction, {
        logicalCallRef: prepared.logicalCallRef,
      });
      if (current === null) throw new Error("MODEL_GATEWAY_INVOCATION_NOT_FOUND");
      if (current.state !== "dispatching") return replay(current, prepared.requestDigest).result;
      assertUnknownAuthority(current, authority);
      const unknown = await this.dependencies.usageOwner.markAttemptOutcomeUnknown(transaction, {
        siteId: current.siteId,
        attemptAuthorizationRef: current.attemptAuthorizationRef,
        expectedFenceEpoch: current.fenceEpoch,
        businessOperationKey: `model-gateway:unknown:${current.invocationRef}`,
        requestDigest: commandDigest("unknown", {
          invocationRef: current.invocationRef,
          requestDigest: current.requestDigest,
          ownerEvidenceRef,
        }),
        ownerEvidenceRef,
      });
      const receipt = requireUsageOutcome(unknown, "MODEL_GATEWAY_USAGE_UNKNOWN");
      if (receipt.state !== "outcome_unknown" || receipt.fenceEpoch <= current.fenceEpoch) {
        throw new Error("MODEL_GATEWAY_USAGE_UNKNOWN_RECEIPT_INVALID");
      }
      const changed: ModelGatewayInvocationRecord = Object.freeze({
        ...current,
        state: "outcome_unknown",
        fenceEpoch: receipt.fenceEpoch,
        ownerEvidenceRef,
        updatedAt: this.#now().toISOString(),
      });
      await this.dependencies.repository.persistOutcomeUnknown(transaction, changed, authority);
      if (appendStreamTerminal) {
        const streaming = this.dependencies.streamingRepository;
        if (streaming === undefined) throw new Error("MODEL_GATEWAY_STREAMING_NOT_CONFIGURED");
        await streaming.appendTerminalFrame(transaction, changed, { kind: "outcome_unknown" });
      }
      return result(changed, false);
    });
  }

  #now(): Date {
    const value = this.#clock();
    if (!Number.isFinite(value.getTime())) throw new Error("MODEL_GATEWAY_CLOCK_INVALID");
    return value;
  }
}

function replay(
  prior: ModelGatewayInvocationRecord,
  requestDigest: string,
): Readonly<{ kind: "replay"; result: ModelGatewayInvocationResult }> {
  if (prior.requestDigest !== requestDigest) {
    throw new Error("MODEL_GATEWAY_INVOCATION_DIGEST_CONFLICT");
  }
  return Object.freeze({ kind: "replay", result: result(prior, true) });
}

function result(record: ModelGatewayInvocationRecord, replayed: boolean): ModelGatewayInvocationResult {
  if (record.state === "succeeded" || record.state === "failed") {
    if (record.responseBody === null) throw new Error("MODEL_GATEWAY_TERMINAL_PAYLOAD_MISSING");
    return Object.freeze({
      kind: record.state,
      invocationRef: record.invocationRef,
      attemptRef: record.attemptRef,
      responseBody: new Uint8Array(record.responseBody),
      replayed,
    });
  }
  return Object.freeze({
    kind: "outcome_unknown",
    invocationRef: record.invocationRef,
    attemptRef: record.attemptRef,
    replayed,
  });
}

function requireUsageOutcome<Value>(
  outcome: UsageOwnerOutcome<Value>,
  prefix: string,
): Value {
  if (outcome.kind === "accepted" || outcome.kind === "replayed") return outcome.value;
  throw new Error(`${prefix}_${outcome.kind.toUpperCase()}`);
}

function assertAuthorization(
  authorization: ModelInvocationAuthorization,
  input: Readonly<{ modelAuthorizationHandle: string }>,
  requestedModel: string,
  now: Date,
): void {
  if (
    authorization.modelAuthorizationHandle !== input.modelAuthorizationHandle
  ) throw new Error("MODEL_GATEWAY_AUTHORIZATION_SCOPE_MISMATCH");
  if (authorization.authorizedGatewayModel !== requestedModel) {
    throw new Error("MODEL_GATEWAY_ROUTE_NOT_AUTHORIZED");
  }
  if (Date.parse(authorization.expiresAt) <= now.getTime()) {
    throw new Error("MODEL_GATEWAY_AUTHORIZATION_EXPIRED");
  }
}

function assertRecordAuthorization(
  record: ModelGatewayInvocationRecord,
  authorization: ModelInvocationAuthorization,
): void {
  if (record.modelAuthorizationHandle !== authorization.modelAuthorizationHandle ||
      record.siteId !== authorization.siteId ||
      record.executionManifestRef !== authorization.executionManifestRef ||
      record.authorizationSegmentRef !== authorization.authorizationSegmentRef ||
      record.gatewayModel !== authorization.authorizedGatewayModel) {
    throw new Error("MODEL_GATEWAY_AUTHORIZATION_SCOPE_MISMATCH");
  }
}

function validateInvocationInput(input: Readonly<{
  modelAuthorizationHandle: string;
  logicalCallRef: string;
  attemptRef: string;
  producerContext: string;
  producerGeneration: bigint;
  signal: AbortSignal;
}>): void {
  [input.modelAuthorizationHandle, input.logicalCallRef,
    input.attemptRef, input.producerContext]
    .forEach((value) => reference(value, "MODEL_GATEWAY_INVOCATION_REFERENCE_INVALID"));
  if (input.producerGeneration <= 0n || !(input.signal instanceof AbortSignal)) {
    throw new Error("MODEL_GATEWAY_INVOCATION_INVALID");
  }
}

function validatePreparedProviderRequest(prepared: PreparedModelProviderRequest): void {
  reference(prepared.gatewayModel, "MODEL_GATEWAY_MODEL_INVALID");
  digest(prepared.requestDigest, "MODEL_GATEWAY_REQUEST_DIGEST_INVALID");
  if (prepared.maximumDimensions.length < 1 || prepared.maximumDimensions.length > 64) {
    throw new Error("MODEL_GATEWAY_MAXIMUM_DIMENSIONS_INVALID");
  }
  dimensions(prepared.maximumDimensions, "MODEL_GATEWAY_MAXIMUM_DIMENSIONS_INVALID");
}

function validateTerminalProviderOutcome(
  outcome: Extract<ModelGatewayProviderOutcome, { kind: "succeeded" | "failed" }>,
): void {
  if (outcome.responseBody.byteLength < 1 || outcome.responseBody.byteLength > 8 * 1024 * 1024) {
    throw new Error("MODEL_GATEWAY_PROVIDER_RESPONSE_INVALID");
  }
  digest(outcome.sourceDigest, "MODEL_GATEWAY_PROVIDER_SOURCE_DIGEST_INVALID");
  digest(outcome.responseDigest, "MODEL_GATEWAY_PROVIDER_RESPONSE_DIGEST_INVALID");
  if (createHash("sha256").update(outcome.responseBody).digest("hex") !== outcome.responseDigest) {
    throw new Error("MODEL_GATEWAY_PROVIDER_RESPONSE_DIGEST_INVALID");
  }
  if (!Number.isFinite(Date.parse(outcome.occurredAt))) {
    throw new Error("MODEL_GATEWAY_PROVIDER_OCCURRED_AT_INVALID");
  }
  if (outcome.usage !== null) dimensions(outcome.usage, "MODEL_GATEWAY_PROVIDER_USAGE_INVALID");
}

function dimensions(value: readonly ModelUsageDimension[], code: string): void {
  const keys = new Set<string>();
  for (const dimension of value) {
    reference(dimension.dimensionKey, code);
    reference(dimension.sourceUnit, code);
    if (dimension.quantity < 0n || keys.has(dimension.dimensionKey)) throw new Error(code);
    keys.add(dimension.dimensionKey);
  }
}

function reference(value: string, code: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value)) throw new Error(code);
}

function digest(value: string, code: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(code);
}

function commandDigest(kind: string, fields: Readonly<Record<string, string>>): string {
  const hash = createHash("sha256");
  hash.update(kind);
  for (const [key, value] of Object.entries(fields).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0)) {
    hash.update("\0").update(key).update("\0").update(value);
  }
  return hash.digest("hex");
}

function errorDigest(error: unknown): string {
  const safe = error instanceof Error ? error.name : typeof error;
  return createHash("sha256").update(safe).digest("hex");
}

function expiredObservationLost(error: unknown): boolean {
  return error instanceof Error && (
    error.message === "MODEL_GATEWAY_UNKNOWN_AUTHORITY_LOST" ||
    error.message === "MODEL_GATEWAY_UNKNOWN_CAS_LOST"
  );
}

function ownedUnknownAuthority(
  record: ModelGatewayInvocationRecord,
  ownerInstanceRef: string,
): ModelGatewayOutcomeUnknownAuthority {
  if (record.dispatchOwnerRef !== ownerInstanceRef || record.dispatchFence === undefined ||
      record.dispatchFence <= 0n) {
    throw new Error("MODEL_GATEWAY_UNKNOWN_AUTHORITY_INVALID");
  }
  return Object.freeze({
    kind: "owned",
    ownerInstanceRef,
    dispatchFence: record.dispatchFence,
  });
}

function expiredUnknownAuthority(
  record: ModelGatewayInvocationRecord,
): ModelGatewayOutcomeUnknownAuthority {
  if (record.dispatchOwnerRef === undefined || record.dispatchOwnerRef === null ||
      record.dispatchFence === undefined || record.dispatchFence <= 0n ||
      record.dispatchLeaseExpiresAt === undefined || record.dispatchLeaseExpiresAt === null ||
      !Number.isFinite(Date.parse(record.dispatchLeaseExpiresAt))) {
    throw new Error("MODEL_GATEWAY_UNKNOWN_AUTHORITY_INVALID");
  }
  return Object.freeze({
    kind: "expired",
    observedOwnerInstanceRef: record.dispatchOwnerRef,
    observedDispatchFence: record.dispatchFence,
    observedLeaseExpiresAt: record.dispatchLeaseExpiresAt,
  });
}

function validateUnknownAuthority(authority: ModelGatewayOutcomeUnknownAuthority): void {
  if (authority.kind === "owned") {
    reference(authority.ownerInstanceRef, "MODEL_GATEWAY_UNKNOWN_AUTHORITY_INVALID");
    if (authority.dispatchFence <= 0n) throw new Error("MODEL_GATEWAY_UNKNOWN_AUTHORITY_INVALID");
    return;
  }
  reference(authority.observedOwnerInstanceRef, "MODEL_GATEWAY_UNKNOWN_AUTHORITY_INVALID");
  if (authority.observedDispatchFence <= 0n ||
      !Number.isFinite(Date.parse(authority.observedLeaseExpiresAt))) {
    throw new Error("MODEL_GATEWAY_UNKNOWN_AUTHORITY_INVALID");
  }
}

function assertUnknownAuthority(
  current: ModelGatewayInvocationRecord,
  authority: ModelGatewayOutcomeUnknownAuthority,
): void {
  const leaseExpiresAt = current.dispatchLeaseExpiresAt;
  if (current.dispatchFence === undefined || leaseExpiresAt === undefined || leaseExpiresAt === null ||
      !Number.isFinite(Date.parse(leaseExpiresAt))) {
    throw new Error("MODEL_GATEWAY_UNKNOWN_AUTHORITY_LOST");
  }
  if (authority.kind === "owned") {
    if (current.dispatchOwnerRef !== authority.ownerInstanceRef ||
        current.dispatchFence !== authority.dispatchFence) {
      throw new Error("MODEL_GATEWAY_UNKNOWN_AUTHORITY_LOST");
    }
    return;
  }
  if (current.dispatchOwnerRef !== authority.observedOwnerInstanceRef ||
      current.dispatchFence !== authority.observedDispatchFence ||
      leaseExpiresAt !== authority.observedLeaseExpiresAt) {
    throw new Error("MODEL_GATEWAY_UNKNOWN_AUTHORITY_LOST");
  }
}

function terminalizationFailureEvidence(
  record: ModelGatewayInvocationRecord,
  outcome: Extract<ModelGatewayProviderOutcome, { kind: "succeeded" | "failed" }>,
): string {
  return `model-gateway-terminalization:sha256:${commandDigest("terminalization-failure", {
    invocationRef: record.invocationRef,
    requestDigest: record.requestDigest,
    outcomeKind: outcome.kind,
    sourceDigest: outcome.sourceDigest,
  })}`;
}

async function* coalesceProviderStream(
  source: AsyncIterable<ModelGatewayProviderStreamEvent>,
  signal: AbortSignal,
): AsyncIterable<ModelGatewayProviderStreamEvent> {
  const iterator = source[Symbol.asyncIterator]();
  let pending: Promise<IteratorResult<ModelGatewayProviderStreamEvent>> = iterator.next();
  let buffered: ModelGatewayProviderDelta | null = null;
  while (true) {
    if (signal.aborted) throw signal.reason;
    const next: IteratorResult<ModelGatewayProviderStreamEvent> | Readonly<{ timedOut: true }> = buffered === null
      ? await pending
      : await Promise.race([
          pending,
          abortableDelay(25, signal).then(() => Object.freeze({ timedOut: true as const })),
        ]);
    if ("timedOut" in next) {
      yield buffered as ModelGatewayProviderDelta;
      buffered = null;
      continue;
    }
    if (next.done) {
      if (buffered !== null) yield buffered;
      return;
    }
    pending = iterator.next();
    const event: ModelGatewayProviderStreamEvent = next.value;
    if (event.kind === "terminal") {
      if (buffered !== null) yield buffered;
      yield event;
      return;
    }
    validateProviderDelta(event);
    if (buffered === null) {
      buffered = event;
      continue;
    }
    const merged = mergeProviderDelta(buffered, event);
    if (merged === null) {
      yield buffered;
      buffered = event;
    } else {
      buffered = merged;
    }
  }
}

function mergeProviderDelta(
  left: ModelGatewayProviderDelta,
  right: ModelGatewayProviderDelta,
): ModelGatewayProviderDelta | null {
  if (left.kind === "content_delta" && right.kind === "content_delta") {
    const content = left.content + right.content;
    return Buffer.byteLength(content, "utf8") <= 16_384
      ? Object.freeze({ kind: "content_delta", content })
      : null;
  }
  if (left.kind === "reasoning_delta" && right.kind === "reasoning_delta") {
    const content = left.content + right.content;
    return Buffer.byteLength(content, "utf8") <= 16_384
      ? Object.freeze({ kind: "reasoning_delta", content })
      : null;
  }
  if (left.kind === "tool_call_delta" && right.kind === "tool_call_delta" &&
      left.toolIndex === right.toolIndex && right.id === undefined && right.name === undefined &&
      left.argumentsJsonFragment.byteLength + right.argumentsJsonFragment.byteLength <= 16_384) {
    const argumentsJsonFragment = new Uint8Array(
      left.argumentsJsonFragment.byteLength + right.argumentsJsonFragment.byteLength,
    );
    argumentsJsonFragment.set(left.argumentsJsonFragment);
    argumentsJsonFragment.set(right.argumentsJsonFragment, left.argumentsJsonFragment.byteLength);
    return Object.freeze({ ...left, argumentsJsonFragment });
  }
  return null;
}

function validateProviderDelta(delta: ModelGatewayProviderDelta): void {
  if (delta.kind === "content_delta" || delta.kind === "reasoning_delta") {
    const bytes = Buffer.byteLength(delta.content, "utf8");
    if (bytes < 1 || bytes > 16_384) throw new Error("MODEL_GATEWAY_PROVIDER_DELTA_INVALID");
    return;
  }
  if (!Number.isInteger(delta.toolIndex) || delta.toolIndex < 0 || delta.toolIndex > 127 ||
      delta.argumentsJsonFragment.byteLength > 16_384 ||
      (delta.id === undefined && delta.name === undefined && delta.argumentsJsonFragment.byteLength === 0)) {
    throw new Error("MODEL_GATEWAY_PROVIDER_DELTA_INVALID");
  }
  if (delta.id !== undefined) reference(delta.id, "MODEL_GATEWAY_PROVIDER_DELTA_INVALID");
  if (delta.name !== undefined && !/^[A-Za-z0-9_-]{1,128}$/u.test(delta.name)) {
    throw new Error("MODEL_GATEWAY_PROVIDER_DELTA_INVALID");
  }
}

function terminalPayload(payload: ModelGatewayStreamPayload): boolean {
  return payload.kind === "completed" || payload.kind === "failed" ||
    payload.kind === "outcome_unknown";
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolveDelay, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolveDelay();
    }, milliseconds);
    timer.unref();
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
