import { createHash, timingSafeEqual } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  AgentImageSubmissionFingerprintInputV1Schema,
  type AgentImageIntentV1,
} from "../../../interfaces/connect/generated-media-runtime/kokoro/platform/media/v1/media_runtime_pb.js";
import {
  CanonicalImageAspectRatio,
  CanonicalImageOutputFormat,
} from "../../../interfaces/connect/generated-media-runtime/kokoro/platform/media/v1/media_canonical_pb.js";
import type { CanonicalMediaOperationInputV1 } from
  "../../../interfaces/http/generated/platform-public/media-canonical.js";
import {
  canonicalMediaOperationInputV1Bytes,
  mediaCallerRequestFingerprintSha256,
} from "../../../interfaces/http/generated/platform-public/media-canonical.js";
import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";
import {
  createMediaOperationPlan,
  transitionMediaOperation,
  transitionMediaStep,
  type MediaOperationPlan,
} from "../domain/media-operation.js";
import { compiledOperationDefinitionRevision } from "../domain/operation-definition.js";
import {
  mediaCandidateRef,
  mediaOperationRef,
  mediaStepRef,
  operationDefinitionRevisionRef,
  operationInputRevisionRef,
} from "../domain/references.js";
import {
  deriveMediaOwnerRequestDigest,
  type EnvelopeOperationInputProtector,
  type MediaOperationOwnerBinding,
  type ProtectedOperationInputRevision,
} from "./operation-input-protection.js";

const FINGERPRINT = /^[0-9a-f]{64}$/u;

export interface MediaImageAdmissionOwnerPort {
  resolveDirectStudio(input: Readonly<{
    caller: Readonly<{ sessionGrant: string }>;
    commandRef: string;
    request: CanonicalMediaOperationInputV1;
  }>, signal: AbortSignal): Promise<Readonly<{
    ownerBinding: MediaOperationOwnerBinding;
    executionBudgetRootRef: string;
    parentAllocationRef: string;
    maximumCredit: bigint;
    trustInputDecisionRef: string;
    expectedParentRevision: bigint;
    expectedParentAllocationEpoch: bigint;
    consumptionScope: Readonly<{ surfaceRef: string; capabilityKey: string; agentRef: string | null }>;
    expiresAt: string;
  }>>;
}

export type MediaImageAdmissionFacts = Readonly<{
  ownerBinding: MediaOperationOwnerBinding;
  executionBudgetRootRef: string;
  parentAllocationRef: string;
  maximumCredit: bigint;
  trustInputDecisionRef: string;
  expectedParentRevision: bigint;
  expectedParentAllocationEpoch: bigint;
  consumptionScope: Readonly<{
    surfaceRef: string;
    capabilityKey: string;
    agentRef: string | null;
  }>;
  expiresAt: string;
  agentCommandAuthorization?: Readonly<{
    accessAuthorizationHandleDigest: string;
    projectionReservationDigest: string;
  }> | undefined;
}>;

export interface AgentImageAccessOwnerPort {
  resolveAgentImage(input: Readonly<{
    mediaAccessHandle: string;
    mediaProjectionReservationHandle: string;
    stableOutputSlotRef: string;
    agentMediaCommandRef: string;
    imageIntent: AgentImageIntentV1;
  }>, signal: AbortSignal): Promise<MediaImageAdmissionFacts>;
}

/** Same-process Platform Credit owner. Implementations must use the supplied transaction. */
export interface MediaImageLocalCreditAllocationOwner {
  deriveChild(transaction: PlatformTransaction, input: Readonly<{
    ownerBinding: MediaOperationOwnerBinding;
    executionBudgetRootRef: string;
    parentAllocationRef: string;
    expectedParentRevision: bigint;
    expectedParentAllocationEpoch: bigint;
    consumptionScope: Readonly<{
      surfaceRef: string;
      capabilityKey: string;
      agentRef: string | null;
    }>;
    expiresAt: string;
    mediaOperationRef: string;
    commandRef: string;
    ownerRequestDigest: string;
    exactCeiling: bigint;
  }>): Promise<Readonly<{
    childAllocationRef: string;
    allocationReservationReceiptRef: string;
  }>>;
}

export type MediaImageCommandIdentity = Readonly<{
  callerAudience: string;
  siteRef: string;
  subjectRef: string;
  subjectGeneration: bigint;
  projectRef: string;
  workloadRef: string;
  source: "direct_studio" | "agent_runtime";
  definitionRevisionRef: string;
  modelOptionRevisionRef: string;
  commandRef: string;
  agentCommandAuthorization?: Readonly<{
    accessAuthorizationHandleDigest: string;
    projectionReservationDigest: string;
  }> | undefined;
}>;

