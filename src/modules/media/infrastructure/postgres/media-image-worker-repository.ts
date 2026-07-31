import { createHash, randomBytes } from "node:crypto";
import { fromBinary } from "@bufbuild/protobuf";
import {
  CanonicalImageAspectRatio,
  CanonicalImageOutputFormat,
  CanonicalMediaOperationInputV1Schema,
} from "../../../../interfaces/connect/generated-media-runtime/kokoro/platform/media/v1/media_canonical_pb.js";
import type {
  MediaImageArtifactCheckpoint,
  MediaImageEffectCommandReceipt,
  MediaImageEffectCommandResult,
  MediaImageEffectEvidenceFact,
  MediaImageEffectEvidencePage,
  MediaImageEphemeralCapability,
  MediaImageEffectPreparation,
  MediaImageEffectView,
  MediaImageFinancialSettlement,
  MediaImageSagaCheckpoint,
  MediaImageTerminalClosure,
  MediaImageWorkerRepository,
  MediaImageWorkerTask,
} from "../../application/image-operation-worker.js";
import type {
  EnvelopeOperationInputProtector,
  MediaOperationOwnerBinding,
  ProtectedOperationInputRevision,
} from "../../application/operation-input-protection.js";
import type {
  ArtifactReadyReceipt,
  ArtifactStagedReceipt,
  ArtifactTrustDecision,
} from "../../../artifact/index.js";

const DIGEST = /^[a-f0-9]{64}$/u;
const EFFECT_OWNER_KIND = "model-gateway.image-effect.v1";

export type MediaImageWorkerTaskRow = Readonly<{
  taskRef: string;
  operationRef: string;
  leaseEpoch: bigint | string;
  operationState: "queued" | "active" | "cancel_requested" | "reconciling" | "finalizing";
  cancelIntentReceiptRef: string | null;
  modelInvocationCommandRef: string;
  creditExecutionBudgetRootRef: string;
  creditAuthorizationSegmentRef: string;
  creditExecutionManifestRef: string;
  creditParentAllocationRef: string;
  creditChildAllocationRef: string;
  creditAllocationReceiptRef: string;
  creditReservedCeiling: bigint | string;
  creditUnit: string;
  effectBudgetCommitRef: string;
  effectBudgetCommitDigest: string;
  attemptOrdinal: number;
  gatewayCallerRequestFingerprint: string;
  gatewayCreateEffectDigest: string;
  definitionRoleRef: string;
  operationInputRevisionDigest: string;
  trustEffectAllowReceiptRef: string;
  trustEffectAllowReceiptDigest: string;
  sourceGrants: unknown;
  callerAccessCapabilityEnvelope: unknown;
  callerAccessHandleDigest: string;
  callerAccessExpiresAt: string;
  callerAccessBindingRef: string;
  modelOptionAuthorizationCapabilityEnvelope: unknown;
  modelOptionAuthorizationHandleDigest: string;
  modelOptionAuthorizationExpiresAt: string;
  modelOptionAuthorizationBindingRef: string;
  siteRef: string;
  subjectRef: string;
  subjectGeneration: bigint | string;
  projectRef: string;
  workloadRef: string;
  source: string;
  definitionRevisionRef: string;
  modelOptionRevisionRef: string;
  operationInputRevisionRef: string;
  keyRevisionRef: string;
  ciphertext: Uint8Array;
  contentIv: Uint8Array;
  contentTag: Uint8Array;
  wrappedDek: Uint8Array;
  wrapIv: Uint8Array;
  wrapTag: Uint8Array;
  plaintextBytes: number;
  candidates: unknown;
  cancelCommandRef: string | null;
  cancelRequestFingerprint: string | null;
  sagaCheckpoint: unknown;
}>;

export type MediaImageWorkerEffectRow = Readonly<{
  requestDigest: string;
  state: "started" | "recorded" | "outcome_unknown";
  ownerResult: unknown | null;
  created: boolean;
}>;

type LeaseFence = Readonly<{
  taskRef: string;
  operationRef: string;
  leaseEpoch: bigint;
  leaseTokenHash: string;
}>;

export interface MediaImageWorkerDatabase {
  claim(input: Readonly<{ workerId: string; leaseTokenHash: string; leaseSeconds: number }> ):
    Promise<readonly MediaImageWorkerTaskRow[]>;
  renew(input: LeaseFence & Readonly<{ leaseSeconds: number }>): Promise<void>;
  prepareEffect(input: LeaseFence & Readonly<{
    requestDigest: string;
    effectOwnerKind: typeof EFFECT_OWNER_KIND;
    startedAt: string;
  }>): Promise<readonly MediaImageWorkerEffectRow[]>;
  recordEffectView(input: LeaseFence & Readonly<{
    requestDigest: string;
    ownerResult: unknown;
    gatewayCommandReceiptRef: string;
    gatewayCommandReceiptDigest: string;
    recordedAt: string;
  }>): Promise<Readonly<{ lateCancellationObserved: boolean }>>;
  recordOwnerView(input: LeaseFence & Readonly<{
    requestDigest: string;
    ownerView: unknown;
    recordedAt: string;
  }>): Promise<Readonly<{ lateCancellationObserved: boolean }>>;
  recordEvidencePage(input: LeaseFence & Readonly<{
    logicalInvocationRef: string;
    priorNextEvidenceSequence: bigint;
    nextEvidenceSequence: bigint;
    caughtUp: boolean;
    ownerView: unknown;
    facts: unknown;
    recordedAt: string;
  }>): Promise<readonly Readonly<{ evidenceCheckpoint: unknown }>[] >;
  prepareCancel(input: LeaseFence & Readonly<{
    cancelCommandRef: string;
    requestDigest: string;
    startedAt: string;
  }>): Promise<readonly MediaImageWorkerEffectRow[]>;
  recordCancelResult(input: LeaseFence & Readonly<{
    cancelCommandRef: string;
    requestDigest: string;
    ownerResult: unknown;
    gatewayCommandReceiptRef: string;
    gatewayCommandReceiptDigest: string;
    recordedAt: string;
  }>): Promise<void>;
  recordCancelOutcomeUnknown(input: LeaseFence & Readonly<{
    cancelCommandRef: string;
    requestDigest: string;
    errorCode: string;
    observedAt: string;
  }>): Promise<void>;
  recordOutcomeUnknown(input: LeaseFence & Readonly<{ errorCode: string; observedAt: string }>): Promise<void>;
  recordSagaReceipt(input: LeaseFence & Readonly<{
    step: "artifact_staged" | "trust_decision" | "artifact_ready" | "usage" | "financial_closure" | "projection";
    bindingRef: string;
    receipt: unknown;
  }>): Promise<void>;
  complete(input: LeaseFence & Readonly<{ closure: unknown }>): Promise<void>;
  retryOrDeadLetter(input: LeaseFence & Readonly<{ errorCode: string; retryAt: string; failedAt: string }> ):
    Promise<"retry" | "dead_letter">;
  releaseOwnedLeases(input: Readonly<{ workerId: string; reason: string }>): Promise<void>;
}

