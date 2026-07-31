import { createHash } from "node:crypto";
import type {
  ArtifactObjectStore,
  ArtifactOwnerScope,
  ArtifactReadyReceipt,
  ArtifactStagedReceipt,
  ArtifactTrustDecision,
} from "../../artifact/index.js";

export const MAXIMUM_BUFFERED_IMAGE_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAXIMUM_BUFFERED_IMAGE_OUTCOME_BYTES = 32 * 1024 * 1024;

export type ImageProviderRequest = Readonly<{
  promptIntent: string;
  aspectRatio: "square_1_1" | "landscape_4_3" | "landscape_16_9" | "portrait_3_4" | "portrait_9_16";
  candidateCount: 1 | 2 | 3 | 4;
  outputFormat: "png" | "jpeg" | "webp";
  modelOptionRevisionRef: string;
}>;

export type ImageProviderOutcome = Readonly<{
  providerEffectRef: string;
  providerUsage: Readonly<{ unit: "image"; quantity: bigint }>;
  outputs: readonly Readonly<{
    candidateOrdinal: number;
    bytes: Uint8Array;
    mediaType: "image/png" | "image/jpeg" | "image/webp";
    width: number;
    height: number;
    providerOutputFactRef: string;
  }>[];
}>;

export interface ImageProviderAdapter {
  readonly adapterKind: string;
  createOrRecover(input: Readonly<{
    commandRef: string;
    request: ImageProviderRequest;
    signal: AbortSignal;
  }>): Promise<ImageProviderOutcome>;
}

export type MediaImageWorkerTask = Readonly<{
  taskRef: string;
  leaseEpoch: bigint;
  leaseToken: string;
  operationRef: string;
  modelInvocationCommandRef: string;
  request: ImageProviderRequest;
  candidateRefs: readonly string[];
  artifactRefs: readonly string[];
  artifactVersionRefs: readonly string[];
  ownerScope: ArtifactOwnerScope;
  creditChildAllocationRef: string;
}>;

export interface MediaImageWorkerRepository {
  claim(input: Readonly<{ workerId: string; now: string; leaseMs: number }>): Promise<MediaImageWorkerTask | null>;
  beginEffect(task: MediaImageWorkerTask, requestDigest: string): Promise<
    Readonly<{ kind: "invoke" }> | Readonly<{ kind: "replay"; outcome: ImageProviderOutcome }>
  >;
  recordEffect(task: MediaImageWorkerTask, requestDigest: string, outcome: ImageProviderOutcome): Promise<void>;
  recordArtifactStaged(task: MediaImageWorkerTask, receipt: ArtifactStagedReceipt): Promise<void>;
  recordArtifactReady(task: MediaImageWorkerTask, receipt: ArtifactReadyReceipt): Promise<void>;
  complete(task: MediaImageWorkerTask, input: MediaImageTerminalClosure): Promise<void>;
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
    providerEffectRef: string;
    providerUsage: ImageProviderOutcome["providerUsage"];
    providerOutputFactRefs: readonly string[];
  }>): Promise<Readonly<{ attemptUsageEvidenceReceiptRef: string }>>;
}

export interface MediaImageCreditSettlementPort {
  settleChild(input: Readonly<{
    operationRef: string;
    childAllocationRef: string;
    attemptUsageEvidenceReceiptRef: string;
  }>): Promise<Readonly<{ effectBudgetCommitRef: string }>>;
}

export interface MediaImageSessionProjectionPort {
  publish(input: Readonly<{
    ownerScope: ArtifactOwnerScope;
    operationRef: string;
    state: "completed";
    artifactVersionRefs: readonly string[];
    terminalReceiptRef: string;
  }>, signal: AbortSignal): Promise<Readonly<{ projectionReceiptRef: string }>>;
}

export type MediaImageTerminalClosure = Readonly<{
  state: "completed";
  terminalReceiptRef: string;
  receipts: Readonly<{
    providerEffectRef: string;
    artifactFinalizationReceiptRefs: readonly string[];
    usageEvidenceReceiptRef: string;
    effectBudgetCommitRef: string;
    projectionReceiptRef: string;
  }>;
  completedAt: string;
}>;