export type MediaImageOperationRecord = Readonly<{
  command: MediaImageCommandIdentity & Readonly<{
    callerRequestFingerprint: string;
    ownerRequestDigest: string;
  }>;
  ownerBinding: MediaOperationOwnerBinding;
  protectedInput: ProtectedOperationInputRevision;
  definitionPolicy: Readonly<{
    partialCompletion: "allowed" | "forbidden";
    minimumReadyCandidates: number;
  }>;
  plan: MediaOperationPlan;
  modelInvocationCommandRefs: readonly string[];
  artifactRefs: readonly string[];
  artifactVersionRefs: readonly string[];
  credit: Readonly<{
    executionBudgetRootRef: string;
    parentAllocationRef: string;
    childAllocationRef: string;
    allocationReservationReceiptRef: string;
  }>;
  trustInputDecisionRef: string;
  dispatchOutbox: Readonly<{
    outboxRef: string;
    topic: "media.image.dispatch.v1";
    operationRef: string;
    state: "pending";
    occurredAt: string;
  }>;
  createdAt: string;
}>;

export type MediaImageCommandBegin =
  | Readonly<{ kind: "started"; leaseToken: string; receipt: MediaCommandDurableReceipt }>
  | Readonly<{ kind: "replayed"; operationRef: string; callerRequestFingerprint: string;
    receipt: MediaCommandDurableReceipt }>;

export type MediaCommandDurableReceipt = Readonly<{
  version: bigint;
  recordedAt: string;
  commandKind: "create_agent_image_operation";
  outcome: "submit_outcome_unknown" | "submit_accepted";
}>;

export interface MediaImageOperationRepository {
  begin(transaction: PlatformTransaction, command: MediaImageCommandIdentity & Readonly<{
    callerRequestFingerprint: string;
    ownerRequestDigest: string;
  }>): Promise<MediaImageCommandBegin>;
  complete(transaction: PlatformTransaction, leaseToken: string,
    record: MediaImageOperationRecord): Promise<MediaCommandDurableReceipt>;
}

export interface MediaImageUnitOfWork {
  execute<Result>(
    binding: MediaOperationOwnerBinding,
    work: (transaction: PlatformTransaction) => Promise<Result>,
  ): Promise<Result>;
}

type MediaImageReferenceKind = "media-operation" | "media-input-revision" | "media-step" |
  "media-candidate" | "model-invocation-command" | "artifact" | "artifact-version" |
  "media-dispatch-outbox";