export interface MediaImageCapabilityOpener {
  open(input: Readonly<{
    purpose: "model-gateway.image-effect.caller-access" | "model-gateway.image-effect.model-option" |
      "model-gateway.image-effect.source-grant";
    envelope: unknown;
    operationRef: string;
    modelInvocationCommandRef: string;
    expectedHandleDigest: string;
    expectedBindingRef: string;
    expiresAt: string;
  }>): Uint8Array;
}

/** Function-only PostgreSQL adapter; clear lease capabilities never cross the driver boundary. */
export class PostgresMediaImageWorkerRepository implements MediaImageWorkerRepository {
  readonly #database: MediaImageWorkerDatabase;
  readonly #inputProtector: Pick<EnvelopeOperationInputProtector, "open">;
  readonly #leaseToken: () => string;
  readonly #clock: () => Date;
  readonly #capabilityOpener: MediaImageCapabilityOpener;

  constructor(input: Readonly<{
    database: MediaImageWorkerDatabase;
    inputProtector: Pick<EnvelopeOperationInputProtector, "open">;
    capabilityOpener: MediaImageCapabilityOpener;
    leaseToken?: () => string;
    clock?: () => Date;
  }>) {
    this.#database = input.database;
    this.#inputProtector = input.inputProtector;
    this.#capabilityOpener = input.capabilityOpener;
    this.#leaseToken = input.leaseToken ?? (() => randomBytes(32).toString("base64url"));
    this.#clock = input.clock ?? (() => new Date());
  }

