import { timingSafeEqual } from "node:crypto";
import type { CanonicalMediaOperationInputV1 } from
  "../../../interfaces/http/generated/platform-public/media-canonical.js";
import {
  canonicalMediaOperationInputV1Bytes,
  mediaCallerRequestFingerprintSha256,
} from "../../../interfaces/http/generated/platform-public/media-canonical.js";
import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";
import { createMediaOperationPlan, type MediaOperationPlan } from "../domain/media-operation.js";
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
  }>>;
}

export interface MediaImageCreditAllocationPort {
  deriveChild(transaction: PlatformTransaction, input: Readonly<{
    ownerBinding: MediaOperationOwnerBinding;
    executionBudgetRootRef: string;
    parentAllocationRef: string;
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
  commandRef: string;
}>;

export type MediaImageOperationRecord = Readonly<{
  command: MediaImageCommandIdentity & Readonly<{
    callerRequestFingerprint: string;
    ownerRequestDigest: string;
  }>;
  ownerBinding: MediaOperationOwnerBinding;
  protectedInput: ProtectedOperationInputRevision;
  plan: MediaOperationPlan;
  modelInvocationCommandRefs: readonly string[];
  credit: Readonly<{
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
  | Readonly<{ kind: "started"; leaseToken: string }>
  | Readonly<{ kind: "replayed"; operationRef: string; callerRequestFingerprint: string }>;

export interface MediaImageOperationRepository {
  begin(transaction: PlatformTransaction, command: MediaImageCommandIdentity & Readonly<{
    callerRequestFingerprint: string;
    ownerRequestDigest: string;
  }>): Promise<MediaImageCommandBegin>;
  complete(transaction: PlatformTransaction, leaseToken: string, record: MediaImageOperationRecord): Promise<void>;
}

export interface MediaImageUnitOfWork {
  execute<Result>(
    binding: MediaOperationOwnerBinding,
    work: (transaction: PlatformTransaction) => Promise<Result>,
  ): Promise<Result>;
}

type MediaImageReferenceKind = "media-operation" | "media-input-revision" | "media-step" |
  "media-candidate" | "model-invocation-command" | "media-dispatch-outbox";

export class ImageOperationSubmissionService {
  readonly #dependencies: Readonly<{
    admission: MediaImageAdmissionOwnerPort;
    credit: MediaImageCreditAllocationPort;
    repository: MediaImageOperationRepository;
    inputProtector: EnvelopeOperationInputProtector;
    ownerDigestKey: Uint8Array;
    unitOfWork: MediaImageUnitOfWork;
    reference: (kind: MediaImageReferenceKind) => string;
    clock: () => Date;
  }>;

  constructor(input: Readonly<{
    admission: MediaImageAdmissionOwnerPort;
    credit: MediaImageCreditAllocationPort;
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
  }>): Promise<Readonly<{
    kind: "created" | "replayed";
    operationRef: string;
    callerRequestFingerprint: string;
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
    }, AbortSignal.timeout(5_000));
    assertAdmissionMatchesRequest(admission, input.request);
    const ownerRequestDigest = deriveMediaOwnerRequestDigest({
      ownerDigestKey: this.#dependencies.ownerDigestKey,
      canonicalBytes,
      ownerBinding: admission.ownerBinding,
    }).ownerRequestDigest;
    const command = Object.freeze({
      callerAudience: input.callerAudience,
      siteRef: admission.ownerBinding.siteRef,
      subjectRef: admission.ownerBinding.subjectRef,
      commandRef: input.commandRef,
      callerRequestFingerprint: recomputedFingerprint,
      ownerRequestDigest,
    });
    return this.#dependencies.unitOfWork.execute(admission.ownerBinding, async (transaction) => {
      const begun = await this.#dependencies.repository.begin(transaction, command);
      if (begun.kind === "replayed") return begun;
      const operationRefValue = this.#dependencies.reference("media-operation");
      const inputRevisionRefValue = this.#dependencies.reference("media-input-revision");
      const stepRefValue = this.#dependencies.reference("media-step");
      const candidates = Array.from({ length: input.request.candidateCount }, (_, index) => ({
        outputSlot: `image-${index + 1}`,
        candidateRef: this.#dependencies.reference("media-candidate"),
        modelInvocationCommandRef: this.#dependencies.reference("model-invocation-command"),
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
      const plan = createMediaOperationPlan({
        operationRef: mediaOperationRef(operationRefValue),
        operationInputRevisionRef: operationInputRevisionRef(inputRevisionRefValue),
        definition,
        steps: [{ definitionStepKey: "generate", stepRef: mediaStepRef(stepRefValue) }],
        candidates: candidates.map((candidate) => ({ definitionStepKey: "generate",
          outputSlot: candidate.outputSlot, candidateRef: mediaCandidateRef(candidate.candidateRef) })),
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
        plan,
        modelInvocationCommandRefs: Object.freeze(candidates.map((item) => item.modelInvocationCommandRef)),
        credit: Object.freeze({ ...credit }),
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
      await this.#dependencies.repository.complete(transaction, begun.leaseToken, record);
      return Object.freeze({ kind: "created" as const, operationRef: operationRefValue,
        callerRequestFingerprint: recomputedFingerprint });
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
        callerRequestFingerprint: prior.callerRequestFingerprint });
    }
    const leaseToken = `media-command-lease:${++this.#serial}`;
    this.#commands.set(key, Object.freeze({ callerRequestFingerprint: command.callerRequestFingerprint,
      ownerRequestDigest: command.ownerRequestDigest, leaseToken }));
    return Object.freeze({ kind: "started" as const, leaseToken });
  }

  async complete(_transaction: PlatformTransaction, leaseToken: string, record: MediaImageOperationRecord) {
    const key = commandKey(record.command);
    const pending = this.#commands.get(key);
    if (pending?.leaseToken !== leaseToken || pending.operationRef !== undefined) {
      throw new Error("MEDIA_COMMAND_LEASE_LOST");
    }
    const operationRefValue = record.plan.operation.operationRef;
    this.#records.set(operationRefValue, record);
    this.#commands.set(key, Object.freeze({ ...pending, operationRef: operationRefValue }));
  }

  inspect(operationRefValue: string): MediaImageOperationRecord | undefined {
    return this.#records.get(operationRefValue);
  }
}

function commandKey(command: MediaImageCommandIdentity): string {
  return [command.callerAudience, command.siteRef, command.subjectRef, command.commandRef]
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

function reference(value: string): void {
  if (value.length < 1 || value.length > 256 || value.trim() !== value || hasControlCharacter(value)) {
    throw new Error("MEDIA_REFERENCE_INVALID");
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