export class ImageOperationSubmissionService {
  readonly #dependencies: Readonly<{
    admission: MediaImageAdmissionOwnerPort;
    agentAccess?: AgentImageAccessOwnerPort | undefined;
    credit: MediaImageLocalCreditAllocationOwner;
    repository: MediaImageOperationRepository;
    inputProtector: EnvelopeOperationInputProtector;
    ownerDigestKey: Uint8Array;
    unitOfWork: MediaImageUnitOfWork;
    reference: (kind: MediaImageReferenceKind) => string;
    clock: () => Date;
  }>;

  constructor(input: Readonly<{
    admission: MediaImageAdmissionOwnerPort;
    agentAccess?: AgentImageAccessOwnerPort | undefined;
    credit: MediaImageLocalCreditAllocationOwner;
    repository: MediaImageOperationRepository;
    inputProtector: EnvelopeOperationInputProtector;
    ownerDigestKey: Uint8Array;
    unitOfWork: MediaImageUnitOfWork;
    reference: (kind: MediaImageReferenceKind) => string;
    clock?: () => Date;
  }>) {
    if (input.ownerDigestKey.byteLength !== 32) throw new Error("MEDIA_OWNER_DIGEST_KEY_INVALID");
    this.#dependencies = Object.freeze({
      ...input,
      ownerDigestKey: new Uint8Array(input.ownerDigestKey),
      clock: input.clock ?? (() => new Date()),
    });
  }

  async submitDirectStudio(input: Readonly<{
    caller: Readonly<{ sessionGrant: string }>;
    callerAudience: string;
    commandRef: string;
    callerRequestFingerprint: string;
    request: CanonicalMediaOperationInputV1;
    signal: AbortSignal;
  }>): Promise<Readonly<{
    kind: "created" | "replayed";
    operationRef: string;
    callerRequestFingerprint: string;
    receipt: MediaCommandDurableReceipt;
  }>> {
    reference(input.callerAudience);
    reference(input.commandRef);
    if (!FINGERPRINT.test(input.callerRequestFingerprint)) {
      throw new Error("MEDIA_CALLER_FINGERPRINT_INVALID");
    }
    const canonicalBytes = canonicalMediaOperationInputV1Bytes(input.request);
    const recomputedFingerprint = await mediaCallerRequestFingerprintSha256(input.request);
    if (!digestEqual(recomputedFingerprint, input.callerRequestFingerprint)) {
      throw new Error("MEDIA_CALLER_FINGERPRINT_MISMATCH");
    }
    const admission = await this.#dependencies.admission.resolveDirectStudio({
      caller: input.caller,
      commandRef: input.commandRef,
      request: input.request,
    }, boundedSignal(input.signal, 5_000));
    assertAdmissionMatchesRequest(admission, input.request);
    return this.#submitOwned({ callerAudience: input.callerAudience, commandRef: input.commandRef,
      callerRequestFingerprint: recomputedFingerprint, request: input.request, canonicalBytes, admission });
  }

  async submitAgentImage(input: Readonly<{
    mediaAccessHandle: string;
    mediaProjectionReservationHandle: string;
    stableOutputSlotRef: string;
    agentMediaCommandRef: string;
    callerRequestFingerprint: string;
    imageIntent: AgentImageIntentV1;
    signal: AbortSignal;
  }>): Promise<Readonly<{
    kind: "created" | "replayed";
    operationRef: string;
    callerRequestFingerprint: string;
    receipt: MediaCommandDurableReceipt;
  }>> {
    const agentAccess = this.#dependencies.agentAccess;
    if (agentAccess === undefined) throw new Error("MEDIA_AGENT_ACCESS_OWNER_REQUIRED");
    opaqueHandle(input.mediaAccessHandle);
    opaqueHandle(input.mediaProjectionReservationHandle);
    for (const value of [input.stableOutputSlotRef, input.agentMediaCommandRef]) reference(value, 8192);
    if (!FINGERPRINT.test(input.callerRequestFingerprint)) throw new Error("MEDIA_CALLER_FINGERPRINT_INVALID");
    const recomputedFingerprint = agentImageCallerRequestFingerprint({
      stableOutputSlotRef: input.stableOutputSlotRef,
      imageIntent: input.imageIntent,
    });
    if (!digestEqual(recomputedFingerprint, input.callerRequestFingerprint)) {
      throw new Error("MEDIA_CALLER_FINGERPRINT_MISMATCH");
    }
    const admission = await agentAccess.resolveAgentImage({
      mediaAccessHandle: input.mediaAccessHandle,
      mediaProjectionReservationHandle: input.mediaProjectionReservationHandle,
      stableOutputSlotRef: input.stableOutputSlotRef,
      agentMediaCommandRef: input.agentMediaCommandRef,
      imageIntent: input.imageIntent,
    }, boundedSignal(input.signal, 5_000));
    if (admission.ownerBinding.source !== "agent_runtime") {
      throw new Error("MEDIA_ADMISSION_OWNER_BINDING_INVALID");
    }
    const request = canonicalRequestFromAgentIntent(input.imageIntent, admission);
    const canonicalBytes = canonicalMediaOperationInputV1Bytes(request);
    return this.#submitOwned({ callerAudience: "ga.media-runtime", commandRef: input.agentMediaCommandRef,
      callerRequestFingerprint: recomputedFingerprint, request, canonicalBytes, admission });
  }

  #submitOwned(input: Readonly<{
    callerAudience: string;
    commandRef: string;
    callerRequestFingerprint: string;
    request: CanonicalMediaOperationInputV1;
    canonicalBytes: Uint8Array;
    admission: MediaImageAdmissionFacts;
  }>): Promise<Readonly<{
    kind: "created" | "replayed";
    operationRef: string;
    callerRequestFingerprint: string;
    receipt: MediaCommandDurableReceipt;
  }>> {
    const admission = input.admission;
    const canonicalBytes = input.canonicalBytes;
    const ownerRequestDigest = deriveMediaOwnerRequestDigest({
      ownerDigestKey: this.#dependencies.ownerDigestKey,
      canonicalBytes,
      ownerBinding: admission.ownerBinding,
    }).ownerRequestDigest;
    const command = Object.freeze({
      callerAudience: input.callerAudience,
      siteRef: admission.ownerBinding.siteRef,
      subjectRef: admission.ownerBinding.subjectRef,
      subjectGeneration: admission.ownerBinding.subjectGeneration,
      projectRef: admission.ownerBinding.projectRef,
      workloadRef: admission.ownerBinding.workloadRef,
      source: admission.ownerBinding.source,
      definitionRevisionRef: admission.ownerBinding.definitionRevisionRef,
      modelOptionRevisionRef: admission.ownerBinding.modelOptionRevisionRef,
      commandRef: input.commandRef,
      callerRequestFingerprint: input.callerRequestFingerprint,
      ownerRequestDigest,
      ...(admission.agentCommandAuthorization === undefined
        ? {} : { agentCommandAuthorization: admission.agentCommandAuthorization }),
    });
    return this.#dependencies.unitOfWork.execute(admission.ownerBinding, async (transaction) => {
      const begun = await this.#dependencies.repository.begin(transaction, command);
      if (begun.kind === "replayed") return begun;
      const operationRefValue = this.#dependencies.reference("media-operation");
      const inputRevisionRefValue = this.#dependencies.reference("media-input-revision");
      const stepRefValue = this.#dependencies.reference("media-step");
      const modelInvocationCommandRef = this.#dependencies.reference("model-invocation-command");
      const candidates = Array.from({ length: input.request.candidateCount }, (_, index) => ({
        outputSlot: `image-${index + 1}`,
        candidateRef: this.#dependencies.reference("media-candidate"),
        artifactRef: this.#dependencies.reference("artifact"),
        artifactVersionRef: this.#dependencies.reference("artifact-version"),
      }));
      const definition = compiledOperationDefinitionRevision({
        definitionRevisionRef: operationDefinitionRevisionRef(input.request.definitionRevisionRef),
        partialCompletion: input.request.candidateCount === 1 ? "forbidden" : "allowed",
        minimumReadyCandidates: 1,
        steps: [{ definitionStepKey: "generate", required: true,
          candidateSlots: candidates.map((candidate, index) => ({
            outputSlot: candidate.outputSlot,
            required: index === 0,
          })) }],
      });
      const allocatedPlan = createMediaOperationPlan({
        operationRef: mediaOperationRef(operationRefValue),
        operationInputRevisionRef: operationInputRevisionRef(inputRevisionRefValue),
        definition,
        steps: [{ definitionStepKey: "generate", stepRef: mediaStepRef(stepRefValue) }],
        candidates: candidates.map((candidate) => ({ definitionStepKey: "generate",
          outputSlot: candidate.outputSlot, candidateRef: mediaCandidateRef(candidate.candidateRef) })),
      });
      const authorizedOperation = transitionMediaOperation({ operation: allocatedPlan.operation,
        expectedVersion: 1n, nextState: Object.freeze({ kind: "authorized" as const }) });
      const queuedOperation = transitionMediaOperation({ operation: authorizedOperation,
        expectedVersion: 2n, nextState: Object.freeze({ kind: "queued" as const }) });
      const plan: MediaOperationPlan = Object.freeze({
        operation: queuedOperation,
        steps: Object.freeze(allocatedPlan.steps.map((step) => transitionMediaStep({
          step, expectedVersion: 1n, nextState: Object.freeze({ kind: "ready" as const }),
        }))),
        candidates: allocatedPlan.candidates,
      });
      const protectedInput = this.#dependencies.inputProtector.protect({
        operationInputRevisionRef: inputRevisionRefValue,
        ownerBinding: admission.ownerBinding,
        canonicalBytes,
      });
      const credit = await this.#dependencies.credit.deriveChild(transaction, {
        ownerBinding: admission.ownerBinding,
        executionBudgetRootRef: admission.executionBudgetRootRef,
        parentAllocationRef: admission.parentAllocationRef,
        expectedParentRevision: admission.expectedParentRevision,
        expectedParentAllocationEpoch: admission.expectedParentAllocationEpoch,
        consumptionScope: admission.consumptionScope,
        expiresAt: admission.expiresAt,
        mediaOperationRef: operationRefValue,
        commandRef: input.commandRef,
        ownerRequestDigest,
        exactCeiling: admission.maximumCredit,
      });
      const createdAt = this.#date().toISOString();
      const record = Object.freeze({
        command,
        ownerBinding: admission.ownerBinding,
        protectedInput,
        definitionPolicy: Object.freeze({ partialCompletion: definition.partialCompletion,
          minimumReadyCandidates: definition.minimumReadyCandidates }),
        plan,
        modelInvocationCommandRefs: Object.freeze([modelInvocationCommandRef]),
        artifactRefs: Object.freeze(candidates.map((item) => item.artifactRef)),
        artifactVersionRefs: Object.freeze(candidates.map((item) => item.artifactVersionRef)),
        credit: Object.freeze({ executionBudgetRootRef: admission.executionBudgetRootRef,
          parentAllocationRef: admission.parentAllocationRef, ...credit }),
        trustInputDecisionRef: admission.trustInputDecisionRef,
        dispatchOutbox: Object.freeze({
          outboxRef: this.#dependencies.reference("media-dispatch-outbox"),
          topic: "media.image.dispatch.v1" as const,
          operationRef: operationRefValue,
          state: "pending" as const,
          occurredAt: createdAt,
        }),
        createdAt,
      });
      const receipt = await this.#dependencies.repository.complete(transaction, begun.leaseToken, record);
      return Object.freeze({ kind: "created" as const, operationRef: operationRefValue,
        callerRequestFingerprint: input.callerRequestFingerprint, receipt });
    });
  }

  #date(): Date {
    const value = this.#dependencies.clock();
    if (!Number.isFinite(value.getTime())) throw new Error("MEDIA_CLOCK_INVALID");
    return value;
  }
}