  async claim(input: Parameters<MediaImageWorkerRepository["claim"]>[0]): Promise<MediaImageWorkerTask | null> {
    reference(input.workerId, "MEDIA_WORKER_ID_INVALID");
    const leaseSeconds = leaseSecondsFromMs(input.leaseMs);
    instant(input.now, "MEDIA_WORKER_CLOCK_INVALID");
    const leaseToken = this.#leaseToken();
    opaqueLeaseToken(leaseToken);
    const rows = await this.#database.claim({ workerId: input.workerId,
      leaseTokenHash: digest(leaseToken), leaseSeconds });
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new Error("MEDIA_WORKER_CLAIM_AMBIGUOUS");
    const nowMs = this.#clock().getTime();
    if (!Number.isFinite(nowMs)) throw new Error("MEDIA_WORKER_CLOCK_INVALID");
    return taskFromRow(rows[0]!, leaseToken, this.#inputProtector, this.#capabilityOpener, nowMs);
  }

  renewLease(task: MediaImageWorkerTask, leaseMs: number): Promise<void> {
    return this.#database.renew({ ...fence(task), leaseSeconds: leaseSecondsFromMs(leaseMs) });
  }

  async prepareEffect(task: MediaImageWorkerTask, requestDigest: string): Promise<MediaImageEffectPreparation> {
    requestHash(requestDigest);
    const rows = await this.#database.prepareEffect({ ...fence(task), requestDigest,
      effectOwnerKind: EFFECT_OWNER_KIND, startedAt: this.#instant() });
    if (rows.length !== 1 || rows[0]!.requestDigest !== requestDigest) {
      throw new Error("MEDIA_EFFECT_JOURNAL_INVALID");
    }
    const row = rows[0]!;
    if (row.state === "recorded") {
      if (row.ownerResult === null) throw new Error("MEDIA_EFFECT_JOURNAL_INVALID");
      return Object.freeze({ kind: "resume" as const, result: parseEffectResult(row.ownerResult) });
    }
    if (row.state === "started" || row.state === "outcome_unknown") {
      if (row.created) return Object.freeze({ kind: "create" as const });
      return row.ownerResult === null
        ? Object.freeze({ kind: "recover" as const })
        : Object.freeze({ kind: "resume" as const, result: parseEffectResult(row.ownerResult) });
    }
    throw new Error("MEDIA_EFFECT_JOURNAL_INVALID");
  }

  recordEffectResult(task: MediaImageWorkerTask, requestDigest: string, result: MediaImageEffectCommandResult) {
    requestHash(requestDigest);
    return this.#database.recordEffectView({ ...fence(task), requestDigest, ownerResult: persistEffectResult(result),
      gatewayCommandReceiptRef: result.receipt.receiptRef,
      gatewayCommandReceiptDigest: result.receipt.receiptDigest,
      recordedAt: this.#instant() });
  }

  recordEffectView(task: MediaImageWorkerTask, requestDigest: string, view: MediaImageEffectView) {
    requestHash(requestDigest);
    return this.#database.recordOwnerView({ ...fence(task), requestDigest, ownerView: persistEffectView(view),
      recordedAt: this.#instant() });
  }

  async recordEvidencePage(task: MediaImageWorkerTask, input: Readonly<{
    afterEvidenceSequence: bigint; page: MediaImageEffectEvidencePage;
  }>) {
    const page = input.page;
    const rows = await this.#database.recordEvidencePage({ ...fence(task),
      logicalInvocationRef: page.invocation.logicalInvocationRef,
      priorNextEvidenceSequence: input.afterEvidenceSequence,
      nextEvidenceSequence: page.nextEvidenceSequence,
      caughtUp: page.caughtUp,
      ownerView: persistEffectView(page.invocation),
      facts: page.evidenceFacts.map(persistEvidenceFact),
      recordedAt: this.#instant(),
    });
    if (rows.length !== 1) throw new Error("MEDIA_GATEWAY_EVIDENCE_CHECKPOINT_INVALID");
    return parseEvidenceCheckpoint(rows[0]!.evidenceCheckpoint);
  }

  async prepareCancel(task: MediaImageWorkerTask, requestDigest: string): Promise<MediaImageEffectPreparation> {
    requestHash(requestDigest);
    const command = requiredCancelCommand(task);
    const rows = await this.#database.prepareCancel({ ...fence(task), cancelCommandRef: command.cancelCommandRef,
      requestDigest, startedAt: this.#instant() });
    if (rows.length !== 1 || rows[0]!.requestDigest !== requestDigest) throw new Error("MEDIA_CANCEL_JOURNAL_INVALID");
    const row = rows[0]!;
    if (row.state === "recorded") {
      if (row.ownerResult === null) throw new Error("MEDIA_CANCEL_JOURNAL_INVALID");
      return Object.freeze({ kind: "resume" as const, result: parseEffectResult(row.ownerResult) });
    }
    if (row.created) return Object.freeze({ kind: "create" as const });
    return Object.freeze({ kind: "recover" as const });
  }

  recordCancelResult(
    task: MediaImageWorkerTask,
    requestDigest: string,
    result: MediaImageEffectCommandResult,
  ): Promise<void> {
    requestHash(requestDigest);
    const command = requiredCancelCommand(task);
    return this.#database.recordCancelResult({ ...fence(task), cancelCommandRef: command.cancelCommandRef,
      requestDigest, ownerResult: persistEffectResult(result),
      gatewayCommandReceiptRef: result.receipt.receiptRef,
      gatewayCommandReceiptDigest: result.receipt.receiptDigest, recordedAt: this.#instant() });
  }

  recordCancelOutcomeUnknown(
    task: MediaImageWorkerTask,
    input: Parameters<MediaImageWorkerRepository["recordCancelOutcomeUnknown"]>[1],
  ): Promise<void> {
    requestHash(input.requestDigest); errorCode(input.errorCode);
    instant(input.observedAt, "MEDIA_WORKER_TIMESTAMP_INVALID");
    const command = requiredCancelCommand(task);
    return this.#database.recordCancelOutcomeUnknown({ ...fence(task), cancelCommandRef: command.cancelCommandRef,
      ...input });
  }

  recordOutcomeUnknown(
    task: MediaImageWorkerTask,
    input: Parameters<MediaImageWorkerRepository["recordOutcomeUnknown"]>[1],
  ): Promise<void> {
    errorCode(input.errorCode); instant(input.observedAt, "MEDIA_WORKER_TIMESTAMP_INVALID");
    return this.#database.recordOutcomeUnknown({ ...fence(task), ...input });
  }

  recordArtifactStaged(task: MediaImageWorkerTask, receipt: ArtifactStagedReceipt): Promise<void> {
    return this.#recordSaga(task, "artifact_staged", receipt.artifactVersionRef, persistArtifactReceipt(receipt));
  }

  recordTrustDecision(task: MediaImageWorkerTask, input: Readonly<{
    artifactVersionRef: string; decision: ArtifactTrustDecision;
  }>): Promise<void> {
    return this.#recordSaga(task, "trust_decision", input.artifactVersionRef, { ...input.decision });
  }

  recordArtifactReady(task: MediaImageWorkerTask, input: Readonly<{
    receipt: ArtifactReadyReceipt; finalizationReceiptRef: string;
  }>): Promise<void> {
    return this.#recordSaga(task, "artifact_ready", input.receipt.artifactVersionRef,
      { ...persistArtifactReceipt(input.receipt) as object,
        finalizationReceiptRef: input.finalizationReceiptRef });
  }

  recordUsage(task: MediaImageWorkerTask, receiptRef: string): Promise<void> {
    reference(receiptRef, "MEDIA_USAGE_RECEIPT_INVALID");
    return this.#recordSaga(task, "usage", task.operationRef, { receiptRef });
  }

  recordFinancialClosure(task: MediaImageWorkerTask, settlement: MediaImageFinancialSettlement): Promise<void> {
    const financial = parseFinancialSettlement(settlement);
    return this.#recordSaga(task, "financial_closure", task.operationRef, financial);
  }

  recordProjection(task: MediaImageWorkerTask, receiptRef: string): Promise<void> {
    reference(receiptRef, "MEDIA_PROJECTION_RECEIPT_INVALID");
    return this.#recordSaga(task, "projection", task.operationRef, { receiptRef });
  }

  complete(task: MediaImageWorkerTask, input: MediaImageTerminalClosure): Promise<void> {
    return this.#database.complete({ ...fence(task), closure: persistTerminalClosure(input) });
  }

  retryOrDeadLetter(
    task: MediaImageWorkerTask,
    input: Parameters<MediaImageWorkerRepository["retryOrDeadLetter"]>[1],
  ): Promise<"retry" | "dead_letter"> {
    errorCode(input.errorCode); instant(input.retryAt, "MEDIA_WORKER_TIMESTAMP_INVALID");
    instant(input.failedAt, "MEDIA_WORKER_TIMESTAMP_INVALID");
    return this.#database.retryOrDeadLetter({ ...fence(task), ...input });
  }

  releaseOwnedLeases(input: Parameters<MediaImageWorkerRepository["releaseOwnedLeases"]>[0]): Promise<void> {
    reference(input.workerId, "MEDIA_WORKER_ID_INVALID");
    return this.#database.releaseOwnedLeases(input);
  }

  #recordSaga(task: MediaImageWorkerTask, step: Parameters<MediaImageWorkerDatabase["recordSagaReceipt"]>[0]["step"],
    bindingRef: string, receipt: unknown): Promise<void> {
    reference(bindingRef, "MEDIA_SAGA_RECEIPT_BINDING_INVALID");
    return this.#database.recordSagaReceipt({ ...fence(task), step, bindingRef, receipt });
  }

  #instant(): string {
    const value = this.#clock();
    if (!Number.isFinite(value.getTime())) throw new Error("MEDIA_WORKER_CLOCK_INVALID");
    return value.toISOString();
  }
}

