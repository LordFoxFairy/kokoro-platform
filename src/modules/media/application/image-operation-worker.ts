import { createHash } from "node:crypto";
import type {
  ArtifactOwnerScope,
  ArtifactReadyReceipt,
  ArtifactStagedReceipt,
  ArtifactTrustDecision,
} from "../../artifact/index.js";
import { SingleFlightLeaseHeartbeat } from "../../../shared/outbox-inbox/lease-heartbeat.js";

export type MediaImageRequest = Readonly<{
  promptIntent: string;
  aspectRatio: "square_1_1" | "landscape_4_3" | "landscape_16_9" | "portrait_3_4" | "portrait_9_16";
  candidateCount: 1 | 2 | 3 | 4;
  outputFormat: "png" | "jpeg" | "webp";
  modelOptionRevisionRef: string;
}>;

export type MediaImageEffectAuthorization = Readonly<{
  callerAccess: MediaImageEphemeralCapability;
  modelOptionAuthorization: MediaImageEphemeralCapability;
  sourceGrants: readonly Readonly<{
    sourceVersionRef: string;
    purposeGrant: MediaImageEphemeralCapability;
  }>[];
}>;

export type MediaImageEphemeralCapability = Readonly<{
  handle: Uint8Array;
  handleDigest: string;
  expiresAt: string;
  bindingRef: string;
}>;

export type MediaImageLogicalOutputSlot = Readonly<{
  candidateOrdinal: number;
  candidateRef: string;
  stableOutputSlotRef: string;
}>;

export type MediaImageCreateEffectCommand = Readonly<{
  callerRequestFingerprint: string;
  createEffectDigest: string;
  definitionRoleRef: string;
  operationInputRevisionRef: string;
  operationInputRevisionDigest: string;
  logicalOutputSlots: readonly MediaImageLogicalOutputSlot[];
  effectBudgetCommitRef: string;
  effectBudgetCommitDigest: string;
  attemptOrdinal: 1;
  trustEffectAllowReceiptRef: string;
  trustEffectAllowReceiptDigest: string;
  modelOptionRevisionRef: string;
}>;

export type MediaImageCancelEffectCommand = Readonly<{
  cancelCommandRef: string;
  callerRequestFingerprint: string;
  cancelIntentReceiptRef: string;
}>;

export type MediaImageCanonicalEvidenceIdentity = Readonly<{
  ref: string;
  digest: string;
}>;

export type MediaImageEffectOutputEvidence = Readonly<{
  evidenceSequence: bigint;
  candidateOrdinal: number;
  candidateRef: string;
  stableOutputSlotRef: string;
  outputEvidenceRef: string;
  outputEvidenceDigest: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  declaredByteSize?: bigint | undefined;
}>;

/** Root owner view. Output facts deliberately live only on GetImageEffectEvidence. */
export type MediaImageEffectView = Readonly<{
  logicalInvocationRef: string;
  modelInvocationCommandRef: string;
  ownerVersion: bigint;
  currentAttemptOrdinal: number;
  state: "accepted" | "definitely_not_submitted" | "submitted" | "submission_unknown" | "running" |
    "succeeded" | "failed" | "cancel_requested" | "canceled" | "outcome_unknown";
  canonicalOutcomeEvidence?: MediaImageCanonicalEvidenceIdentity | undefined;
  usageEvidence?: MediaImageCanonicalEvidenceIdentity | undefined;
  observedAt: string;
}>;

export type MediaImageEffectReceiptKind = "create_committed" | "definitely_not_submitted" |
  "attempt_authorization_attached" | "cancel_intent_committed" | "rejected" | "outcome_unknown" |
  "output_access_issued";

/** Mirrors the Root owner-issued command receipt; Platform never derives a second receipt identity. */
export type MediaImageEffectCommandReceipt = Readonly<{
  receiptRef: string;
  receiptDigest: string;
  requestDigest: string;
  callerCommandRef: string;
  kind: MediaImageEffectReceiptKind;
  logicalInvocationRef?: string | undefined;
  attemptRef?: string | undefined;
  attemptOrdinal?: number | undefined;
  receiptVersion: bigint;
  recordedAt: string;
  error?: Readonly<{ code: string; safeMessage: string }> | undefined;
}>;

export type MediaImageEffectCommandResult = Readonly<{
  receipt: MediaImageEffectCommandReceipt;
  invocation?: MediaImageEffectView | undefined;
}>;

export type MediaImageEffectEvidenceFact =
  | Readonly<{
      evidenceSequence: bigint;
      kind: "outcome" | "usage";
      evidenceRef: string;
      evidenceDigest: string;
      recordedAt: string;
    }>
  | (MediaImageEffectOutputEvidence & Readonly<{
      kind: "output";
      evidenceRef: string;
      evidenceDigest: string;
      recordedAt: string;
    }>);

export type MediaImageEffectEvidencePage = Readonly<{
  invocation: MediaImageEffectView;
  evidenceFacts: readonly MediaImageEffectEvidenceFact[];
  nextEvidenceSequence: bigint;
  caughtUp: boolean;
}>;

/**
 * Typed Model Gateway image-effect boundary. Implementations are generated ConnectRPC clients.
 * Create response loss is recovered by commandRef; unknown effects are never blindly re-created.
 */
export interface MediaImageEffectPort {
  create(input: Readonly<{
    callerAccessHandle: Uint8Array;
    modelOptionAuthorizationHandle: Uint8Array;
    modelInvocationCommandRef: string;
    callerRequestFingerprint: string;
    definitionRoleRef: string;
    operationInputRevisionRef: string;
    operationInputRevisionDigest: string;
    sourceGrants: readonly Readonly<{
      sourceVersionRef: string;
      purposeGrantHandle: Uint8Array;
      purposeGrantHandleDigest: string;
    }>[];
    logicalOutputSlots: readonly MediaImageLogicalOutputSlot[];
    effectBudgetCommitRef: string;
    effectBudgetCommitDigest: string;
    attemptOrdinal: 1;
    trustEffectAllowReceiptRef: string;
    trustEffectAllowReceiptDigest: string;
    modelOptionRevisionRef: string;
    signal: AbortSignal;
  }>): Promise<MediaImageEffectCommandResult>;
  recoverByCommand(input: Readonly<{
    callerAccessHandle: Uint8Array;
    callerCommandRef: string;
    signal: AbortSignal;
  }>): Promise<MediaImageEffectCommandResult>;
  getByCommand(input: Readonly<{
    callerAccessHandle: Uint8Array;
    modelInvocationCommandRef: string;
    signal: AbortSignal;
  }>): Promise<MediaImageEffectView>;
  getEvidence(input: Readonly<{
    callerAccessHandle: Uint8Array;
    logicalInvocationRef: string;
    afterEvidenceSequence: bigint;
    limit: number;
    signal: AbortSignal;
  }>): Promise<MediaImageEffectEvidencePage>;
  requestCancel(input: Readonly<{
    callerAccessHandle: Uint8Array;
    cancelCommandRef: string;
    logicalInvocationRef: string;
    expectedInvocationVersion: bigint;
    callerRequestFingerprint: string;
    signal: AbortSignal;
  }>): Promise<MediaImageEffectCommandResult>;
}

export type MediaImageEffectErrorDisposition = "response_lost" | "canonical_failure";

export class MediaImageEffectError extends Error {
  readonly code: string;
  readonly disposition: MediaImageEffectErrorDisposition;