/** Deterministic repository for tests/local development. Production composition must reject it. */
export class InMemoryMediaImageOperationRepository implements MediaImageOperationRepository {
  readonly developmentOnly = true as const;
  readonly #commands = new Map<string, Readonly<{
    callerRequestFingerprint: string;
    ownerRequestDigest: string;
    leaseToken: string;
    operationRef?: string | undefined;
    receipt: MediaCommandDurableReceipt;
  }>>();
  readonly #records = new Map<string, MediaImageOperationRecord>();
  #serial = 0;

  async begin(_transaction: PlatformTransaction, command: Parameters<MediaImageOperationRepository["begin"]>[1]) {
    const key = commandKey(command);
    const prior = this.#commands.get(key);
    if (prior !== undefined) {
      if (prior.callerRequestFingerprint !== command.callerRequestFingerprint ||
          prior.ownerRequestDigest !== command.ownerRequestDigest) {
        throw new Error("MEDIA_COMMAND_OWNER_DIGEST_CONFLICT");
      }
      if (prior.operationRef === undefined) throw new Error("MEDIA_COMMAND_PENDING");
      return Object.freeze({ kind: "replayed" as const, operationRef: prior.operationRef,
        callerRequestFingerprint: prior.callerRequestFingerprint, receipt: prior.receipt });
    }
    const leaseToken = `media-command-lease:${++this.#serial}`;
    const receipt = durableReceipt(1n, "1970-01-01T00:00:00.000Z", "submit_outcome_unknown");
    this.#commands.set(key, Object.freeze({ callerRequestFingerprint: command.callerRequestFingerprint,
      ownerRequestDigest: command.ownerRequestDigest, leaseToken, receipt }));
    return Object.freeze({ kind: "started" as const, leaseToken, receipt });
  }

  async complete(_transaction: PlatformTransaction, leaseToken: string, record: MediaImageOperationRecord) {
    const key = commandKey(record.command);
    const pending = this.#commands.get(key);
    if (pending?.leaseToken !== leaseToken || pending.operationRef !== undefined) {
      throw new Error("MEDIA_COMMAND_LEASE_LOST");
    }
    const operationRefValue = record.plan.operation.operationRef;
    const receipt = durableReceipt(2n, record.createdAt, "submit_accepted");
    this.#records.set(operationRefValue, record);
    this.#commands.set(key, Object.freeze({ ...pending, operationRef: operationRefValue, receipt }));
    return receipt;
  }

  inspect(operationRefValue: string): MediaImageOperationRecord | undefined {
    return this.#records.get(operationRefValue);
  }
}