function taskFromRow(
  row: MediaImageWorkerTaskRow,
  leaseToken: string,
  protector: Pick<EnvelopeOperationInputProtector, "open">,
  capabilityOpener: MediaImageCapabilityOpener,
  nowMs: number,
): MediaImageWorkerTask {
  // The active worker projection is produced only by the Agent command owner. Direct Studio
  // remains fail-closed until its journal persists the complete DirectStudioOwnerAuthority.
  if (row.source !== "agent_runtime") throw new Error("MEDIA_WORKER_OWNER_BINDING_UNSUPPORTED");
  const ownerBinding: MediaOperationOwnerBinding = Object.freeze({ siteRef: row.siteRef,
    subjectRef: row.subjectRef, subjectGeneration: integer(row.subjectGeneration, "MEDIA_WORKER_TASK_INVALID"),
    projectRef: row.projectRef, workloadRef: row.workloadRef, source: "agent_runtime",
    definitionRevisionRef: row.definitionRevisionRef, modelOptionRevisionRef: row.modelOptionRevisionRef });
  const protectedInput: ProtectedOperationInputRevision = Object.freeze({
    operationInputRevisionRef: row.operationInputRevisionRef,
    encryptionAlgorithm: "AES-256-GCM-envelope-v1" as const,
    keyRevisionRef: row.keyRevisionRef,
    ciphertextBase64: exactBase64(row.ciphertext), contentIvBase64: exactBase64(row.contentIv),
    contentTagBase64: exactBase64(row.contentTag), wrappedDekBase64: exactBase64(row.wrappedDek),
    wrapIvBase64: exactBase64(row.wrapIv), wrapTagBase64: exactBase64(row.wrapTag),
    plaintextBytes: row.plaintextBytes,
  });
  const plaintext = protector.open({ protectedInput, ownerBinding });
  let canonical;
  try {
    canonical = fromBinary(CanonicalMediaOperationInputV1Schema, plaintext, { readUnknownFields: false });
  } catch (cause) {
    throw new Error("MEDIA_WORKER_INPUT_INVALID", { cause });
  } finally {
    plaintext.fill(0);
  }
  if (canonical.contractMajor !== 1 || canonical.definitionRevisionRef !== row.definitionRevisionRef ||
      canonical.spec.case !== "imageTextToImage" ||
      canonical.spec.value.modelOptionRevisionRef !== row.modelOptionRevisionRef) {
    throw new Error("MEDIA_WORKER_INPUT_BINDING_INVALID");
  }
  const candidates = parseCandidates(row.candidates);
  if (candidates.length !== canonical.spec.value.candidateCount) throw new Error("MEDIA_WORKER_TASK_INVALID");
  reference(row.effectBudgetCommitRef, "MEDIA_EFFECT_AUTHORIZATION_MISSING");
  if (row.attemptOrdinal !== 1) {
    throw new Error("MEDIA_EFFECT_AUTHORIZATION_MISSING");
  }
  const checkpoint = parseCheckpoint(row.sagaCheckpoint, candidates.length);
  const definitionPolicy = parseDefinitionPolicy(row.sagaCheckpoint, candidates.length);
  const callerAccess = openCapability(capabilityOpener, row, "caller-access", nowMs);
  let modelOptionAuthorization: MediaImageEphemeralCapability;
  try {
    modelOptionAuthorization = openCapability(capabilityOpener, row, "model-option", nowMs);
  } catch (error) {
    callerAccess.handle.fill(0);
    throw error;
  }
  let sourceGrants: readonly Readonly<{ sourceVersionRef: string; purposeGrant: MediaImageEphemeralCapability }>[];
  try {
    sourceGrants = parseSourceGrants(row.sourceGrants).map((grant) => Object.freeze({
      sourceVersionRef: grant.sourceVersionRef,
      purposeGrant: openExternalCapability(capabilityOpener, {
        purpose: "model-gateway.image-effect.source-grant", envelope: grant.capabilityEnvelope,
        operationRef: row.operationRef, modelInvocationCommandRef: row.modelInvocationCommandRef,
        expectedHandleDigest: grant.handleDigest, expectedBindingRef: grant.bindingRef,
        expiresAt: grant.expiresAt,
      }, nowMs),
    }));
  } catch (error) {
    callerAccess.handle.fill(0); modelOptionAuthorization.handle.fill(0); throw error;
  }
  return Object.freeze({ taskRef: row.taskRef, leaseEpoch: integer(row.leaseEpoch, "MEDIA_WORKER_TASK_INVALID"),
    leaseToken, operationRef: row.operationRef, modelInvocationCommandRef: row.modelInvocationCommandRef,
    request: Object.freeze({ promptIntent: canonical.spec.value.promptIntent,
      aspectRatio: aspectRatio(canonical.spec.value.aspectRatio),
      candidateCount: canonical.spec.value.candidateCount as 1 | 2 | 3 | 4,
      outputFormat: outputFormat(canonical.spec.value.outputFormat),
      modelOptionRevisionRef: canonical.spec.value.modelOptionRevisionRef }),
    definitionPolicy,
    createEffectCommand: Object.freeze({ callerRequestFingerprint: row.gatewayCallerRequestFingerprint,
      createEffectDigest: row.gatewayCreateEffectDigest, definitionRoleRef: row.definitionRoleRef,
      operationInputRevisionRef: row.operationInputRevisionRef,
      operationInputRevisionDigest: row.operationInputRevisionDigest,
      logicalOutputSlots: Object.freeze(candidates.map((value) => Object.freeze({
        candidateOrdinal: value.ordinal, candidateRef: value.candidateRef,
        stableOutputSlotRef: value.stableOutputSlotRef,
      }))),
      effectBudgetCommitRef: row.effectBudgetCommitRef,
      effectBudgetCommitDigest: row.effectBudgetCommitDigest, attemptOrdinal: 1 as const,
      trustEffectAllowReceiptRef: row.trustEffectAllowReceiptRef,
      trustEffectAllowReceiptDigest: row.trustEffectAllowReceiptDigest,
      modelOptionRevisionRef: row.modelOptionRevisionRef }),
    effectAuthorization: Object.freeze({ callerAccess, modelOptionAuthorization,
      sourceGrants: Object.freeze(sourceGrants) }),
    candidateRefs: Object.freeze(candidates.map((value) => value.candidateRef)),
    stableOutputSlotRefs: Object.freeze(candidates.map((value) => value.stableOutputSlotRef)),
    artifactRefs: Object.freeze(candidates.map((value) => value.artifactRef)),
    artifactVersionRefs: Object.freeze(candidates.map((value) => value.artifactVersionRef)),
    outputAccessCommandRefs: Object.freeze(candidates.map((value) => value.outputAccessCommandRef)),
    outputAccessRequestFingerprints: Object.freeze(candidates.map((value) => value.outputAccessRequestFingerprint)),
    ownerScope: Object.freeze({ siteRef: row.siteRef, subjectRef: row.subjectRef,
      subjectGeneration: ownerBinding.subjectGeneration, projectRef: row.projectRef }),
    creditBudget: Object.freeze({ kind: "agent_child" as const,
      executionBudgetRootRef: row.creditExecutionBudgetRootRef,
      authorizationSegmentRef: row.creditAuthorizationSegmentRef,
      executionManifestRef: row.creditExecutionManifestRef,
      parentAllocationRef: row.creditParentAllocationRef,
      childAllocationRef: row.creditChildAllocationRef,
      allocationReservationReceiptRef: row.creditAllocationReceiptRef,
      reservedCeiling: integer(row.creditReservedCeiling, "MEDIA_WORKER_CREDIT_BUDGET_INVALID"),
      unit: requiredRef(row.creditUnit, "MEDIA_WORKER_CREDIT_BUDGET_INVALID") }),
    checkpoint,
    ...(row.cancelIntentReceiptRef === null ? {} : {
      cancelEffectCommand: Object.freeze({ cancelIntentReceiptRef: row.cancelIntentReceiptRef,
        cancelCommandRef: requiredNullableRef(row.cancelCommandRef, "MEDIA_CANCEL_COMMAND_MISSING"),
        callerRequestFingerprint: requiredNullableDigest(row.cancelRequestFingerprint,
          "MEDIA_CANCEL_COMMAND_MISSING") }),
    }) });
}