export class ImageOperationWorker {
  readonly #dependencies: Readonly<{
    repository: MediaImageWorkerRepository;
    provider: ImageProviderAdapter;
    artifact: ArtifactObjectStore;
    trust: ImageOutputTrustPort;
    usage: MediaImageUsagePort;
    credit: MediaImageCreditSettlementPort;
    projection: MediaImageSessionProjectionPort;
    workerId: string;
    clock: () => Date;
  }>;

  constructor(input: Readonly<{
    repository: MediaImageWorkerRepository;
    provider: ImageProviderAdapter;
    artifact: ArtifactObjectStore;
    trust: ImageOutputTrustPort;
    usage: MediaImageUsagePort;
    credit: MediaImageCreditSettlementPort;
    projection: MediaImageSessionProjectionPort;
    workerId: string;
    clock?: () => Date;
  }>) {
    reference(input.workerId);
    this.#dependencies = Object.freeze({ ...input, clock: input.clock ?? (() => new Date()) });
  }

  async runOne(signal: AbortSignal): Promise<"idle" | "completed"> {
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const now = this.#date();
    const task = await this.#dependencies.repository.claim({ workerId: this.#dependencies.workerId,
      now: now.toISOString(), leaseMs: 30_000 });
    if (task === null) return "idle";
    assertTask(task);
    const requestDigest = digestProviderRequest(task.modelInvocationCommandRef, task.request);
    const begun = await this.#dependencies.repository.beginEffect(task, requestDigest);
    const outcome = begun.kind === "replay"
      ? begun.outcome
      : await this.#invokeAndRecord(task, requestDigest, signal);
    assertOutcome(task, outcome);
    const finalizationReceiptRefs: string[] = [];
    for (const output of outcome.outputs) {
      const artifactVersionRef = task.artifactVersionRefs[output.candidateOrdinal - 1]!;
      const artifactRef = task.artifactRefs[output.candidateOrdinal - 1]!;
      const staged = await this.#dependencies.artifact.stage({ ownerScope: task.ownerScope,
        artifactRef, artifactVersionRef,
        bytes: output.bytes, mediaType: output.mediaType });
      await this.#dependencies.repository.recordArtifactStaged(task, staged);
      const trustDecision = await this.#dependencies.trust.evaluate({
        operationRef: task.operationRef,
        artifactVersionRef,
        contentSha256: staged.contentSha256,
        mediaType: staged.mediaType,
        byteSize: staged.byteSize,
      }, signal);
      const ready = await this.#dependencies.artifact.promote({ stagedReceipt: staged, trustDecision });
      await this.#dependencies.repository.recordArtifactReady(task, ready);
      finalizationReceiptRefs.push(`artifact-finalization:sha256:${createHash("sha256")
        .update("kokoro.platform.artifact-finalization.v1\0")
        .update(ready.artifactVersionRef).update("\0")
        .update(ready.contentSha256).update("\0")
        .update(ready.trustDecisionRef).digest("hex")}`);
    }
    const usage = await this.#dependencies.usage.recordAttempt({
      operationRef: task.operationRef,
      modelInvocationCommandRef: task.modelInvocationCommandRef,
      providerEffectRef: outcome.providerEffectRef,
      providerUsage: outcome.providerUsage,
      providerOutputFactRefs: outcome.outputs.map((output) => output.providerOutputFactRef),
    });
    const credit = await this.#dependencies.credit.settleChild({
      operationRef: task.operationRef,
      childAllocationRef: task.creditChildAllocationRef,
      attemptUsageEvidenceReceiptRef: usage.attemptUsageEvidenceReceiptRef,
    });
    const terminalReceiptRef = `media-terminal:sha256:${createHash("sha256")
      .update("kokoro.platform.media-terminal.v1\0")
      .update(task.operationRef).update("\0")
      .update(finalizationReceiptRefs.join("\0")).update("\0")
      .update(usage.attemptUsageEvidenceReceiptRef).update("\0")
      .update(credit.effectBudgetCommitRef).digest("hex")}`;
    const projection = await this.#dependencies.projection.publish({
      ownerScope: task.ownerScope,
      operationRef: task.operationRef,
      state: "completed",
      artifactVersionRefs: task.artifactVersionRefs,
      terminalReceiptRef,
    }, signal);
    await this.#dependencies.repository.complete(task, Object.freeze({
      state: "completed" as const,
      terminalReceiptRef,
      receipts: Object.freeze({
        providerEffectRef: outcome.providerEffectRef,
        artifactFinalizationReceiptRefs: Object.freeze(finalizationReceiptRefs),
        usageEvidenceReceiptRef: usage.attemptUsageEvidenceReceiptRef,
        effectBudgetCommitRef: credit.effectBudgetCommitRef,
        projectionReceiptRef: projection.projectionReceiptRef,
      }),
      completedAt: this.#date().toISOString(),
    }));
    return "completed";
  }

  async #invokeAndRecord(
    task: MediaImageWorkerTask,
    requestDigest: string,
    signal: AbortSignal,
  ): Promise<ImageProviderOutcome> {
    const outcome = await this.#dependencies.provider.createOrRecover({
      commandRef: task.modelInvocationCommandRef,
      request: task.request,
      signal,
    });
    assertOutcome(task, outcome);
    await this.#dependencies.repository.recordEffect(task, requestDigest, outcome);
    return outcome;
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
  readonly #task: Omit<MediaImageWorkerTask, "leaseEpoch" | "leaseToken">;
  readonly #events: string[];
  #outcome: ImageProviderOutcome | undefined;
  #requestDigest: string | undefined;
  #claimed = false;
  #terminal: MediaImageTerminalClosure | undefined;
  readonly #staged = new Map<string, ArtifactStagedReceipt>();
  readonly #ready = new Map<string, ArtifactReadyReceipt>();

  constructor(
    task: Omit<MediaImageWorkerTask, "leaseEpoch" | "leaseToken"> = InMemoryMediaImageWorkerRepository.exampleTask(),
    events: string[] = [],
    recoveredOutcome?: ImageProviderOutcome,
  ) {
    this.#task = task;
    this.#events = events;
    this.#outcome = recoveredOutcome;
    this.#requestDigest = recoveredOutcome === undefined
      ? undefined
      : digestProviderRequest(task.modelInvocationCommandRef, task.request);
  }

  static exampleTask(): Omit<MediaImageWorkerTask, "leaseEpoch" | "leaseToken"> {
    return Object.freeze({
      operationRef: "media-operation:example", taskRef: "media-task:example",
      modelInvocationCommandRef: "model-invocation-command:example",
      request: Object.freeze({ promptIntent: "fox", aspectRatio: "square_1_1", candidateCount: 1,
        outputFormat: "png", modelOptionRevisionRef: "image-option:example" }),
      candidateRefs: Object.freeze(["media-candidate:example"]),
      artifactRefs: Object.freeze(["artifact:example"]),
      artifactVersionRefs: Object.freeze(["artifact-version:example"]),
      ownerScope: Object.freeze({ siteRef: "site:example", subjectRef: "subject:example",
        subjectGeneration: 1n, projectRef: "project:example" }),
      creditChildAllocationRef: "credit-child:example",
    });
  }

  async claim(): Promise<MediaImageWorkerTask | null> {
    if (this.#terminal !== undefined || this.#claimed) return null;
    this.#events.push("claim");
    this.#claimed = true;
    return Object.freeze({ ...this.#task, leaseEpoch: 1n, leaseToken: "media-lease:one" });
  }

  async beginEffect(task: MediaImageWorkerTask, requestDigest: string) {
    this.#fence(task);
    this.#events.push("effect.begin");
    if (this.#outcome === undefined) return Object.freeze({ kind: "invoke" as const });
    if (this.#requestDigest !== requestDigest) throw new Error("MEDIA_EFFECT_REQUEST_DIGEST_CONFLICT");
    return Object.freeze({ kind: "replay" as const, outcome: this.#outcome });
  }

  async recordEffect(task: MediaImageWorkerTask, requestDigest: string, outcome: ImageProviderOutcome) {
    this.#fence(task);
    if (this.#outcome !== undefined) throw new Error("MEDIA_EFFECT_ALREADY_RECORDED");
    this.#events.push("effect.record");
    this.#requestDigest = requestDigest;
    this.#outcome = outcome;
  }

  async recordArtifactStaged(task: MediaImageWorkerTask, receipt: ArtifactStagedReceipt) {
    this.#fence(task);
    this.#events.push("artifact.stage");
    this.#staged.set(receipt.artifactVersionRef, receipt);
  }

  async recordArtifactReady(task: MediaImageWorkerTask, receipt: ArtifactReadyReceipt) {
    this.#fence(task);
    if (!this.#staged.has(receipt.artifactVersionRef)) throw new Error("MEDIA_ARTIFACT_STAGE_RECEIPT_REQUIRED");
    this.#events.push("artifact.promote");
    this.#ready.set(receipt.artifactVersionRef, receipt);
  }

  async complete(task: MediaImageWorkerTask, input: MediaImageTerminalClosure) {
    this.#fence(task);
    if (this.#ready.size !== task.artifactVersionRefs.length || this.#outcome === undefined) {
      throw new Error("MEDIA_TERMINAL_RECEIPTS_INCOMPLETE");
    }
    this.#events.push("complete");
    this.#terminal = input;
    this.#claimed = false;
  }

  inspectTerminal(): MediaImageTerminalClosure | undefined { return this.#terminal; }

  #fence(task: MediaImageWorkerTask): void {
    if (!this.#claimed || task.leaseEpoch !== 1n || task.leaseToken !== "media-lease:one" ||
        task.taskRef !== this.#task.taskRef) throw new Error("MEDIA_WORKER_LEASE_LOST");
  }
}

function digestProviderRequest(commandRef: string, request: ImageProviderRequest): string {
  return createHash("sha256").update(JSON.stringify({ commandRef, request })).digest("hex");
}

function assertTask(task: MediaImageWorkerTask): void {
  if (task.leaseEpoch < 1n || task.candidateRefs.length !== task.request.candidateCount ||
      task.artifactRefs.length !== task.request.candidateCount ||
      task.artifactVersionRefs.length !== task.request.candidateCount ||
      new Set(task.candidateRefs).size !== task.candidateRefs.length ||
      new Set(task.artifactRefs).size !== task.artifactRefs.length ||
      new Set(task.artifactVersionRefs).size !== task.artifactVersionRefs.length) {
    throw new Error("MEDIA_WORKER_TASK_INVALID");
  }
}

function assertOutcome(task: MediaImageWorkerTask, outcome: ImageProviderOutcome): void {
  const totalBytes = outcome.outputs.reduce((total, output) => total + output.bytes.byteLength, 0);
  if (outcome.outputs.length !== task.request.candidateCount || outcome.providerUsage.quantity < 1n ||
      outcome.providerUsage.unit !== "image" ||
      totalBytes > MAXIMUM_BUFFERED_IMAGE_OUTCOME_BYTES ||
      outcome.outputs.some((output, index) => output.candidateOrdinal !== index + 1 ||
        output.bytes.byteLength < 1 || output.bytes.byteLength > MAXIMUM_BUFFERED_IMAGE_OUTPUT_BYTES ||
        output.width < 1 || output.height < 1)) {
    throw new Error("MEDIA_PROVIDER_OUTCOME_INVALID");
  }
}

function reference(value: string): void {
  if (value.length < 1 || value.length > 256 || value.trim() !== value) throw new Error("MEDIA_REFERENCE_INVALID");
}