  constructor(input: Readonly<{ code: string; disposition: MediaImageEffectErrorDisposition; cause?: unknown }>) {
    errorCode(input.code);
    super(input.code, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "MediaImageEffectError";
    this.code = input.code;
    this.disposition = input.disposition;
  }
}

export type MediaImageArtifactCheckpoint = Readonly<{
  candidateOrdinal: number;
  stagedReceipt?: ArtifactStagedReceipt | undefined;
  trustDecision?: ArtifactTrustDecision | undefined;
  readyReceipt?: ArtifactReadyReceipt | undefined;
  finalizationReceiptRef?: string | undefined;
}>;

export type MediaImageSagaCheckpoint = Readonly<{
  effectState: "none" | "started" | "outcome_unknown" | "recorded";
  effectReceipt?: MediaImageEffectCommandReceipt | undefined;
  effectView?: MediaImageEffectView | undefined;
  cancelState: "none" | "started" | "outcome_unknown" | "recorded";
  cancelResult?: MediaImageEffectCommandResult | undefined;
  evidence: Readonly<{
    logicalInvocationRef?: string | undefined;
    nextEvidenceSequence: bigint;
    caughtUp: boolean;
    facts: readonly MediaImageEffectEvidenceFact[];
  }>;
  artifacts: readonly MediaImageArtifactCheckpoint[];
  usageEvidenceReceiptRef?: string | undefined;
  allocationReturnReceiptRef?: string | undefined;
  projectionReceiptRef?: string | undefined;
}>;

export type MediaImageWorkerTask = Readonly<{
  taskRef: string;
  leaseEpoch: bigint;
  leaseToken: string;
  operationRef: string;
  modelInvocationCommandRef: string;
  request: MediaImageRequest;
  createEffectCommand: MediaImageCreateEffectCommand;
  effectAuthorization: MediaImageEffectAuthorization;
  candidateRefs: readonly string[];
  stableOutputSlotRefs: readonly string[];
  artifactRefs: readonly string[];
  artifactVersionRefs: readonly string[];
  outputAccessCommandRefs: readonly string[];
  outputAccessRequestFingerprints: readonly string[];
  ownerScope: ArtifactOwnerScope;
  creditChildAllocationRef: string;
  cancelEffectCommand?: MediaImageCancelEffectCommand | undefined;
  checkpoint: MediaImageSagaCheckpoint;
}>;

export type MediaImageEffectPreparation =
  | Readonly<{ kind: "create" }>
  | Readonly<{ kind: "recover" }>
  | Readonly<{ kind: "resume"; result: MediaImageEffectCommandResult }>;

export interface MediaImageWorkerRepository {
  claim(input: Readonly<{ workerId: string; now: string; leaseMs: number }>): Promise<MediaImageWorkerTask | null>;
  renewLease(task: MediaImageWorkerTask, leaseMs: number): Promise<void>;
  prepareEffect(task: MediaImageWorkerTask, createEffectDigest: string): Promise<MediaImageEffectPreparation>;
  recordEffectResult(task: MediaImageWorkerTask, createEffectDigest: string, result: MediaImageEffectCommandResult): Promise<
    Readonly<{ lateCancellationObserved: boolean }>
  >;
  recordEffectView(task: MediaImageWorkerTask, createEffectDigest: string, view: MediaImageEffectView): Promise<
    Readonly<{ lateCancellationObserved: boolean }>
  >;
  recordEvidencePage(task: MediaImageWorkerTask, input: Readonly<{
    afterEvidenceSequence: bigint;
    page: MediaImageEffectEvidencePage;
  }>): Promise<
    MediaImageSagaCheckpoint["evidence"]
  >;
  prepareCancel(task: MediaImageWorkerTask, requestDigest: string): Promise<MediaImageEffectPreparation>;
  recordCancelResult(task: MediaImageWorkerTask, requestDigest: string,
    result: MediaImageEffectCommandResult): Promise<void>;
  recordCancelOutcomeUnknown(task: MediaImageWorkerTask, input: Readonly<{
    requestDigest: string;
    errorCode: string;
    observedAt: string;
  }>): Promise<void>;
  recordOutcomeUnknown(task: MediaImageWorkerTask, input: Readonly<{
    errorCode: string;
    observedAt: string;
  }>): Promise<void>;
  recordArtifactStaged(task: MediaImageWorkerTask, receipt: ArtifactStagedReceipt): Promise<void>;
  recordTrustDecision(task: MediaImageWorkerTask, input: Readonly<{
    artifactVersionRef: string;
    decision: ArtifactTrustDecision;
  }>): Promise<void>;
  recordArtifactReady(task: MediaImageWorkerTask, input: Readonly<{
    receipt: ArtifactReadyReceipt;
    finalizationReceiptRef: string;
  }>): Promise<void>;
  recordUsage(task: MediaImageWorkerTask, receiptRef: string): Promise<void>;
  recordAllocationReturn(task: MediaImageWorkerTask, receiptRef: string): Promise<void>;
  recordProjection(task: MediaImageWorkerTask, receiptRef: string): Promise<void>;
  complete(task: MediaImageWorkerTask, input: MediaImageTerminalClosure): Promise<void>;
  retryOrDeadLetter(task: MediaImageWorkerTask, input: Readonly<{
    errorCode: string;
    retryAt: string;
    failedAt: string;
  }>): Promise<"retry" | "dead_letter">;
  releaseOwnedLeases(input: Readonly<{
    workerId: string;
    reason: "shutdown" | "shutdown-deadline" | "stop-claim-failed";
  }>): Promise<void>;
}

/** Artifact owner ingress consumes only Root-issued output access and a bounded Gateway stream. */
export interface MediaImageArtifactPort {
  /** Generated adapter: IssueImageEffectOutputAccess -> Recover...ByCommand -> bounded ReadImageEffectOutput -> stage. */
  issueRecoverReadAndStageOutput(input: Readonly<{
    ownerScope: ArtifactOwnerScope;
    artifactRef: string;
    artifactVersionRef: string;
    callerAccessHandle: Uint8Array;
    outputAccessCommandRef: string;
    outputAccessRequestFingerprint: string;
    logicalInvocationRef: string;
    outputEvidenceRef: string;
    outputEvidenceDigest: string;
    expectedMediaType: MediaImageEffectOutputEvidence["mediaType"];
  }>, signal: AbortSignal): Promise<ArtifactStagedReceipt>;
  promote(input: Readonly<{
    stagedReceipt: ArtifactStagedReceipt;
    trustDecision: ArtifactTrustDecision;
  }>): Promise<ArtifactReadyReceipt>;
}

export interface ImageOutputTrustPort {
  evaluate(input: Readonly<{
    operationRef: string;
    artifactVersionRef: string;
    contentSha256: string;
    mediaType: string;
    byteSize: bigint;
  }>, signal: AbortSignal): Promise<ArtifactTrustDecision>;
}

export interface MediaImageUsagePort {
  recordAttempt(input: Readonly<{
    operationRef: string;
    modelInvocationCommandRef: string;
    logicalInvocationRef: string;
    canonicalOutcomeEvidence: MediaImageCanonicalEvidenceIdentity;
    usageEvidence: MediaImageCanonicalEvidenceIdentity;
    outputEvidence: readonly Readonly<{ ref: string; digest: string }>[];
  }>): Promise<Readonly<{ attemptUsageEvidenceReceiptRef: string }>>;
}

export interface MediaImageCreditSettlementPort {
  releaseChild(input: Readonly<{
    operationRef: string;
    childAllocationRef: string;
    cancelIntentReceiptRef: string;
    terminalReceiptRef: string;
  }>): Promise<Readonly<{ allocationReturnReceiptRef: string }>>;
  returnChild(input: Readonly<{
    operationRef: string;
    childAllocationRef: string;
    terminalReceiptRef: string;
    outcome: "completed" | "failed" | "canceled";
  }>): Promise<Readonly<{ allocationReturnReceiptRef: string }>>;
}

export interface MediaImageSessionProjectionPort {
  publish(input: Readonly<{
    ownerScope: ArtifactOwnerScope;
    operationRef: string;
    state: "completed" | "failed" | "canceled";
    artifactVersionRefs: readonly string[];
    terminalReceiptRef: string;
  }>, signal: AbortSignal): Promise<Readonly<{ projectionReceiptRef: string }>>;
}

/** Root-generated canonical receipt helpers. Production composition must fail closed while unavailable. */
export interface MediaImageReceiptCanonicalizerPort {
  artifactFinalization(receipt: ArtifactReadyReceipt): string;
  terminal(input: Readonly<{
    operationRef: string;
    state: "completed" | "failed" | "canceled";
    evidenceRefs: readonly string[];
  }>): string;
}

export type MediaImageTerminalClosure = Readonly<{
  state: "completed" | "failed" | "canceled";
  terminalReceiptRef: string;
  receipts: Readonly<{
    gatewayCommandReceiptRef?: string | undefined;
    gatewayCommandReceiptDigest?: string | undefined;
    canonicalOutcomeEvidenceRef?: string | undefined;
    canonicalOutcomeEvidenceDigest?: string | undefined;
    artifactFinalizationReceiptRefs: readonly string[];
    usageEvidenceReceiptRef?: string | undefined;
    effectBudgetCommitRef?: string | undefined;
    allocationReturnReceiptRef: string;
    projectionReceiptRef: string;
  }>;
  completedAt: string;
}>;

type WorkerCycleResult = "idle" | "completed" | "failed" | "canceled" | "reconciling" | "dead_letter";

export class ImageOperationWorker {
  readonly #dependencies: Readonly<{
    repository: MediaImageWorkerRepository;
    effect: MediaImageEffectPort;
    artifact: MediaImageArtifactPort;
    trust: ImageOutputTrustPort;
    usage: MediaImageUsagePort;
    credit: MediaImageCreditSettlementPort;
    projection: MediaImageSessionProjectionPort;
    receipts: MediaImageReceiptCanonicalizerPort;
    workerId: string;
    clock: () => Date;
    leaseMs: number;
    leaseHeartbeatMs: number;
    leaseRenewalTimeoutMs: number;
  }>;
  #claiming = true;
  #cycle: Promise<WorkerCycleResult> | undefined;