function parseDefinitionPolicy(value: unknown, candidateCount: number) {
  if (!record(value) || !record(value.definitionPolicy) ||
      (value.definitionPolicy.partialCompletion !== "allowed" &&
       value.definitionPolicy.partialCompletion !== "forbidden") ||
      typeof value.definitionPolicy.minimumReadyCandidates !== "number" ||
      !Number.isInteger(value.definitionPolicy.minimumReadyCandidates) ||
      value.definitionPolicy.minimumReadyCandidates < 1 ||
      value.definitionPolicy.minimumReadyCandidates > candidateCount) {
    throw new Error("MEDIA_DEFINITION_POLICY_INVALID");
  }
  return Object.freeze({
    partialCompletion: value.definitionPolicy.partialCompletion,
    minimumReadyCandidates: value.definitionPolicy.minimumReadyCandidates,
  });
}

function openCapability(
  opener: MediaImageCapabilityOpener,
  row: MediaImageWorkerTaskRow,
  kind: "caller-access" | "model-option",
  nowMs: number,
): MediaImageEphemeralCapability {
  const caller = kind === "caller-access";
  const handleDigest = caller ? row.callerAccessHandleDigest : row.modelOptionAuthorizationHandleDigest;
  const expiresAt = caller ? row.callerAccessExpiresAt : row.modelOptionAuthorizationExpiresAt;
  const bindingRef = caller ? row.callerAccessBindingRef : row.modelOptionAuthorizationBindingRef;
  const envelope = caller ? row.callerAccessCapabilityEnvelope : row.modelOptionAuthorizationCapabilityEnvelope;
  return openExternalCapability(opener, {
    purpose: caller ? "model-gateway.image-effect.caller-access" : "model-gateway.image-effect.model-option",
    envelope, operationRef: row.operationRef, modelInvocationCommandRef: row.modelInvocationCommandRef,
    expectedHandleDigest: handleDigest, expectedBindingRef: bindingRef, expiresAt,
  }, nowMs);
}

function openExternalCapability(
  opener: MediaImageCapabilityOpener,
  input: Parameters<MediaImageCapabilityOpener["open"]>[0],
  nowMs: number,
): MediaImageEphemeralCapability {
  if (!DIGEST.test(input.expectedHandleDigest)) throw new Error("MEDIA_EFFECT_CAPABILITY_DIGEST_INVALID");
  instant(input.expiresAt, "MEDIA_EFFECT_CAPABILITY_EXPIRY_INVALID");
  reference(input.expectedBindingRef, "MEDIA_EFFECT_CAPABILITY_BINDING_INVALID");
  if (Date.parse(input.expiresAt) <= nowMs) throw new Error("MEDIA_EFFECT_CAPABILITY_EXPIRED");
  const handle = opener.open(input);
  if (!(handle instanceof Uint8Array) || handle.byteLength < 16 || digestBytes(handle) !== input.expectedHandleDigest) {
    handle.fill(0);
    throw new Error("MEDIA_EFFECT_CAPABILITY_INVALID");
  }
  return Object.freeze({ handle, handleDigest: input.expectedHandleDigest,
    expiresAt: input.expiresAt, bindingRef: input.expectedBindingRef });
}

function parseCheckpoint(value: unknown, candidateCount: number): MediaImageSagaCheckpoint {
  if (!record(value) || typeof value.effectState !== "string" || typeof value.cancelState !== "string" ||
      !Array.isArray(value.artifacts) ||
      value.artifacts.length !== candidateCount ||
      !["none", "started", "outcome_unknown", "recorded"].includes(value.effectState) ||
      !["none", "started", "outcome_unknown", "recorded"].includes(value.cancelState)) {
    throw new Error("MEDIA_SAGA_CHECKPOINT_INVALID");
  }
  const artifacts = value.artifacts.map((raw, index) => parseArtifactCheckpoint(raw, index + 1));
  const effectView = value.effectView === null || value.effectView === undefined
    ? undefined : parseEffectView(value.effectView);
  const effectReceipt = value.effectReceipt === null || value.effectReceipt === undefined
    ? undefined : parseEffectReceipt(value.effectReceipt);
  if (value.effectState === "recorded" && effectReceipt === undefined) throw new Error("MEDIA_SAGA_CHECKPOINT_INVALID");
  const evidence = parseEvidenceCheckpoint(value.evidence);
  const cancelResult = value.cancelResult === null || value.cancelResult === undefined
    ? undefined : parseEffectResult(value.cancelResult);
  if (value.cancelState === "recorded" && cancelResult === undefined) throw new Error("MEDIA_SAGA_CHECKPOINT_INVALID");
  return Object.freeze({ effectState: value.effectState as MediaImageSagaCheckpoint["effectState"],
    cancelState: value.cancelState as MediaImageSagaCheckpoint["cancelState"],
    artifacts: Object.freeze(artifacts), evidence,
    ...(cancelResult === undefined ? {} : { cancelResult }),
    ...(effectReceipt === undefined ? {} : { effectReceipt }),
    ...(effectView === undefined ? {} : { effectView }),
    ...optionalRef(value, "usageEvidenceReceiptRef"),
    ...(value.financialClosure === null || value.financialClosure === undefined
      ? {} : { financialClosure: parseFinancialSettlement(value.financialClosure) }),
    ...optionalRef(value, "projectionReceiptRef") });
}

function parseArtifactCheckpoint(value: unknown, ordinal: number): MediaImageArtifactCheckpoint {
  if (!record(value) || value.candidateOrdinal !== ordinal) throw new Error("MEDIA_SAGA_CHECKPOINT_INVALID");
  return Object.freeze({ candidateOrdinal: ordinal,
    ...(value.stagedReceipt === undefined || value.stagedReceipt === null ? {} :
      { stagedReceipt: parseStagedReceipt(value.stagedReceipt) }),
    ...(value.trustDecision === undefined || value.trustDecision === null ? {} :
      { trustDecision: parseTrustDecision(value.trustDecision) }),
    ...(value.readyReceipt === undefined || value.readyReceipt === null ? {} :
      { readyReceipt: parseReadyReceipt(value.readyReceipt) }),
    ...optionalRef(value, "finalizationReceiptRef") });
}

