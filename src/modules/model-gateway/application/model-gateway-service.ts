import { createHash, randomUUID } from "node:crypto";
import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";
import type { UsageSettlementService } from "../../credit/application/usage-settlement-service.js";

export type ModelUsageDimension = Readonly<{
  dimensionKey: string;
  sourceUnit: string;
  quantity: bigint;
}>;

export type ModelGatewayRequest = Readonly<{
  protocol: "openai.chat.completions.v1";
  model: string;
  messages: readonly Readonly<{ role: "system" | "user" | "assistant"; content: string }>[];
  maxOutputTokens: number;
}>;

export type ModelInvocationAuthorization = Readonly<{
  modelAuthorizationHandle: string;
  siteId: string;
  executionManifestRef: string;
  authorizationSegmentRef: string;
  authorizedGatewayModel: string;
  expiresAt: string;
}>;

export type ModelGatewayProviderOutcome =
  | Readonly<{
      kind: "succeeded" | "failed";
      responseBody: Uint8Array;
      usage: readonly ModelUsageDimension[] | null;
      sourceDigest: string;
      occurredAt: string;
    }>
  | Readonly<{
      kind: "outcome_unknown";
      ownerEvidenceRef: string;
    }>;

export interface PreparedModelProviderRequest {
  readonly gatewayModel: string;
  readonly requestDigest: string;
  readonly maximumDimensions: readonly ModelUsageDimension[];
  invoke(input: Readonly<{
    signal: AbortSignal;
    providerOperationKey: string;
  }>): Promise<ModelGatewayProviderOutcome>;
}

export interface ModelGatewayProviderPort {
  prepare(request: ModelGatewayRequest): PreparedModelProviderRequest;
}

export type ModelGatewayInvocationState =
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
  createdAt: string;
  updatedAt: string;
}>;

export interface ModelGatewayRepository {
  lockInvocation(
    transaction: PlatformTransaction,
    input: Readonly<{ logicalCallRef: string }>,
  ): Promise<ModelGatewayInvocationRecord | null>;
  persistPrepared(transaction: PlatformTransaction, record: ModelGatewayInvocationRecord): Promise<void>;
  persistTerminal(transaction: PlatformTransaction, record: ModelGatewayInvocationRecord): Promise<void>;
  persistOutcomeUnknown(
    transaction: PlatformTransaction,
    record: ModelGatewayInvocationRecord,
  ): Promise<void>;
}

export interface ModelGatewayUnitOfWork {
  execute<Result>(
    scope: Readonly<{
      operation: "prepare" | "finalize" | "unknown";
      modelAuthorizationHandle: string;
    }>,
    work: (
      transaction: PlatformTransaction,
      authorization: ModelInvocationAuthorization,
    ) => Promise<Result>,
  ): Promise<Result>;
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

  constructor(private readonly dependencies: Readonly<{
    unitOfWork: ModelGatewayUnitOfWork;
    repository: ModelGatewayRepository;
    provider: ModelGatewayProviderPort;
    usageOwner: ModelGatewayUsageOwnerPort;
    clock?: () => Date;
    reference?: (kind: ReferenceKind) => string;
    dispatchRecoveryAfterMs?: number;
  }>) {
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#reference = dependencies.reference ?? (() => randomUUID());
    this.#dispatchRecoveryAfterMs = dependencies.dispatchRecoveryAfterMs ?? 120_000;
    if (!Number.isInteger(this.#dispatchRecoveryAfterMs) ||
        this.#dispatchRecoveryAfterMs < 1_000 || this.#dispatchRecoveryAfterMs > 600_000) {
      throw new Error("MODEL_GATEWAY_DISPATCH_RECOVERY_WINDOW_INVALID");
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
    validateInvocationInput(input);
    const preparedProvider = this.dependencies.provider.prepare(input.request);
    validatePreparedProviderRequest(preparedProvider);
    const prepared = await this.dependencies.unitOfWork.execute({
      operation: "prepare",
      modelAuthorizationHandle: input.modelAuthorizationHandle,
    }, async (transaction, authorization) => {
      assertAuthorization(authorization, input, preparedProvider.gatewayModel, this.#now());
      const prior = await this.dependencies.repository.lockInvocation(transaction, {
        logicalCallRef: input.logicalCallRef,
      });
      if (prior !== null) {
        assertRecordAuthorization(prior, authorization);
        if (prior.attemptRef !== input.attemptRef ||
            prior.producerContext !== input.producerContext ||
            prior.producerGeneration !== input.producerGeneration) {
          throw new Error("MODEL_GATEWAY_INVOCATION_IDENTITY_CONFLICT");
        }
        replay(prior, preparedProvider.requestDigest);
        if (prior.state === "dispatching" &&
            Date.parse(prior.updatedAt) <= this.#now().getTime() - this.#dispatchRecoveryAfterMs) {
          return Object.freeze({ kind: "recover_unknown" as const, record: prior });
        }
        return replay(prior, preparedProvider.requestDigest);
      }

      const invocationRef = this.#reference("invocation");
      const prepareDigest = commandDigest("prepare", {
        invocationRef,
        requestDigest: preparedProvider.requestDigest,
        attemptRef: input.attemptRef,
      });
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
        requestDigest: prepareDigest,
      });
      const attempt = requireUsageOutcome(usage, "MODEL_GATEWAY_USAGE_PREPARE");
      if (attempt.state !== "effect_committed") {
        throw new Error("MODEL_GATEWAY_USAGE_PREPARE_RECEIPT_INVALID");
      }
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
        state: "dispatching",
        responseBody: null,
        usageEvidence: null,
        evidenceRef: null,
        sourceDigest: null,
        ownerEvidenceRef: null,
        createdAt: now,
        updatedAt: now,
      });
      await this.dependencies.repository.persistPrepared(transaction, record);
      return Object.freeze({ kind: "prepared" as const, record });
    });
    if (prepared.kind === "replay") return prepared.result;
    if (prepared.kind === "recover_unknown") {
      return this.#markOutcomeUnknown(
        prepared.record,
        `model-gateway-recovery:sha256:${commandDigest("abandoned-dispatch", {
          invocationRef: prepared.record.invocationRef,
          requestDigest: prepared.record.requestDigest,
        })}`,
      );
    }

    let providerOutcome: ModelGatewayProviderOutcome;
    try {
      providerOutcome = await preparedProvider.invoke({
        signal: input.signal,
        providerOperationKey: prepared.record.invocationRef,
      });
    } catch (cause) {
      providerOutcome = Object.freeze({
        kind: "outcome_unknown",
        ownerEvidenceRef: `provider-outcome:sha256:${errorDigest(cause)}`,
      });
    }
    if (providerOutcome.kind === "outcome_unknown") {
      return this.#markOutcomeUnknown(prepared.record, providerOutcome.ownerEvidenceRef);
    }
    return this.#finalize(prepared.record, providerOutcome, "dispatching");
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
      await this.dependencies.repository.persistTerminal(transaction, terminal);
      return result(terminal, false);
    });
  }

  async #markOutcomeUnknown(
    prepared: ModelGatewayInvocationRecord,
    ownerEvidenceRef: string,
  ): Promise<ModelGatewayInvocationResult> {
    reference(ownerEvidenceRef, "MODEL_GATEWAY_PROVIDER_EVIDENCE_REF_INVALID");
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
      await this.dependencies.repository.persistOutcomeUnknown(transaction, changed);
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
  if (createHash("sha256").update(outcome.responseBody).digest("hex") !== outcome.sourceDigest) {
    throw new Error("MODEL_GATEWAY_PROVIDER_SOURCE_DIGEST_INVALID");
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