  constructor(input: Readonly<{
    repository: MediaImageWorkerRepository;
    effect: MediaImageEffectPort;
    artifact: MediaImageArtifactPort;
    trust: ImageOutputTrustPort;
    usage: MediaImageUsagePort;
    credit: MediaImageCreditSettlementPort;
    projection: MediaImageSessionProjectionPort;
    receipts: MediaImageReceiptCanonicalizerPort;
    workerId: string;
    clock?: () => Date;
    leaseMs?: number;
    leaseHeartbeatMs?: number;
    leaseRenewalTimeoutMs?: number;
  }>) {
    reference(input.workerId);
    const leaseMs = boundedInteger(input.leaseMs ?? 30_000, 100, 300_000, "MEDIA_WORKER_LEASE_INVALID");
    const leaseHeartbeatMs = boundedInteger(input.leaseHeartbeatMs ?? Math.floor(leaseMs / 3), 1, 100_000,
      "MEDIA_WORKER_HEARTBEAT_INVALID");
    const leaseRenewalTimeoutMs = boundedInteger(input.leaseRenewalTimeoutMs ?? Math.min(leaseHeartbeatMs, 5_000),
      1, 100_000, "MEDIA_WORKER_RENEWAL_TIMEOUT_INVALID");
    this.#dependencies = Object.freeze({ ...input, clock: input.clock ?? (() => new Date()),
      leaseMs, leaseHeartbeatMs, leaseRenewalTimeoutMs });
  }

  runOne(signal: AbortSignal): Promise<WorkerCycleResult> { return this.#runOne(signal, false); }

  runOneCycle(context: Readonly<{ signal: AbortSignal }> | AbortSignal): Promise<WorkerCycleResult> {
    const signal = context instanceof AbortSignal ? context : context.signal;
    if (this.#cycle !== undefined) return this.#cycle;
    const cycle = this.#runOne(signal, true).finally(() => {
      if (this.#cycle === cycle) this.#cycle = undefined;
    });
    this.#cycle = cycle;
    return cycle;
  }

  stopClaiming(): Promise<void> { this.#claiming = false; return Promise.resolve(); }

  returnLeases(reason: "shutdown" | "shutdown-deadline" | "stop-claim-failed"): Promise<void> {
    return this.#dependencies.repository.releaseOwnedLeases({ workerId: this.#dependencies.workerId, reason });
  }

  async #runOne(signal: AbortSignal, heartbeatEnabled: boolean): Promise<WorkerCycleResult> {
    if (!this.#claiming) return "idle";
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const now = this.#date();
    const task = await this.#dependencies.repository.claim({ workerId: this.#dependencies.workerId,
      now: now.toISOString(), leaseMs: this.#dependencies.leaseMs });
    if (task === null) return "idle";
    assertTask(task);
    const heartbeat = new SingleFlightLeaseHeartbeat(
      () => this.#dependencies.repository.renewLease(task, this.#dependencies.leaseMs),
      { intervalMs: this.#dependencies.leaseHeartbeatMs,
        renewalTimeoutMs: this.#dependencies.leaseRenewalTimeoutMs,
        timeoutCode: "MEDIA_WORKER_LEASE_RENEWAL_TIMEOUT" },
    );
    if (heartbeatEnabled) heartbeat.start();
    try {
      if (heartbeatEnabled) await heartbeat.assertOwned();
      if (task.cancelEffectCommand !== undefined && task.checkpoint.effectState === "none") {
        return await this.#cancelBeforeEffect(task, task.cancelEffectCommand.cancelIntentReceiptRef, signal);
      }
      return await this.#executeTask(task, AbortSignal.any([signal, heartbeat.signal]));
    } catch (error) {
      if (signal.aborted || heartbeat.lost) throw error;
      const code = workerErrorCode(error);
      if (error instanceof MediaImageEffectError && error.disposition === "response_lost") {
        await this.#dependencies.repository.recordOutcomeUnknown(task, {
          errorCode: code, observedAt: this.#date().toISOString(),
        });
      }
      const resolution = await this.#dependencies.repository.retryOrDeadLetter(task, {
        errorCode: code,
        retryAt: new Date(this.#date().getTime() + 1_000).toISOString(),
        failedAt: this.#date().toISOString(),
      });
      return resolution === "retry" ? "reconciling" : "dead_letter";
    } finally {
      await heartbeat.stop();
      wipeTaskAuthority(task);
    }
  }

  async #executeTask(task: MediaImageWorkerTask, signal: AbortSignal): Promise<"completed" | "failed" | "canceled"> {
    const createEffectDigest = task.createEffectCommand.createEffectDigest;
    let result = await this.#resolveEffect(task, createEffectDigest, signal);
    let view = await this.#resolveOwnerView(task, createEffectDigest, result, signal);
    if (task.cancelEffectCommand !== undefined && !["succeeded", "failed", "canceled"].includes(view.state)) {
      result = await this.#resolveCancel(task, view, signal);
      assertEffectResult(task, result, task.cancelEffectCommand.cancelCommandRef,
        task.cancelEffectCommand.callerRequestFingerprint);
      view = await this.#resolveOwnerView(task, createEffectDigest, result, signal);
    }
    if (view.state === "failed" || view.state === "canceled") {
      return this.#closeGatewayTerminal(task, task.checkpoint.cancelResult?.receipt ?? result.receipt, view, signal);
    }
    if (view.state !== "succeeded") throw new MediaImageEffectError({
      code: "MODEL_GATEWAY_IMAGE_EFFECT_NOT_TERMINAL", disposition: "canonical_failure" });

    const evidence = await this.#collectTerminalEvidence(task, view, signal);
    const outputs = terminalOutputEvidence(task, view, evidence.facts);
    const checkpoints = new Map(task.checkpoint.artifacts.map((value) => [value.candidateOrdinal, value]));
    const finalizationReceiptRefs: string[] = [];
    for (const output of outputs) {
      const ordinal = output.candidateOrdinal;
      const checkpoint = checkpoints.get(ordinal);
      const artifactVersionRef = task.artifactVersionRefs[ordinal - 1]!;
      const artifactRef = task.artifactRefs[ordinal - 1]!;
      const staged = checkpoint?.stagedReceipt ??
        await this.#dependencies.artifact.issueRecoverReadAndStageOutput({
        ownerScope: task.ownerScope, artifactRef, artifactVersionRef,
        callerAccessHandle: task.effectAuthorization.callerAccess.handle,
        outputAccessCommandRef: task.outputAccessCommandRefs[ordinal - 1]!,
        outputAccessRequestFingerprint: task.outputAccessRequestFingerprints[ordinal - 1]!,
        logicalInvocationRef: view.logicalInvocationRef,
        outputEvidenceRef: output.outputEvidenceRef,
        outputEvidenceDigest: output.outputEvidenceDigest,
        expectedMediaType: output.mediaType,
      }, signal);
      if (checkpoint?.stagedReceipt === undefined) await this.#dependencies.repository.recordArtifactStaged(task, staged);
      const trustDecision = checkpoint?.trustDecision ?? await this.#dependencies.trust.evaluate({
        operationRef: task.operationRef, artifactVersionRef, contentSha256: staged.contentSha256,
        mediaType: staged.mediaType, byteSize: staged.byteSize,
      }, signal);
      if (checkpoint?.trustDecision === undefined) {
        await this.#dependencies.repository.recordTrustDecision(task, { artifactVersionRef, decision: trustDecision });
      }
      const ready = checkpoint?.readyReceipt ?? await this.#dependencies.artifact.promote({
        stagedReceipt: staged, trustDecision,
      });
      const finalizationRef = checkpoint?.finalizationReceiptRef ??
        this.#dependencies.receipts.artifactFinalization(ready);
      if (checkpoint?.readyReceipt === undefined) {
        await this.#dependencies.repository.recordArtifactReady(task, { receipt: ready,
          finalizationReceiptRef: finalizationRef });
      }
      finalizationReceiptRefs.push(finalizationRef);
    }

    const canonicalOutcomeEvidence = requiredEvidence(view.canonicalOutcomeEvidence,
      "MEDIA_SUCCEEDED_OUTCOME_EVIDENCE_REQUIRED");
    const usageEvidence = requiredEvidence(view.usageEvidence, "MEDIA_SUCCEEDED_USAGE_EVIDENCE_REQUIRED");
    const usageReceiptRef = task.checkpoint.usageEvidenceReceiptRef ??
      (await this.#dependencies.usage.recordAttempt({ operationRef: task.operationRef,
        modelInvocationCommandRef: task.modelInvocationCommandRef,
        logicalInvocationRef: view.logicalInvocationRef,
        canonicalOutcomeEvidence,
        usageEvidence,
        outputEvidence: outputs.map((output) => Object.freeze({
          ref: output.outputEvidenceRef, digest: output.outputEvidenceDigest,
        })),
      })).attemptUsageEvidenceReceiptRef;
    if (task.checkpoint.usageEvidenceReceiptRef === undefined) {
      await this.#dependencies.repository.recordUsage(task, usageReceiptRef);
    }
    const terminalReceiptRef = this.#dependencies.receipts.terminal({ operationRef: task.operationRef,
      state: "completed", evidenceRefs: [result.receipt.receiptRef, canonicalOutcomeEvidence.ref,
        usageEvidence.ref, ...outputs.map((output) => output.outputEvidenceRef),
        ...finalizationReceiptRefs, usageReceiptRef, task.createEffectCommand.effectBudgetCommitRef] });
    const allocationReturnReceiptRef = task.checkpoint.allocationReturnReceiptRef ??
      (await this.#dependencies.credit.returnChild({ operationRef: task.operationRef,
        childAllocationRef: task.creditChildAllocationRef, terminalReceiptRef,
        outcome: "completed" })).allocationReturnReceiptRef;
    if (task.checkpoint.allocationReturnReceiptRef === undefined) {
      await this.#dependencies.repository.recordAllocationReturn(task, allocationReturnReceiptRef);
    }
    const projectionReceiptRef = task.checkpoint.projectionReceiptRef ??
      (await this.#dependencies.projection.publish({ ownerScope: task.ownerScope,
        operationRef: task.operationRef, state: "completed", artifactVersionRefs: task.artifactVersionRefs,
        terminalReceiptRef }, signal)).projectionReceiptRef;
    if (task.checkpoint.projectionReceiptRef === undefined) {
      await this.#dependencies.repository.recordProjection(task, projectionReceiptRef);
    }
    await this.#dependencies.repository.complete(task, Object.freeze({ state: "completed" as const,
      terminalReceiptRef, receipts: Object.freeze({ gatewayCommandReceiptRef: result.receipt.receiptRef,
        gatewayCommandReceiptDigest: result.receipt.receiptDigest,
        canonicalOutcomeEvidenceRef: canonicalOutcomeEvidence.ref,
        canonicalOutcomeEvidenceDigest: canonicalOutcomeEvidence.digest,
        artifactFinalizationReceiptRefs: Object.freeze(finalizationReceiptRefs),
        usageEvidenceReceiptRef: usageReceiptRef,
        effectBudgetCommitRef: task.createEffectCommand.effectBudgetCommitRef,
        allocationReturnReceiptRef, projectionReceiptRef }), completedAt: this.#date().toISOString() }));
    return "completed";
  }

  async #closeGatewayTerminal(
    task: MediaImageWorkerTask,
    commandReceipt: MediaImageEffectCommandReceipt,
    view: MediaImageEffectView,
    signal: AbortSignal,
  ): Promise<"failed" | "canceled"> {
    if (view.state !== "failed" && view.state !== "canceled") throw new Error("MEDIA_TERMINAL_STATE_INVALID");
    const canonicalOutcomeEvidence = requiredEvidence(view.canonicalOutcomeEvidence,
      "MEDIA_TERMINAL_OUTCOME_EVIDENCE_REQUIRED");
    const usageEvidence = view.usageEvidence;
    const usageReceiptRef = task.checkpoint.usageEvidenceReceiptRef ??
      (usageEvidence === undefined ? undefined :
        (await this.#dependencies.usage.recordAttempt({ operationRef: task.operationRef,
          modelInvocationCommandRef: task.modelInvocationCommandRef,
          logicalInvocationRef: view.logicalInvocationRef,
          canonicalOutcomeEvidence,
          usageEvidence,
          outputEvidence: [],
        })).attemptUsageEvidenceReceiptRef);
    if (usageReceiptRef !== undefined && task.checkpoint.usageEvidenceReceiptRef === undefined) {
      await this.#dependencies.repository.recordUsage(task, usageReceiptRef);
    }
    if (view.state === "failed" && usageReceiptRef === undefined) {
      throw new Error("MEDIA_FAILED_USAGE_EVIDENCE_REQUIRED");
    }
    const evidenceRefs = [commandReceipt.receiptRef, canonicalOutcomeEvidence.ref,
      task.createEffectCommand.effectBudgetCommitRef,
      ...(usageEvidence === undefined ? [] : [usageEvidence.ref]),
      ...(usageReceiptRef === undefined ? [] : [usageReceiptRef])];
    const terminalReceiptRef = this.#dependencies.receipts.terminal({ operationRef: task.operationRef,
      state: view.state, evidenceRefs });
    const allocationReturnReceiptRef = task.checkpoint.allocationReturnReceiptRef ??
      (await this.#dependencies.credit.returnChild({ operationRef: task.operationRef,
        childAllocationRef: task.creditChildAllocationRef, terminalReceiptRef,
        outcome: view.state })).allocationReturnReceiptRef;
    if (task.checkpoint.allocationReturnReceiptRef === undefined) {
      await this.#dependencies.repository.recordAllocationReturn(task, allocationReturnReceiptRef);
    }
    const projectionReceiptRef = task.checkpoint.projectionReceiptRef ??
      (await this.#dependencies.projection.publish({ ownerScope: task.ownerScope,
        operationRef: task.operationRef, state: view.state, artifactVersionRefs: [], terminalReceiptRef },
      signal)).projectionReceiptRef;
    if (task.checkpoint.projectionReceiptRef === undefined) {
      await this.#dependencies.repository.recordProjection(task, projectionReceiptRef);
    }
    await this.#dependencies.repository.complete(task, Object.freeze({ state: view.state,
      terminalReceiptRef, receipts: Object.freeze({ gatewayCommandReceiptRef: commandReceipt.receiptRef,
        gatewayCommandReceiptDigest: commandReceipt.receiptDigest,
        canonicalOutcomeEvidenceRef: canonicalOutcomeEvidence.ref,
        canonicalOutcomeEvidenceDigest: canonicalOutcomeEvidence.digest,
        artifactFinalizationReceiptRefs: Object.freeze([]),
        ...(usageReceiptRef === undefined ? {} : { usageEvidenceReceiptRef: usageReceiptRef }),
        effectBudgetCommitRef: task.createEffectCommand.effectBudgetCommitRef,
        allocationReturnReceiptRef, projectionReceiptRef }), completedAt: this.#date().toISOString() }));
    return view.state;
  }

  async #resolveEffect(
    task: MediaImageWorkerTask,
    createEffectDigest: string,
    signal: AbortSignal,
  ): Promise<MediaImageEffectCommandResult> {
    const prepared = await this.#dependencies.repository.prepareEffect(task, createEffectDigest);
    if (prepared.kind === "resume") return prepared.result;
    const command = task.createEffectCommand;
    const result = prepared.kind === "create"
      ? await this.#dependencies.effect.create({
          callerAccessHandle: task.effectAuthorization.callerAccess.handle,
          modelOptionAuthorizationHandle: task.effectAuthorization.modelOptionAuthorization.handle,
          modelInvocationCommandRef: task.modelInvocationCommandRef,
          callerRequestFingerprint: command.callerRequestFingerprint,
          definitionRoleRef: command.definitionRoleRef,
          operationInputRevisionRef: command.operationInputRevisionRef,
          operationInputRevisionDigest: command.operationInputRevisionDigest,
          sourceGrants: task.effectAuthorization.sourceGrants.map((grant) => Object.freeze({
            sourceVersionRef: grant.sourceVersionRef,
            purposeGrantHandle: grant.purposeGrant.handle,
            purposeGrantHandleDigest: grant.purposeGrant.handleDigest,
          })),
          logicalOutputSlots: command.logicalOutputSlots,
          effectBudgetCommitRef: command.effectBudgetCommitRef,
          effectBudgetCommitDigest: command.effectBudgetCommitDigest,
          attemptOrdinal: command.attemptOrdinal,
          trustEffectAllowReceiptRef: command.trustEffectAllowReceiptRef,
          trustEffectAllowReceiptDigest: command.trustEffectAllowReceiptDigest,
          modelOptionRevisionRef: command.modelOptionRevisionRef,
          signal,
        })
      : await this.#dependencies.effect.recoverByCommand({
          callerAccessHandle: task.effectAuthorization.callerAccess.handle,
          callerCommandRef: task.modelInvocationCommandRef,
          signal,
        });
    assertEffectResult(task, result, task.modelInvocationCommandRef, createEffectDigest);
    await this.#dependencies.repository.recordEffectResult(task, createEffectDigest, result);
    return result;
  }

  async #resolveOwnerView(
    task: MediaImageWorkerTask,
    createEffectDigest: string,
    result: MediaImageEffectCommandResult,
    signal: AbortSignal,
  ): Promise<MediaImageEffectView> {
    if (result.receipt.kind === "definitely_not_submitted" || result.invocation?.state === "definitely_not_submitted") {
      throw new Error("MEDIA_NEXT_ATTEMPT_AUTHORIZATION_REQUIRED");
    }
    if (result.receipt.kind === "rejected") throw new Error("MODEL_GATEWAY_IMAGE_EFFECT_REJECTED");
    let view = result.invocation;
    if (view === undefined || !["succeeded", "failed", "canceled"].includes(view.state)) {
      view = await this.#dependencies.effect.getByCommand({
        callerAccessHandle: task.effectAuthorization.callerAccess.handle,
        modelInvocationCommandRef: task.modelInvocationCommandRef,
        signal,
      });
      assertEffectView(task, view);
      if (result.invocation !== undefined) assertOwnerViewProgression(result.invocation, view);
      await this.#dependencies.repository.recordEffectView(task, createEffectDigest, view);
    }
    return view;
  }

  async #collectTerminalEvidence(
    task: MediaImageWorkerTask,
    terminalView: MediaImageEffectView,
    signal: AbortSignal,
  ): Promise<MediaImageSagaCheckpoint["evidence"]> {
    let evidence = task.checkpoint.evidence;
    if (evidence.logicalInvocationRef !== undefined &&
        evidence.logicalInvocationRef !== terminalView.logicalInvocationRef) {
      throw new Error("MEDIA_GATEWAY_EVIDENCE_INVOCATION_CONFLICT");
    }
    for (let pageCount = 0; !evidence.caughtUp; pageCount += 1) {
      if (pageCount >= 1_024) throw new Error("MEDIA_GATEWAY_EVIDENCE_PAGE_LIMIT_EXCEEDED");
      const page = await this.#dependencies.effect.getEvidence({
        callerAccessHandle: task.effectAuthorization.callerAccess.handle,
        logicalInvocationRef: terminalView.logicalInvocationRef,
        afterEvidenceSequence: evidence.nextEvidenceSequence,
        limit: 64,
        signal,
      });
      assertEvidencePage(task, terminalView, evidence, page);
      const recorded = await this.#dependencies.repository.recordEvidencePage(task, {
        afterEvidenceSequence: evidence.nextEvidenceSequence,
        page,
      });
      if (recorded.logicalInvocationRef !== terminalView.logicalInvocationRef ||
          recorded.nextEvidenceSequence !== page.nextEvidenceSequence || recorded.caughtUp !== page.caughtUp ||
          recorded.facts.length !== evidence.facts.length + page.evidenceFacts.length) {
        throw new Error("MEDIA_GATEWAY_EVIDENCE_CHECKPOINT_INVALID");
      }
      evidence = recorded;
    }
    assertTerminalEvidenceIdentity(terminalView, evidence.facts);
    return evidence;
  }

  async #resolveCancel(
    task: MediaImageWorkerTask,
    view: MediaImageEffectView,
    signal: AbortSignal,
  ): Promise<MediaImageEffectCommandResult> {
    const command = task.cancelEffectCommand;
    if (command === undefined) throw new Error("MEDIA_CANCEL_COMMAND_MISSING");
    const prepared = await this.#dependencies.repository.prepareCancel(task, command.callerRequestFingerprint);
    if (prepared.kind === "resume") return prepared.result;
    let result: MediaImageEffectCommandResult;
    try {
      result = prepared.kind === "recover"
        ? await this.#dependencies.effect.recoverByCommand({
            callerAccessHandle: task.effectAuthorization.callerAccess.handle,
            callerCommandRef: command.cancelCommandRef,
            signal,
          })
        : await this.#dependencies.effect.requestCancel({
            callerAccessHandle: task.effectAuthorization.callerAccess.handle,
            cancelCommandRef: command.cancelCommandRef,
            logicalInvocationRef: view.logicalInvocationRef,
            expectedInvocationVersion: view.ownerVersion,
            callerRequestFingerprint: command.callerRequestFingerprint,
            signal,
          });
    } catch (error) {
      if (error instanceof MediaImageEffectError && error.disposition === "response_lost") {
        await this.#dependencies.repository.recordCancelOutcomeUnknown(task, {
          requestDigest: command.callerRequestFingerprint,
          errorCode: error.code,
          observedAt: this.#date().toISOString(),
        });
        throw new MediaImageEffectError({ code: error.code, disposition: "canonical_failure", cause: error });
      }
      throw error;
    }
    assertEffectResult(task, result, command.cancelCommandRef, command.callerRequestFingerprint);
    if (result.receipt.logicalInvocationRef !== view.logicalInvocationRef ||
        (result.invocation !== undefined && result.invocation.logicalInvocationRef !== view.logicalInvocationRef)) {
      throw new Error("MEDIA_CANCEL_INVOCATION_CONFLICT");
    }
    await this.#dependencies.repository.recordCancelResult(task, command.callerRequestFingerprint, result);
    return result;
  }

  async #cancelBeforeEffect(
    task: MediaImageWorkerTask,
    cancelIntentReceiptRef: string,
    signal: AbortSignal,
  ): Promise<"canceled"> {
    const terminalReceiptRef = this.#dependencies.receipts.terminal({ operationRef: task.operationRef,
      state: "canceled", evidenceRefs: [cancelIntentReceiptRef] });
    const allocationReturnReceiptRef = task.checkpoint.allocationReturnReceiptRef ??
      (await this.#dependencies.credit.releaseChild({ operationRef: task.operationRef,
        childAllocationRef: task.creditChildAllocationRef, cancelIntentReceiptRef,
        terminalReceiptRef })).allocationReturnReceiptRef;
    if (task.checkpoint.allocationReturnReceiptRef === undefined) {
      await this.#dependencies.repository.recordAllocationReturn(task, allocationReturnReceiptRef);
    }
    const projectionReceiptRef = task.checkpoint.projectionReceiptRef ??
      (await this.#dependencies.projection.publish({ ownerScope: task.ownerScope,
        operationRef: task.operationRef, state: "canceled", artifactVersionRefs: [], terminalReceiptRef },
      signal)).projectionReceiptRef;
    if (task.checkpoint.projectionReceiptRef === undefined) {
      await this.#dependencies.repository.recordProjection(task, projectionReceiptRef);
    }
    await this.#dependencies.repository.complete(task, Object.freeze({ state: "canceled" as const,
      terminalReceiptRef, receipts: Object.freeze({ artifactFinalizationReceiptRefs: Object.freeze([]),
        allocationReturnReceiptRef, projectionReceiptRef }), completedAt: this.#date().toISOString() }));
    return "canceled";
  }

  #date(): Date {
    const value = this.#dependencies.clock();
    if (!Number.isFinite(value.getTime())) throw new Error("MEDIA_WORKER_CLOCK_INVALID");
    return value;
  }
}