function parseEffectView(value: unknown): MediaImageEffectView {
  const states = ["accepted", "definitely_not_submitted", "submitted", "submission_unknown", "running",
    "succeeded", "failed", "cancel_requested", "canceled", "outcome_unknown"];
  if (!record(value) || typeof value.logicalInvocationRef !== "string" ||
      typeof value.modelInvocationCommandRef !== "string" || typeof value.ownerVersion !== "string" ||
      typeof value.currentAttemptOrdinal !== "number" || typeof value.state !== "string" ||
      !states.includes(value.state) || typeof value.observedAt !== "string") throw new Error("MEDIA_EFFECT_VIEW_INVALID");
  return Object.freeze({ logicalInvocationRef: value.logicalInvocationRef,
    modelInvocationCommandRef: value.modelInvocationCommandRef,
    ownerVersion: integer(value.ownerVersion, "MEDIA_EFFECT_VIEW_INVALID"),
    currentAttemptOrdinal: value.currentAttemptOrdinal,
    state: value.state as MediaImageEffectView["state"], observedAt: value.observedAt,
    ...optionalEvidence(value, "canonicalOutcomeEvidence"),
    ...optionalEvidence(value, "usageEvidence") });
}

function persistEffectView(view: MediaImageEffectView): unknown {
  return { ...view, ownerVersion: view.ownerVersion.toString() };
}

function parseEffectReceipt(value: unknown): MediaImageEffectCommandReceipt {
  const kinds = ["create_committed", "definitely_not_submitted", "attempt_authorization_attached",
    "cancel_intent_committed", "rejected", "outcome_unknown", "output_access_issued"];
  if (!record(value) || typeof value.receiptRef !== "string" || typeof value.receiptDigest !== "string" ||
      typeof value.requestDigest !== "string" || typeof value.callerCommandRef !== "string" ||
      typeof value.kind !== "string" || !kinds.includes(value.kind) || typeof value.receiptVersion !== "string" ||
      typeof value.recordedAt !== "string") throw new Error("MEDIA_EFFECT_RECEIPT_INVALID");
  return Object.freeze({ receiptRef: value.receiptRef, receiptDigest: value.receiptDigest,
    requestDigest: value.requestDigest, callerCommandRef: value.callerCommandRef,
    kind: value.kind as MediaImageEffectCommandReceipt["kind"],
    receiptVersion: integer(value.receiptVersion, "MEDIA_EFFECT_RECEIPT_INVALID"), recordedAt: value.recordedAt,
    ...optionalRef(value, "logicalInvocationRef"), ...optionalRef(value, "attemptRef"),
    ...(typeof value.attemptOrdinal === "number" ? { attemptOrdinal: value.attemptOrdinal } : {}),
    ...(record(value.error) && typeof value.error.code === "string" && typeof value.error.safeMessage === "string"
      ? { error: Object.freeze({ code: value.error.code, safeMessage: value.error.safeMessage }) } : {}) });
}

function persistEffectResult(result: MediaImageEffectCommandResult): unknown {
  return { receipt: { ...result.receipt, receiptVersion: result.receipt.receiptVersion.toString() },
    ...(result.invocation === undefined ? {} : { invocation: persistEffectView(result.invocation) }) };
}

function parseEffectResult(value: unknown): MediaImageEffectCommandResult {
  if (!record(value) || value.receipt === undefined) throw new Error("MEDIA_EFFECT_RESULT_INVALID");
  return Object.freeze({ receipt: parseEffectReceipt(value.receipt),
    ...(value.invocation === undefined || value.invocation === null ? {} :
      { invocation: parseEffectView(value.invocation) }) });
}

function persistEvidenceFact(fact: MediaImageEffectEvidenceFact): unknown {
  return { ...fact, evidenceSequence: fact.evidenceSequence.toString(),
    ...(fact.kind === "output" && fact.declaredByteSize !== undefined
      ? { declaredByteSize: fact.declaredByteSize.toString() } : {}) };
}

function parseEvidenceFact(value: unknown): MediaImageEffectEvidenceFact {
  if (!record(value) || typeof value.evidenceSequence !== "string" || typeof value.kind !== "string" ||
      !["outcome", "usage", "output"].includes(value.kind) || typeof value.evidenceRef !== "string" ||
      typeof value.evidenceDigest !== "string" || typeof value.recordedAt !== "string") {
    throw new Error("MEDIA_GATEWAY_EVIDENCE_INVALID");
  }
  const base = { evidenceSequence: integer(value.evidenceSequence, "MEDIA_GATEWAY_EVIDENCE_INVALID"),
    evidenceRef: value.evidenceRef, evidenceDigest: value.evidenceDigest, recordedAt: value.recordedAt };
  if (value.kind !== "output") return Object.freeze({ ...base, kind: value.kind as "outcome" | "usage" });
  if (typeof value.candidateOrdinal !== "number" || typeof value.candidateRef !== "string" ||
      typeof value.stableOutputSlotRef !== "string" || typeof value.outputEvidenceRef !== "string" ||
      typeof value.outputEvidenceDigest !== "string" || typeof value.mediaType !== "string" ||
      !["image/png", "image/jpeg", "image/webp"].includes(value.mediaType) ||
      typeof value.width !== "number" || typeof value.height !== "number") {
    throw new Error("MEDIA_GATEWAY_EVIDENCE_INVALID");
  }
  return Object.freeze({ ...base, kind: "output" as const, candidateOrdinal: value.candidateOrdinal,
    candidateRef: value.candidateRef, stableOutputSlotRef: value.stableOutputSlotRef,
    outputEvidenceRef: value.outputEvidenceRef, outputEvidenceDigest: value.outputEvidenceDigest,
    mediaType: value.mediaType as "image/png" | "image/jpeg" | "image/webp", width: value.width,
    height: value.height,
    ...(typeof value.declaredByteSize === "string"
      ? { declaredByteSize: integer(value.declaredByteSize, "MEDIA_GATEWAY_EVIDENCE_INVALID") } : {}) });
}