function durableReceipt(
  version: bigint,
  recordedAt: string,
  outcome: MediaCommandDurableReceipt["outcome"],
): MediaCommandDurableReceipt {
  return Object.freeze({ version, recordedAt, commandKind: "create_agent_image_operation" as const, outcome });
}

function commandKey(command: MediaImageCommandIdentity): string {
  return [command.callerAudience, command.siteRef, command.subjectRef,
    command.subjectGeneration.toString(), command.projectRef, command.commandRef]
    .map((value) => `${Buffer.byteLength(value)}:${value}`).join("|");
}

function assertAdmissionMatchesRequest(
  admission: Awaited<ReturnType<MediaImageAdmissionOwnerPort["resolveDirectStudio"]>>,
  request: CanonicalMediaOperationInputV1,
): void {
  if (admission.ownerBinding.source !== "direct_studio" ||
      admission.ownerBinding.definitionRevisionRef !== request.definitionRevisionRef ||
      admission.ownerBinding.modelOptionRevisionRef !== request.modelOptionRevisionRef ||
      admission.maximumCredit < 1n) {
    throw new Error("MEDIA_ADMISSION_OWNER_BINDING_INVALID");
  }
  for (const value of [admission.executionBudgetRootRef, admission.parentAllocationRef,
    admission.trustInputDecisionRef]) reference(value);
}

function digestEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

export function agentImageCallerRequestFingerprint(input: Readonly<{
  stableOutputSlotRef: string;
  imageIntent: AgentImageIntentV1;
}>): string {
  const payload = create(AgentImageSubmissionFingerprintInputV1Schema, {
    stableOutputSlotRef: input.stableOutputSlotRef,
    imageIntent: input.imageIntent,
  });
  return createHash("sha256")
    .update("kokoro.platform.media.agent-image-submit.v1\0")
    .update(toBinary(AgentImageSubmissionFingerprintInputV1Schema, payload, { writeUnknownFields: false }))
    .digest("hex");
}

function canonicalRequestFromAgentIntent(
  intent: AgentImageIntentV1,
  admission: MediaImageAdmissionFacts,
): CanonicalMediaOperationInputV1 {
  const aspectRatio = aspectRatioName(intent.aspectRatio);
  const outputFormat = outputFormatName(intent.outputFormat);
  if (!Number.isInteger(intent.candidateCount) || intent.candidateCount < 1 || intent.candidateCount > 4) {
    throw new Error("MEDIA_AGENT_IMAGE_INTENT_INVALID");
  }
  return Object.freeze({
    contractMajor: 1,
    definitionRevisionRef: admission.ownerBinding.definitionRevisionRef,
    kind: "image_text_to_image",
    promptIntent: intent.promptIntent,
    aspectRatio,
    candidateCount: intent.candidateCount as 1 | 2 | 3 | 4,
    modelOptionRevisionRef: admission.ownerBinding.modelOptionRevisionRef,
    outputFormat,
  });
}

function aspectRatioName(value: CanonicalImageAspectRatio): CanonicalMediaOperationInputV1["aspectRatio"] {
  if (value === CanonicalImageAspectRatio.SQUARE_1_1) return "square_1_1";
  if (value === CanonicalImageAspectRatio.LANDSCAPE_4_3) return "landscape_4_3";
  if (value === CanonicalImageAspectRatio.LANDSCAPE_16_9) return "landscape_16_9";
  if (value === CanonicalImageAspectRatio.PORTRAIT_3_4) return "portrait_3_4";
  if (value === CanonicalImageAspectRatio.PORTRAIT_9_16) return "portrait_9_16";
  throw new Error("MEDIA_AGENT_IMAGE_INTENT_INVALID");
}

function outputFormatName(value: CanonicalImageOutputFormat): CanonicalMediaOperationInputV1["outputFormat"] {
  if (value === CanonicalImageOutputFormat.PNG) return "png";
  if (value === CanonicalImageOutputFormat.JPEG) return "jpeg";
  if (value === CanonicalImageOutputFormat.WEBP) return "webp";
  throw new Error("MEDIA_AGENT_IMAGE_INTENT_INVALID");
}

function reference(value: string, maximum = 256): void {
  if (value.length < 1 || value.length > maximum || value.trim() !== value || hasControlCharacter(value)) {
    throw new Error("MEDIA_REFERENCE_INVALID");
  }
}

function opaqueHandle(value: string): void {
  if (value.length < 32 || value.length > 8192 || value.trim() !== value || hasControlCharacter(value)) {
    throw new Error("MEDIA_OPAQUE_HANDLE_INVALID");
  }
}

function boundedSignal(caller: AbortSignal, timeoutMs: number): AbortSignal {
  if (caller.aborted) throw caller.reason ?? new DOMException("Aborted", "AbortError");
  return AbortSignal.any([caller, AbortSignal.timeout(timeoutMs)]);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