/** Deterministic owner-state adapter for tests/local development only. */
export class InMemoryMediaImageWorkerRepository implements MediaImageWorkerRepository {
  readonly developmentOnly = true as const;
  readonly #task: Omit<MediaImageWorkerTask, "leaseEpoch" | "leaseToken" | "checkpoint">;
  readonly #events: string[];
  #claimed = false;
  #cancelEffectCommand: MediaImageCancelEffectCommand | undefined;
  #operationState: "queued" | "reconciling" | "completed" | "canceled" = "queued";
  #outboxState: "pending" | "leased" | "completed" | "dead_letter" = "pending";
  #attemptCount = 0;
  #deadLetterCode: string | undefined;
  readonly #maxAttempts: number;
  #terminal: MediaImageTerminalClosure | undefined;
  #checkpoint: MediaImageSagaCheckpoint;

  constructor(
    task: Omit<MediaImageWorkerTask, "leaseEpoch" | "leaseToken" | "checkpoint"> =
      InMemoryMediaImageWorkerRepository.exampleTask(),
    events: string[] = [],
    checkpoint: MediaImageSagaCheckpoint = emptyCheckpoint(task.request.candidateCount),
    options: Readonly<{ maxAttempts?: number }> = {},
  ) {
    this.#task = task;
    this.#events = events;
    this.#checkpoint = checkpoint;
    this.#maxAttempts = options.maxAttempts ?? 10;
  }