function parseEvidenceCheckpoint(value: unknown): MediaImageSagaCheckpoint["evidence"] {
  if (!record(value) || typeof value.nextEvidenceSequence !== "string" || typeof value.caughtUp !== "boolean" ||
      !Array.isArray(value.facts)) throw new Error("MEDIA_GATEWAY_EVIDENCE_CHECKPOINT_INVALID");
  const nextEvidenceSequence = unsignedInteger(value.nextEvidenceSequence,
    "MEDIA_GATEWAY_EVIDENCE_CHECKPOINT_INVALID");
  const facts = value.facts.map(parseEvidenceFact);
  return Object.freeze({ nextEvidenceSequence, caughtUp: value.caughtUp, facts: Object.freeze(facts),
    ...(typeof value.logicalInvocationRef === "string" ? { logicalInvocationRef: value.logicalInvocationRef } : {}) });
}

function persistArtifactReceipt(receipt: ArtifactReadyReceipt | ArtifactStagedReceipt): unknown {
  return { ...receipt, ownerScope: { ...receipt.ownerScope,
    subjectGeneration: receipt.ownerScope.subjectGeneration.toString() }, byteSize: receipt.byteSize.toString() };
}

function parseStagedReceipt(value: unknown): ArtifactStagedReceipt {
  if (!record(value) || value.state !== "staged" || typeof value.stagedObjectRef !== "string") {
    throw new Error("MEDIA_SAGA_CHECKPOINT_INVALID");
  }
  const common = parseArtifactReceiptCommon(value);
  return Object.freeze({ ...common, state: "staged" as const, stagedObjectRef: value.stagedObjectRef });
}

function parseReadyReceipt(value: unknown): ArtifactReadyReceipt {
  if (!record(value) || value.state !== "ready_private" || typeof value.readyObjectRef !== "string" ||
      typeof value.trustDecisionRef !== "string" || !record(value.stagedCleanup) ||
      (value.stagedCleanup.state !== "completed" && value.stagedCleanup.state !== "pending")) {
    throw new Error("MEDIA_SAGA_CHECKPOINT_INVALID");
  }
  const stagedCleanup = value.stagedCleanup.state === "completed"
    ? Object.freeze({ state: "completed" as const })
    : typeof value.stagedCleanup.stagedObjectRef === "string"
      ? Object.freeze({ state: "pending" as const, stagedObjectRef: value.stagedCleanup.stagedObjectRef })
      : (() => { throw new Error("MEDIA_SAGA_CHECKPOINT_INVALID"); })();
  return Object.freeze({ ...parseArtifactReceiptCommon(value), state: "ready_private" as const,
    readyObjectRef: value.readyObjectRef, trustDecisionRef: value.trustDecisionRef, stagedCleanup });
}

function parseArtifactReceiptCommon(value: Record<string, unknown>) {
  if (!record(value.ownerScope) || typeof value.ownerScope.siteRef !== "string" ||
      typeof value.ownerScope.subjectRef !== "string" || typeof value.ownerScope.subjectGeneration !== "string" ||
      typeof value.ownerScope.projectRef !== "string" || typeof value.artifactRef !== "string" ||
      typeof value.artifactVersionRef !== "string" || typeof value.contentSha256 !== "string" ||
      typeof value.byteSize !== "string" || typeof value.mediaType !== "string" ||
      !["image/png", "image/jpeg", "image/webp"].includes(value.mediaType)) {
    throw new Error("MEDIA_SAGA_CHECKPOINT_INVALID");
  }
  return { ownerScope: Object.freeze({ siteRef: value.ownerScope.siteRef,
    subjectRef: value.ownerScope.subjectRef,
    subjectGeneration: integer(value.ownerScope.subjectGeneration, "MEDIA_SAGA_CHECKPOINT_INVALID"),
    projectRef: value.ownerScope.projectRef }), artifactRef: value.artifactRef,
    artifactVersionRef: value.artifactVersionRef, contentSha256: value.contentSha256,
    byteSize: integer(value.byteSize, "MEDIA_SAGA_CHECKPOINT_INVALID"),
    mediaType: value.mediaType as "image/png" | "image/jpeg" | "image/webp" };
}

function parseTrustDecision(value: unknown): ArtifactTrustDecision {
  if (!record(value) || (value.kind !== "allow" && value.kind !== "restrict") ||
      typeof value.decisionRef !== "string" || typeof value.contentSha256 !== "string") {
    throw new Error("MEDIA_SAGA_CHECKPOINT_INVALID");
  }
  return value.kind === "allow"
    ? Object.freeze({ kind: value.kind, decisionRef: value.decisionRef, contentSha256: value.contentSha256 })
    : typeof value.reasonCode === "string"
      ? Object.freeze({ kind: value.kind, decisionRef: value.decisionRef,
          contentSha256: value.contentSha256, reasonCode: value.reasonCode })
      : (() => { throw new Error("MEDIA_SAGA_CHECKPOINT_INVALID"); })();
}

function persistTerminalClosure(closure: MediaImageTerminalClosure): unknown {
  return { ...closure, receipts: { ...closure.receipts,
    artifactFinalizationReceiptRefs: [...closure.receipts.artifactFinalizationReceiptRefs] } };
}

function parseFinancialSettlement(value: unknown): MediaImageFinancialSettlement {
  if (!record(value) || value.kind !== "settled" || typeof value.financialReceiptRef !== "string" ||
      typeof value.allocationClosureReceiptRef !== "string" || typeof value.actualCost !== "string" ||
      typeof value.refundedCredit !== "string" || typeof value.unit !== "string" ||
      !/^(0|[1-9][0-9]{0,37})$/u.test(value.actualCost) ||
      !/^(0|[1-9][0-9]{0,37})$/u.test(value.refundedCredit) ||
      (value.usageSettlementReceiptRef !== undefined && value.usageSettlementReceiptRef !== null &&
       typeof value.usageSettlementReceiptRef !== "string")) {
    throw new Error("MEDIA_FINANCIAL_SETTLEMENT_INVALID");
  }
  for (const candidate of [value.financialReceiptRef, value.allocationClosureReceiptRef, value.unit]) {
    reference(candidate, "MEDIA_FINANCIAL_SETTLEMENT_INVALID");
  }
  return Object.freeze({ kind: "settled" as const,
    financialReceiptRef: value.financialReceiptRef,
    allocationClosureReceiptRef: value.allocationClosureReceiptRef,
    actualCost: value.actualCost, refundedCredit: value.refundedCredit, unit: value.unit,
    ...(typeof value.usageSettlementReceiptRef === "string"
      ? { usageSettlementReceiptRef: value.usageSettlementReceiptRef } : {}) });
}