  static exampleTask(): Omit<MediaImageWorkerTask, "leaseEpoch" | "leaseToken" | "checkpoint"> {
    return Object.freeze({ operationRef: "media-operation:example", taskRef: "media-task:example",
      modelInvocationCommandRef: "model-invocation-command:example",
      request: Object.freeze({ promptIntent: "fox", aspectRatio: "square_1_1", candidateCount: 1,
        outputFormat: "png", modelOptionRevisionRef: "image-option:example" }),
      createEffectCommand: Object.freeze({ callerRequestFingerprint: "a".repeat(64),
        createEffectDigest: "a".repeat(64), definitionRoleRef: "image-role:example",
        operationInputRevisionRef: "media-input-revision:example",
        operationInputRevisionDigest: "c".repeat(64),
        logicalOutputSlots: Object.freeze([Object.freeze({ candidateOrdinal: 1,
          candidateRef: "media-candidate:example", stableOutputSlotRef: "image-slot:example" })]),
        effectBudgetCommitRef: "effect-budget-commit:example", effectBudgetCommitDigest: "d".repeat(64),
        attemptOrdinal: 1 as const, trustEffectAllowReceiptRef: "trust-effect-allow:example",
        trustEffectAllowReceiptDigest: "e".repeat(64), modelOptionRevisionRef: "image-option:example" }),
      effectAuthorization: Object.freeze({ callerAccess: exampleCapability("caller-access"),
        modelOptionAuthorization: exampleCapability("model-option-authorization"),
        sourceGrants: Object.freeze([]) }),
      candidateRefs: Object.freeze(["media-candidate:example"]),
      stableOutputSlotRefs: Object.freeze(["image-slot:example"]),
      artifactRefs: Object.freeze(["artifact:example"]),
      artifactVersionRefs: Object.freeze(["artifact-version:example"]),
      outputAccessCommandRefs: Object.freeze(["image-output-access-command:example:1"]),
      outputAccessRequestFingerprints: Object.freeze(["f".repeat(64)]),
      ownerScope: Object.freeze({ siteRef: "site:example", subjectRef: "subject:example",
        subjectGeneration: 1n, projectRef: "project:example" }),
      creditChildAllocationRef: "credit-child:example",
    });
  }