function parseCandidates(value: unknown): readonly Readonly<{
  candidateRef: string; stableOutputSlotRef: string; artifactRef: string; artifactVersionRef: string;
  outputAccessCommandRef: string; outputAccessRequestFingerprint: string; ordinal: number;
}>[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) throw new Error("MEDIA_WORKER_TASK_INVALID");
  return Object.freeze(value.map((raw, index) => {
    if (!record(raw) || typeof raw.candidateRef !== "string" || typeof raw.stableOutputSlotRef !== "string" ||
        typeof raw.artifactRef !== "string" ||
        typeof raw.artifactVersionRef !== "string" || typeof raw.outputAccessCommandRef !== "string" ||
        typeof raw.outputAccessRequestFingerprint !== "string" ||
        !DIGEST.test(raw.outputAccessRequestFingerprint) || raw.ordinal !== index + 1) {
      throw new Error("MEDIA_WORKER_TASK_INVALID");
    }
    return Object.freeze({ candidateRef: raw.candidateRef, stableOutputSlotRef: raw.stableOutputSlotRef,
      artifactRef: raw.artifactRef, artifactVersionRef: raw.artifactVersionRef,
      outputAccessCommandRef: raw.outputAccessCommandRef,
      outputAccessRequestFingerprint: raw.outputAccessRequestFingerprint, ordinal: raw.ordinal });
  }));
}

function parseSourceGrants(value: unknown): readonly Readonly<{
  sourceVersionRef: string; capabilityEnvelope: unknown; handleDigest: string; expiresAt: string; bindingRef: string;
}>[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error("MEDIA_SOURCE_GRANTS_INVALID");
  return Object.freeze(value.map((raw) => {
    if (!record(raw) || typeof raw.sourceVersionRef !== "string" || raw.capabilityEnvelope === undefined ||
        typeof raw.handleDigest !== "string" || !DIGEST.test(raw.handleDigest) ||
        typeof raw.expiresAt !== "string" || typeof raw.bindingRef !== "string") {
      throw new Error("MEDIA_SOURCE_GRANTS_INVALID");
    }
    reference(raw.sourceVersionRef, "MEDIA_SOURCE_GRANTS_INVALID");
    return Object.freeze({ sourceVersionRef: raw.sourceVersionRef, capabilityEnvelope: raw.capabilityEnvelope,
      handleDigest: raw.handleDigest, expiresAt: raw.expiresAt, bindingRef: raw.bindingRef });
  }));
}

function requiredNullableRef(value: string | null, code: string): string {
  if (value === null) throw new Error(code); reference(value, code); return value;
}
function requiredNullableDigest(value: string | null, code: string): string {
  if (value === null || !DIGEST.test(value)) throw new Error(code); return value;
}

function fence(task: MediaImageWorkerTask): LeaseFence {
  return Object.freeze({ taskRef: task.taskRef, operationRef: task.operationRef,
    leaseEpoch: task.leaseEpoch, leaseTokenHash: digest(task.leaseToken) });
}
function requiredCancelCommand(task: MediaImageWorkerTask) {
  if (task.cancelEffectCommand === undefined) throw new Error("MEDIA_CANCEL_COMMAND_MISSING");
  return task.cancelEffectCommand;
}
function aspectRatio(value: CanonicalImageAspectRatio): MediaImageWorkerTask["request"]["aspectRatio"] {
  const values = ["", "square_1_1", "landscape_4_3", "landscape_16_9", "portrait_3_4", "portrait_9_16"] as const;
  const result = values[value]; if (result === undefined || result === "") throw new Error("MEDIA_WORKER_INPUT_INVALID");
  return result;
}
function outputFormat(value: CanonicalImageOutputFormat): MediaImageWorkerTask["request"]["outputFormat"] {
  const values = ["", "png", "jpeg", "webp"] as const;
  const result = values[value]; if (result === undefined || result === "") throw new Error("MEDIA_WORKER_INPUT_INVALID");
  return result;
}
function leaseSecondsFromMs(value: number): number {
  if (!Number.isInteger(value) || value < 1_000 || value > 300_000 || value % 1_000 !== 0) {
    throw new Error("MEDIA_WORKER_LEASE_INVALID");
  }
  return value / 1_000;
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function digestBytes(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function exactBase64(value: Uint8Array): string { return Buffer.from(value).toString("base64"); }
function requestHash(value: string): void {
  if (!DIGEST.test(value)) throw new Error("MEDIA_EFFECT_REQUEST_DIGEST_INVALID");
}
function opaqueLeaseToken(value: string): void {
  if (value.length < 32 || value.length > 256 || value.trim() !== value) throw new Error("MEDIA_WORKER_LEASE_TOKEN_INVALID");
}
function errorCode(value: string): void {
  if (!/^[A-Z][A-Z0-9_.:-]{2,127}$/u.test(value)) throw new Error("MEDIA_WORKER_ERROR_CODE_INVALID");
}
function integer(value: bigint | string, code: string): bigint {
  let parsed: bigint; try { parsed = BigInt(value); } catch { throw new Error(code); }
  if (parsed < 1n || parsed > 9_223_372_036_854_775_807n) throw new Error(code); return parsed;
}
function unsignedInteger(value: bigint | string, code: string): bigint {
  let parsed: bigint; try { parsed = BigInt(value); } catch { throw new Error(code); }
  if (parsed < 0n || parsed > 18_446_744_073_709_551_615n) throw new Error(code); return parsed;
}
function instant(value: string, code: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(code);
}
function reference(value: string, code: string): void {
  if (value.length < 1 || value.length > 256 || value.trim() !== value) throw new Error(code);
}
function requiredRef(value: string, code: string): string {
  reference(value, code);
  return value;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function optionalRef(value: Record<string, unknown>, key: string): Record<string, string> {
  const candidate = value[key];
  if (candidate === null || candidate === undefined) return {};
  if (typeof candidate !== "string") throw new Error("MEDIA_SAGA_CHECKPOINT_INVALID");
  return { [key]: candidate };
}
function optionalEvidence(
  value: Record<string, unknown>,
  key: "canonicalOutcomeEvidence" | "usageEvidence",
): Partial<Record<typeof key, Readonly<{ ref: string; digest: string }>>> {
  const candidate = value[key];
  if (candidate === null || candidate === undefined) return {};
  if (!record(candidate) || typeof candidate.ref !== "string" || typeof candidate.digest !== "string" ||
      !DIGEST.test(candidate.digest)) throw new Error("MEDIA_EFFECT_VIEW_INVALID");
  return { [key]: Object.freeze({ ref: candidate.ref, digest: candidate.digest }) };
}