  async claim(): Promise<MediaImageWorkerTask | null> {
    if (this.#terminal !== undefined || this.#claimed) return null;
    this.#events.push("claim"); this.#claimed = true; this.#attemptCount += 1; this.#outboxState = "leased";
    return Object.freeze({ ...this.#task,
      effectAuthorization: cloneAuthorization(this.#task.effectAuthorization),
      leaseEpoch: BigInt(this.#attemptCount), leaseToken: "media-lease:one",
      checkpoint: this.#checkpoint,
      ...(this.#cancelEffectCommand === undefined ? {} : { cancelEffectCommand: this.#cancelEffectCommand }) });
  }
  async renewLease(task: MediaImageWorkerTask): Promise<void> { this.#fence(task); this.#events.push("lease.renew"); }
  async prepareEffect(task: MediaImageWorkerTask): Promise<MediaImageEffectPreparation> {
    this.#fence(task); this.#events.push("effect.prepare");
    if (this.#checkpoint.effectState === "none") {
      this.#checkpoint = Object.freeze({ ...this.#checkpoint, effectState: "started" });
      return Object.freeze({ kind: "create" as const });
    }
    if (this.#checkpoint.effectState === "started" || this.#checkpoint.effectState === "outcome_unknown") {
      return Object.freeze({ kind: "recover" as const });
    }
    if (this.#checkpoint.effectView === undefined || this.#checkpoint.effectReceipt === undefined) {
      throw new Error("MEDIA_EFFECT_CHECKPOINT_INVALID");
    }
    return Object.freeze({ kind: "resume" as const,
      result: Object.freeze({ receipt: this.#checkpoint.effectReceipt, invocation: this.#checkpoint.effectView }) });
  }
  async recordEffectResult(
    task: MediaImageWorkerTask,
    _digest: string,
    result: MediaImageEffectCommandResult,
  ) {
    this.#fence(task); this.#events.push("effect.record");
    this.#checkpoint = Object.freeze({ ...this.#checkpoint, effectState: "recorded",
      effectReceipt: result.receipt, effectView: result.invocation });
    return Object.freeze({ lateCancellationObserved: this.#cancelEffectCommand !== undefined });
  }
  async recordEffectView(task: MediaImageWorkerTask, _digest: string, view: MediaImageEffectView) {
    this.#fence(task); this.#events.push("effect.record");
    this.#checkpoint = Object.freeze({ ...this.#checkpoint, effectState: "recorded", effectView: view });
    return Object.freeze({ lateCancellationObserved: this.#cancelEffectCommand !== undefined });
  }
  async recordEvidencePage(task: MediaImageWorkerTask, input: Readonly<{
    afterEvidenceSequence: bigint; page: MediaImageEffectEvidencePage;
  }>) {
    this.#fence(task); this.#events.push("evidence.record");
    const prior = this.#checkpoint.evidence;
    if (prior.nextEvidenceSequence !== input.afterEvidenceSequence) {
      throw new Error("MEDIA_GATEWAY_EVIDENCE_CURSOR_CONFLICT");
    }
    const evidence = Object.freeze({ logicalInvocationRef: input.page.invocation.logicalInvocationRef,
      nextEvidenceSequence: input.page.nextEvidenceSequence, caughtUp: input.page.caughtUp,
      facts: Object.freeze([...prior.facts, ...input.page.evidenceFacts]) });
    this.#checkpoint = Object.freeze({ ...this.#checkpoint, evidence });
    return evidence;
  }
  async prepareCancel(task: MediaImageWorkerTask): Promise<MediaImageEffectPreparation> {
    this.#fence(task); this.#events.push("cancel.prepare");
    if (this.#checkpoint.cancelState === "none") {
      this.#checkpoint = Object.freeze({ ...this.#checkpoint, cancelState: "started" });
      return Object.freeze({ kind: "create" as const });
    }
    if (this.#checkpoint.cancelState === "started" || this.#checkpoint.cancelState === "outcome_unknown") {
      return Object.freeze({ kind: "recover" as const });
    }
    if (this.#checkpoint.cancelResult === undefined) throw new Error("MEDIA_CANCEL_CHECKPOINT_INVALID");
    return Object.freeze({ kind: "resume" as const, result: this.#checkpoint.cancelResult });
  }
  async recordCancelResult(
    task: MediaImageWorkerTask,
    _requestDigest: string,
    result: MediaImageEffectCommandResult,
  ): Promise<void> {
    this.#fence(task); this.#events.push("cancel.record");
    this.#checkpoint = Object.freeze({ ...this.#checkpoint, cancelState: "recorded", cancelResult: result,
      ...(result.invocation === undefined ? {} : { effectView: result.invocation }) });
  }
  async recordCancelOutcomeUnknown(task: MediaImageWorkerTask): Promise<void> {
    this.#fence(task); this.#events.push("cancel.outcome-unknown");
    this.#checkpoint = Object.freeze({ ...this.#checkpoint, cancelState: "outcome_unknown" });
  }
  async recordOutcomeUnknown(task: MediaImageWorkerTask): Promise<void> {
    this.#fence(task); this.#events.push("effect.outcome-unknown");
    this.#checkpoint = Object.freeze({ ...this.#checkpoint, effectState: "outcome_unknown", effectView: undefined });
    this.#operationState = "reconciling";
  }
  async recordArtifactStaged(task: MediaImageWorkerTask, receipt: ArtifactStagedReceipt): Promise<void> {
    this.#fence(task); this.#events.push("artifact.stage");
    this.#updateArtifact(task, receipt.artifactVersionRef, { stagedReceipt: receipt });
  }
  async recordTrustDecision(task: MediaImageWorkerTask, input: Readonly<{
    artifactVersionRef: string; decision: ArtifactTrustDecision;
  }>): Promise<void> {
    this.#fence(task); this.#events.push("trust.record");
    this.#updateArtifact(task, input.artifactVersionRef, { trustDecision: input.decision });
  }
  async recordArtifactReady(task: MediaImageWorkerTask, input: Readonly<{
    receipt: ArtifactReadyReceipt; finalizationReceiptRef: string;
  }>): Promise<void> {
    this.#fence(task); this.#events.push("artifact.promote");
    this.#updateArtifact(task, input.receipt.artifactVersionRef, { readyReceipt: input.receipt,
      finalizationReceiptRef: input.finalizationReceiptRef });
  }
  async recordUsage(task: MediaImageWorkerTask, receiptRef: string): Promise<void> {
    this.#fence(task); this.#events.push("usage.record");
    this.#checkpoint = Object.freeze({ ...this.#checkpoint, usageEvidenceReceiptRef: receiptRef });
  }
  async recordAllocationReturn(task: MediaImageWorkerTask, receiptRef: string): Promise<void> {
    this.#fence(task); this.#events.push("credit-return.record");
    this.#checkpoint = Object.freeze({ ...this.#checkpoint, allocationReturnReceiptRef: receiptRef });
  }
  async recordProjection(task: MediaImageWorkerTask, receiptRef: string): Promise<void> {
    this.#fence(task); this.#events.push("projection.record");
    this.#checkpoint = Object.freeze({ ...this.#checkpoint, projectionReceiptRef: receiptRef });
  }
  async complete(task: MediaImageWorkerTask, input: MediaImageTerminalClosure): Promise<void> {
    this.#fence(task); this.#events.push("complete"); this.#terminal = input; this.#claimed = false;
    this.#operationState = input.state === "canceled" ? "canceled" : "completed"; this.#outboxState = "completed";
  }
  async retryOrDeadLetter(task: MediaImageWorkerTask, input: Readonly<{ errorCode: string }>) {
    this.#fence(task);
    if (this.#attemptCount >= this.#maxAttempts) {
      this.#events.push("task.dead-letter"); this.#deadLetterCode = input.errorCode;
      this.#outboxState = "dead_letter"; this.#operationState = "reconciling"; this.#claimed = false;
      return "dead_letter" as const;
    }
    this.#events.push("task.retry"); this.#outboxState = "pending"; this.#operationState = "reconciling";
    this.#claimed = false; return "retry" as const;
  }
  async releaseOwnedLeases(input: Readonly<{ reason: "shutdown" | "shutdown-deadline" | "stop-claim-failed" }>) {
    this.#events.push(`lease.return:${input.reason}`);
    if (this.#claimed) { this.#claimed = false; this.#outboxState = "pending";
      this.#attemptCount = Math.max(0, this.#attemptCount - 1); }
  }
  requestCancellation(value: string): void {
    reference(value);
    this.#cancelEffectCommand = Object.freeze({ cancelIntentReceiptRef: value,
      cancelCommandRef: `image-cancel:${value}`, callerRequestFingerprint: "9".repeat(64) });
  }
  inspectState() { return Object.freeze({ outbox: this.#outboxState, operation: this.#operationState,
    effect: this.#checkpoint.effectState, attemptCount: this.#attemptCount,
    ...(this.#deadLetterCode === undefined ? {} : { deadLetterCode: this.#deadLetterCode }) }); }
  inspectTerminal(): MediaImageTerminalClosure | undefined { return this.#terminal; }
  inspectCheckpoint(): MediaImageSagaCheckpoint { return this.#checkpoint; }

  #updateArtifact(task: MediaImageWorkerTask, artifactVersionRef: string,
    update: Partial<MediaImageArtifactCheckpoint>): void {
    const ordinal = task.artifactVersionRefs.indexOf(artifactVersionRef) + 1;
    if (ordinal < 1) throw new Error("MEDIA_ARTIFACT_CHECKPOINT_INVALID");
    const artifacts = [...this.#checkpoint.artifacts];
    artifacts[ordinal - 1] = Object.freeze({ ...artifacts[ordinal - 1], ...update, candidateOrdinal: ordinal });
    this.#checkpoint = Object.freeze({ ...this.#checkpoint, artifacts: Object.freeze(artifacts) });
  }
  #fence(task: MediaImageWorkerTask): void {
    if (!this.#claimed || task.leaseEpoch !== BigInt(this.#attemptCount) || task.leaseToken !== "media-lease:one" ||
        task.taskRef !== this.#task.taskRef) throw new Error("MEDIA_WORKER_LEASE_LOST");
  }
}

function emptyCheckpoint(candidateCount: number): MediaImageSagaCheckpoint {
  return Object.freeze({ effectState: "none" as const,
    cancelState: "none" as const,
    evidence: Object.freeze({ nextEvidenceSequence: 0n, caughtUp: false, facts: Object.freeze([]) }),
    artifacts: Object.freeze(Array.from({ length: candidateCount }, (_, index) =>
      Object.freeze({ candidateOrdinal: index + 1 }))) });
}

function assertTask(task: MediaImageWorkerTask): void {
  if (task.leaseEpoch < 1n || task.candidateRefs.length !== task.request.candidateCount ||
      task.stableOutputSlotRefs.length !== task.request.candidateCount ||
      task.artifactRefs.length !== task.request.candidateCount ||
      task.artifactVersionRefs.length !== task.request.candidateCount ||
      task.outputAccessCommandRefs.length !== task.request.candidateCount ||
      task.outputAccessRequestFingerprints.length !== task.request.candidateCount ||
      task.checkpoint.artifacts.length !== task.request.candidateCount ||
      task.createEffectCommand.logicalOutputSlots.length !== task.request.candidateCount ||
      new Set(task.candidateRefs).size !== task.candidateRefs.length ||
      new Set(task.stableOutputSlotRefs).size !== task.stableOutputSlotRefs.length ||
      new Set(task.artifactRefs).size !== task.artifactRefs.length ||
      new Set(task.artifactVersionRefs).size !== task.artifactVersionRefs.length ||
      new Set(task.outputAccessCommandRefs).size !== task.outputAccessCommandRefs.length ||
      task.outputAccessRequestFingerprints.some((value) => !digestPattern(value)) ||
      task.createEffectCommand.logicalOutputSlots.some((slot, index) =>
        slot.candidateOrdinal !== index + 1 || slot.candidateRef !== task.candidateRefs[index] ||
        slot.stableOutputSlotRef !== task.stableOutputSlotRefs[index])) {
    throw new Error("MEDIA_WORKER_TASK_INVALID");
  }
  const command = task.createEffectCommand;
  reference(command.effectBudgetCommitRef); reference(command.definitionRoleRef);
  reference(command.operationInputRevisionRef); reference(command.trustEffectAllowReceiptRef);
  reference(command.modelOptionRevisionRef);
  for (const value of [command.callerRequestFingerprint, command.createEffectDigest,
    command.operationInputRevisionDigest, command.effectBudgetCommitDigest,
    command.trustEffectAllowReceiptDigest]) if (!digestPattern(value)) {
    throw new Error("MEDIA_EFFECT_COMMAND_INVALID");
  }
  if (command.attemptOrdinal !== 1 || command.modelOptionRevisionRef !== task.request.modelOptionRevisionRef) {
    throw new Error("MEDIA_EFFECT_COMMAND_INVALID");
  }
  if (command.callerRequestFingerprint !== command.createEffectDigest) {
    throw new Error("MEDIA_EFFECT_COMMAND_FINGERPRINT_MISMATCH");
  }
  assertCapability(task.effectAuthorization.callerAccess);
  assertCapability(task.effectAuthorization.modelOptionAuthorization);
  for (const grant of task.effectAuthorization.sourceGrants) {
    reference(grant.sourceVersionRef); assertCapability(grant.purposeGrant);
  }
}

function assertEffectView(task: MediaImageWorkerTask, view: MediaImageEffectView): void {
  reference(view.logicalInvocationRef); reference(view.modelInvocationCommandRef);
  instant(view.observedAt, "MEDIA_GATEWAY_EFFECT_VIEW_INVALID");
  if (view.modelInvocationCommandRef !== task.modelInvocationCommandRef || view.ownerVersion < 1n ||
      !Number.isInteger(view.currentAttemptOrdinal) || view.currentAttemptOrdinal < 1 ||
      !evidencePairValid(view.canonicalOutcomeEvidence) || !evidencePairValid(view.usageEvidence)) {
    throw new Error("MEDIA_GATEWAY_EFFECT_VIEW_INVALID");
  }
  if (["succeeded", "failed", "canceled"].includes(view.state) && view.canonicalOutcomeEvidence === undefined) {
    throw new Error("MEDIA_GATEWAY_EFFECT_VIEW_INVALID");
  }
}

function assertEffectResult(
  task: MediaImageWorkerTask,
  result: MediaImageEffectCommandResult,
  expectedCommandRef: string,
  expectedRequestDigest: string,
): void {
  const receipt = result.receipt;
  reference(receipt.receiptRef); reference(receipt.callerCommandRef);
  if (receipt.callerCommandRef !== expectedCommandRef || !digestPattern(receipt.receiptDigest) ||
      !digestPattern(receipt.requestDigest) || receipt.receiptVersion < 1n) {
    throw new Error("MEDIA_GATEWAY_COMMAND_RECEIPT_INVALID");
  }
  instant(receipt.recordedAt, "MEDIA_GATEWAY_COMMAND_RECEIPT_INVALID");
  if (result.invocation !== undefined) {
    assertEffectView(task, result.invocation);
    if (receipt.logicalInvocationRef !== result.invocation.logicalInvocationRef) {
      throw new Error("MEDIA_GATEWAY_COMMAND_RECEIPT_INVALID");
    }
  }
  if (receipt.requestDigest !== expectedRequestDigest) {
    throw new Error("MEDIA_GATEWAY_COMMAND_RECEIPT_INVALID");
  }
}

function assertOwnerViewProgression(prior: MediaImageEffectView, next: MediaImageEffectView): void {
  if (prior.logicalInvocationRef !== next.logicalInvocationRef ||
      prior.modelInvocationCommandRef !== next.modelInvocationCommandRef ||
      next.ownerVersion < prior.ownerVersion ||
      (["succeeded", "failed", "canceled"].includes(prior.state) &&
       (next.ownerVersion !== prior.ownerVersion || next.state !== prior.state ||
        next.currentAttemptOrdinal !== prior.currentAttemptOrdinal ||
        !sameEvidenceIdentity(next.canonicalOutcomeEvidence, prior.canonicalOutcomeEvidence) ||
        !sameEvidenceIdentity(next.usageEvidence, prior.usageEvidence)))) {
    throw new Error("MEDIA_GATEWAY_EFFECT_VIEW_REGRESSION");
  }
}

function assertEvidencePage(
  task: MediaImageWorkerTask,
  terminalView: MediaImageEffectView,
  prior: MediaImageSagaCheckpoint["evidence"],
  page: MediaImageEffectEvidencePage,
): void {
  assertEffectView(task, page.invocation);
  if (page.invocation.logicalInvocationRef !== terminalView.logicalInvocationRef ||
      page.invocation.modelInvocationCommandRef !== terminalView.modelInvocationCommandRef ||
      page.invocation.ownerVersion !== terminalView.ownerVersion || page.invocation.state !== terminalView.state ||
      page.invocation.currentAttemptOrdinal !== terminalView.currentAttemptOrdinal ||
      !sameEvidenceIdentity(page.invocation.canonicalOutcomeEvidence, terminalView.canonicalOutcomeEvidence) ||
      !sameEvidenceIdentity(page.invocation.usageEvidence, terminalView.usageEvidence) ||
      page.nextEvidenceSequence < prior.nextEvidenceSequence || page.evidenceFacts.length > 64 ||
      (!page.caughtUp && page.nextEvidenceSequence === prior.nextEvidenceSequence)) {
    throw new Error("MEDIA_GATEWAY_EVIDENCE_PAGE_INVALID");
  }
  let expected = prior.nextEvidenceSequence + 1n;
  const knownSequences = new Set(prior.facts.map((fact) => fact.evidenceSequence.toString()));
  const knownReferences = new Map(prior.facts.map((fact) => [fact.evidenceRef, fact.evidenceDigest]));
  for (const fact of page.evidenceFacts) {
    if (fact.evidenceSequence !== expected || !digestPattern(fact.evidenceDigest)) {
      throw new Error("MEDIA_GATEWAY_EVIDENCE_PAGE_INVALID");
    }
    const priorDigest = knownReferences.get(fact.evidenceRef);
    if (knownSequences.has(fact.evidenceSequence.toString()) || priorDigest !== undefined) {
      throw new Error("MEDIA_GATEWAY_EVIDENCE_CONFLICT");
    }
    reference(fact.evidenceRef); instant(fact.recordedAt, "MEDIA_GATEWAY_EVIDENCE_PAGE_INVALID");
    if (fact.kind === "output") {
      if (fact.evidenceRef !== fact.outputEvidenceRef || fact.evidenceDigest !== fact.outputEvidenceDigest ||
          fact.candidateOrdinal < 1 || fact.candidateOrdinal > task.request.candidateCount ||
          fact.candidateRef !== task.candidateRefs[fact.candidateOrdinal - 1] ||
          fact.stableOutputSlotRef !== task.stableOutputSlotRefs[fact.candidateOrdinal - 1] ||
          fact.width < 1 || fact.height < 1 ||
          (fact.declaredByteSize !== undefined && fact.declaredByteSize < 1n)) {
        throw new Error("MEDIA_GATEWAY_OUTPUT_EVIDENCE_INVALID");
      }
    }
    knownSequences.add(fact.evidenceSequence.toString());
    knownReferences.set(fact.evidenceRef, fact.evidenceDigest);
    expected += 1n;
  }
  const last = page.evidenceFacts.at(-1)?.evidenceSequence ?? prior.nextEvidenceSequence;
  if (page.nextEvidenceSequence !== last) throw new Error("MEDIA_GATEWAY_EVIDENCE_PAGE_INVALID");
}

function assertTerminalEvidenceIdentity(
  view: MediaImageEffectView,
  facts: readonly MediaImageEffectEvidenceFact[],
): void {
  const outcome = requiredEvidence(view.canonicalOutcomeEvidence, "MEDIA_TERMINAL_OUTCOME_EVIDENCE_REQUIRED");
  if (!facts.some((fact) => fact.kind === "outcome" && fact.evidenceRef === outcome.ref &&
      fact.evidenceDigest === outcome.digest)) throw new Error("MEDIA_GATEWAY_OUTCOME_EVIDENCE_MISSING");
  if (view.usageEvidence !== undefined && !facts.some((fact) => fact.kind === "usage" &&
      fact.evidenceRef === view.usageEvidence!.ref && fact.evidenceDigest === view.usageEvidence!.digest)) {
    throw new Error("MEDIA_GATEWAY_USAGE_EVIDENCE_MISSING");
  }
}

function terminalOutputEvidence(
  task: MediaImageWorkerTask,
  view: MediaImageEffectView,
  facts: readonly MediaImageEffectEvidenceFact[],
): readonly MediaImageEffectOutputEvidence[] {
  assertTerminalEvidenceIdentity(view, facts);
  const outputs = facts.filter((fact): fact is Extract<MediaImageEffectEvidenceFact, { kind: "output" }> =>
    fact.kind === "output").sort((left, right) => left.candidateOrdinal - right.candidateOrdinal);
  if (outputs.length !== task.request.candidateCount || outputs.some((output, index) =>
    output.candidateOrdinal !== index + 1)) throw new Error("MEDIA_GATEWAY_OUTPUT_EVIDENCE_INCOMPLETE");
  return Object.freeze(outputs);
}

function requiredEvidence(
  value: MediaImageCanonicalEvidenceIdentity | undefined,
  code: string,
): MediaImageCanonicalEvidenceIdentity {
  if (value === undefined || !evidencePairValid(value)) throw new Error(code);
  return value;
}

function evidencePairValid(value: MediaImageCanonicalEvidenceIdentity | undefined): boolean {
  return value === undefined || (value.ref.length > 0 && digestPattern(value.digest));
}

function sameEvidenceIdentity(
  left: MediaImageCanonicalEvidenceIdentity | undefined,
  right: MediaImageCanonicalEvidenceIdentity | undefined,
): boolean {
  return left === undefined ? right === undefined : right !== undefined &&
    left.ref === right.ref && left.digest === right.digest;
}

function digestPattern(value: string): boolean { return /^[a-f0-9]{64}$/u.test(value); }

function instant(value: string, code: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(code);
}

function reference(value: string): void {
  if (value.length < 1 || value.length > 256 || value.trim() !== value) throw new Error("MEDIA_REFERENCE_INVALID");
}
function boundedInteger(value: number, minimum: number, maximum: number, code: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(code);
  return value;
}
function errorCode(value: string): void {
  if (!/^[A-Z][A-Z0-9_.:-]{2,127}$/u.test(value)) throw new Error("MEDIA_WORKER_ERROR_CODE_INVALID");
}
function workerErrorCode(error: unknown): string {
  if (error instanceof MediaImageEffectError) return error.code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_.:-]{2,127}$/u.test(error.message)) return error.message;
  return "MEDIA_WORKER_UNEXPECTED";
}

function exampleCapability(prefix: string): MediaImageEphemeralCapability {
  const cleartext = `${prefix}:secret-value`;
  return Object.freeze({ handle: new TextEncoder().encode(cleartext),
    handleDigest: createHash("sha256").update(cleartext).digest("hex"),
    expiresAt: "2099-01-01T00:00:00.000Z", bindingRef: `${prefix}:binding` });
}

function assertCapability(value: MediaImageEphemeralCapability): void {
  if (!(value.handle instanceof Uint8Array) || value.handle.byteLength < 16 ||
      !/^[a-f0-9]{64}$/u.test(value.handleDigest) || !Number.isFinite(Date.parse(value.expiresAt))) {
    throw new Error("MEDIA_EFFECT_CAPABILITY_INVALID");
  }
  reference(value.bindingRef);
}

function wipeTaskAuthority(task: MediaImageWorkerTask): void {
  task.effectAuthorization.callerAccess.handle.fill(0);
  task.effectAuthorization.modelOptionAuthorization.handle.fill(0);
  for (const grant of task.effectAuthorization.sourceGrants) grant.purposeGrant.handle.fill(0);
}

function cloneAuthorization(value: MediaImageEffectAuthorization): MediaImageEffectAuthorization {
  return Object.freeze({ ...value, callerAccess: Object.freeze({ ...value.callerAccess,
    handle: new Uint8Array(value.callerAccess.handle) }),
  modelOptionAuthorization: Object.freeze({ ...value.modelOptionAuthorization,
    handle: new Uint8Array(value.modelOptionAuthorization.handle) }),
  sourceGrants: Object.freeze(value.sourceGrants.map((grant) => Object.freeze({ ...grant,
    purposeGrant: Object.freeze({ ...grant.purposeGrant,
      handle: new Uint8Array(grant.purposeGrant.handle) }) }))) });
}
