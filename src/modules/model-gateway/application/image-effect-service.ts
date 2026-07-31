import { createHash, randomUUID } from "node:crypto";
import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";
import {
  createImageEffectAttempt,
  requestImageEffectCancellation,
  type ImageEffectAttempt,
  type ImageEffectAttemptState,
} from "../domain/image-effect.js";

export type ImageEffectAccessAuthorization = Readonly<{
  callerAccessHandleDigest: string;
  callerIdentity: string;
  siteId: string;
  callerAudience: "platform-media-worker";
  workloadIdentityRef: string;
  environment: string;
  region: string;
  authorizationGeneration: bigint;
  securityEpoch: bigint;
  accessExpiresAt: string;
  sourceGrantClaims: readonly Readonly<{
    sourceVersionRef: string;
    purposeGrantHandleDigest: string;
    expiresAt: string;
  }>[];
  modelOption?: Readonly<{
    authorizationHandleDigest: string;
    modelOptionRevisionRef: string;
    definitionRoleRef: string;
    deploymentRef: string;
    adapterKind: string;
    providerModel: string;
    expiresAt: string;
  }>;
}>;

export type ImageEffectCommandKind = "create" | "cancel" | "attach_attempt" | "output_access";
export type ImageEffectReceiptKind =
  | "create_committed"
  | "definitely_not_submitted"
  | "attempt_authorization_attached"
  | "cancel_intent_committed"
  | "rejected"
  | "outcome_unknown"
  | "output_access_issued";

export type ImageEffectCommandReceiptRecord = Readonly<{
  callerCommandRef: string;
  requestDigest: string;
  kind: ImageEffectReceiptKind;
  logicalInvocationRef: string;
  attemptRef: string;
  attemptOrdinal: number;
  receiptVersion: bigint;
  recordedAt: string;
  receiptRef: string;
  receiptDigest: string;
}>;

export type ImageEffectCommandJournal = Readonly<{
  siteId: string;
  callerIdentity: string;
  callerAccessHandleDigest: string;
  callerCommandRef: string;
  commandKind: ImageEffectCommandKind;
  ownerCommandDigest: string;
  callerRequestFingerprint: string;
  receipt: ImageEffectCommandReceiptRecord;
}>;

export type ImageEffectInvocationState =
  | "accepted"
  | "submitted"
  | "definitely_not_submitted"
  | "submission_unknown"
  | "running"
  | "succeeded"
  | "failed"
  | "cancel_requested"
  | "canceled"
  | "outcome_unknown";

export type ImageEffectInvocation = Readonly<{
  siteId: string;
  callerIdentity: string;
  callerAccessHandleDigest: string;
  modelOptionAuthorizationHandleDigest: string;
  logicalInvocationRef: string;
  modelInvocationCommandRef: string;
  ownerVersion: bigint;
  state: ImageEffectInvocationState;
  definitionRoleRef: string;
  modelOptionRevisionRef: string;
  deploymentRef: string;
  adapterKind: string;
  providerModel: string;
  modelAuthorizationExpiresAt: string;
  operationInputRevisionRef: string;
  operationInputRevisionDigest: string;
  sourceGrantRefs: readonly string[];
  logicalOutputSlots: readonly Readonly<{ candidateRef: string; stableOutputSlotRef: string }>[];
  trustEffectAllowReceiptRef: string;
  trustEffectAllowReceiptDigest: string;
  attempts: readonly ImageEffectAttempt[];
  createdAt: string;
  updatedAt: string;
}>;

export interface ImageEffectUnitOfWork {
  execute<Result>(
    scope: Readonly<{
      operation: "create" | "recover" | "get" | "cancel" | "attach" | "evidence" |
        "issue_output" | "recover_output";
      callerAccessHandle: string;
      modelOptionAuthorizationHandle?: string;
      sourceGrants?: readonly Readonly<{ sourceVersionRef: string; purposeGrantHandle: string }>[];
    }>,
    work: (transaction: PlatformTransaction, authorization: ImageEffectAccessAuthorization) => Promise<Result>,
  ): Promise<Result>;
}

export type ImageEffectBudgetCommitOutcome =
  | Readonly<{
      kind: "accepted" | "replayed";
      effectBudgetCommitRef: string;
      effectBudgetCommitDigest: string;
      attemptOrdinal: number;
      attemptAuthorizationRef: string;
      attemptAuthorizationFenceEpoch: bigint;
      attemptAuthorizationDigest: string;
      expiresAt: string;
    }>
  | Readonly<{ kind: "rejected"; code: string }>;

export interface ImageEffectBudgetCommitAuthority {
  consume(transaction: PlatformTransaction, input: Readonly<{
    siteId: string;
    callerIdentity: string;
    logicalInvocationRef: string;
    modelInvocationCommandRef: string;
    attemptRef: string;
    attemptOrdinal: number;
    effectBudgetCommitRef: string;
    effectBudgetCommitDigest: string;
    modelOptionRevisionRef: string;
    deploymentRef: string;
    operationInputRevisionRef: string;
    operationInputRevisionDigest: string;
    logicalOutputSlots: readonly Readonly<{ candidateRef: string; stableOutputSlotRef: string }>[];
    ownerCommandDigest: string;
  }>): Promise<ImageEffectBudgetCommitOutcome>;
}

export interface ImageEffectRepository {
  lockCommand(transaction: PlatformTransaction, input: Readonly<{
    callerIdentity: string;
    callerCommandRef: string;
  }>): Promise<ImageEffectCommandJournal | null>;
  lockInvocation(transaction: PlatformTransaction, input: Readonly<{
    callerIdentity: string;
    logicalInvocationRef?: string;
    modelInvocationCommandRef?: string;
  }>): Promise<ImageEffectInvocation | null>;
  create(transaction: PlatformTransaction, input: Readonly<{
    journal: ImageEffectCommandJournal;
    invocation: ImageEffectInvocation;
    sourceGrants: readonly Readonly<{ sourceVersionRef: string; purposeGrantHandle: string }>[];
  }>): Promise<void>;
  persistCommand(transaction: PlatformTransaction, input: Readonly<{
    journal: ImageEffectCommandJournal;
    invocation: ImageEffectInvocation;
  }>): Promise<void>;
}

/** Port implemented only by the Root-generated known-field command-envelope helper adapter. */
export interface ImageEffectCommandDigestAuthority {
  create(input: CreateImageEffectCommand, authorization: ImageEffectAccessAuthorization): string;
  cancel(input: Readonly<{
    logicalInvocationRef: string;
    expectedInvocationVersion: bigint;
  }>, authorization: ImageEffectAccessAuthorization): string;
  attach(input: Readonly<{
    modelInvocationCommandRef: string;
    logicalInvocationRef: string;
    definitelyNotSubmittedReceiptRef: string;
    definitelyNotSubmittedReceiptDigest: string;
    nextAttemptOrdinal: number;
    effectBudgetCommitRef: string;
    effectBudgetCommitDigest: string;
  }>, authorization: ImageEffectAccessAuthorization): string;
  issueOutput(input: Readonly<{
    logicalInvocationRef: string;
    outputEvidenceRef: string;
    outputEvidenceDigest: string;
  }>, authorization: ImageEffectAccessAuthorization): string;
  receipt(input: Readonly<{
    callerCommandRef: string;
    requestDigest: string;
    kind: ImageEffectReceiptKind;
    logicalInvocationRef: string;
    attemptRef: string;
    attemptOrdinal: number;
    receiptVersion: bigint;
    recordedAt: string;
  }>): Readonly<{ receiptRef: string; receiptDigest: string }>;
}

export type CreateImageEffectCommand = Readonly<{
  callerAccessHandle: string;
  modelInvocationCommandRef: string;
  callerRequestFingerprint: string;
  definitionRoleRef: string;
  modelOptionAuthorizationHandle: string;
  modelOptionRevisionRef: string;
  operationInputRevisionRef: string;
  operationInputRevisionDigest: string;
  sourceGrants: readonly Readonly<{ sourceVersionRef: string; purposeGrantHandle: string }>[];
  logicalOutputSlots: readonly Readonly<{ candidateRef: string; stableOutputSlotRef: string }>[];
  effectBudgetCommitRef: string;
  effectBudgetCommitDigest: string;
  attemptOrdinal: 1;
  trustEffectAllowReceiptRef: string;
  trustEffectAllowReceiptDigest: string;
}>;

export type ImageEffectView = Readonly<{
  logicalInvocationRef: string;
  modelInvocationCommandRef: string;
  ownerVersion: bigint;
  currentAttemptOrdinal: number;
  attemptAuthorizationRef: string;
  attemptAuthorizationFenceEpoch: bigint;
  attemptAuthorizationDigest: string;
  state: ImageEffectInvocationState;
  canonicalOutcomeEvidenceRef?: string;
  canonicalOutcomeEvidenceDigest?: string;
  usageEvidenceRef?: string;
  usageEvidenceDigest?: string;
  observedAt: string;
}>;

export type ImageEffectCommandResult = Readonly<{
  receipt: ImageEffectCommandReceiptRecord;
  invocation: ImageEffectView;
  replayed: boolean;
}>;

type ReferenceKind = "image-invocation" | "image-attempt" | "image-provider-operation";

export class ImageEffectService {
  readonly #clock: () => Date;
  readonly #reference: (kind: ReferenceKind) => string;

  constructor(private readonly dependencies: Readonly<{
    unitOfWork: ImageEffectUnitOfWork;
    repository: ImageEffectRepository;
    budget: ImageEffectBudgetCommitAuthority;
    commandDigest: ImageEffectCommandDigestAuthority;
    clock?: () => Date;
    reference?: (kind: ReferenceKind) => string;
  }>) {
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#reference = dependencies.reference ?? ((kind) => `${kind}:${randomUUID()}`);
  }

  async create(rawInput: CreateImageEffectCommand): Promise<ImageEffectCommandResult> {
    const input = snapshotCreateCommand(rawInput);
    return this.dependencies.unitOfWork.execute({
      operation: "create",
      callerAccessHandle: input.callerAccessHandle,
      modelOptionAuthorizationHandle: input.modelOptionAuthorizationHandle,
      sourceGrants: input.sourceGrants,
    }, async (transaction, authorization) => {
      const modelOption = this.#assertAuthorization(authorization, input);
      const ownerCommandDigest = verifiedDigest(this.dependencies.commandDigest.create(input, authorization));
      if (input.callerRequestFingerprint !== ownerCommandDigest) {
        throw new Error("IMAGE_EFFECT_CALLER_REQUEST_FINGERPRINT_MISMATCH");
      }
      const prior = await this.dependencies.repository.lockCommand(transaction, {
        callerIdentity: authorization.callerIdentity,
        callerCommandRef: input.modelInvocationCommandRef,
      });
      if (prior !== null) return replayCommand(prior, ownerCommandDigest,
        await this.#requiredInvocation(transaction, authorization.callerIdentity,
          { modelInvocationCommandRef: input.modelInvocationCommandRef }), this.dependencies.commandDigest);

      const now = this.#now().toISOString();
      const logicalInvocationRef = this.#validReference(this.#reference("image-invocation"));
      const attemptRef = this.#validReference(this.#reference("image-attempt"));
      const budget = await this.#commitBudget(transaction, authorization, input, modelOption, {
        ownerCommandDigest,
        logicalInvocationRef,
        attemptRef,
        attemptOrdinal: 1,
        effectBudgetCommitRef: input.effectBudgetCommitRef,
        effectBudgetCommitDigest: input.effectBudgetCommitDigest,
      });
      const attempt = createImageEffectAttempt({
        attemptRef,
        ordinal: 1,
        budgetCommitRef: input.effectBudgetCommitRef,
        budgetCommitDigest: input.effectBudgetCommitDigest,
        attemptAuthorizationRef: budget.attemptAuthorizationRef,
        attemptAuthorizationFenceEpoch: budget.attemptAuthorizationFenceEpoch,
        attemptAuthorizationDigest: budget.attemptAuthorizationDigest,
        providerOperationKey: this.#validReference(this.#reference("image-provider-operation")),
      });
      const invocation: ImageEffectInvocation = Object.freeze({
        siteId: authorization.siteId,
        callerIdentity: authorization.callerIdentity,
        callerAccessHandleDigest: authorization.callerAccessHandleDigest,
        modelOptionAuthorizationHandleDigest: modelOption.authorizationHandleDigest,
        logicalInvocationRef,
        modelInvocationCommandRef: input.modelInvocationCommandRef,
        ownerVersion: 1n,
        state: "accepted",
        definitionRoleRef: input.definitionRoleRef,
        modelOptionRevisionRef: modelOption.modelOptionRevisionRef,
        deploymentRef: modelOption.deploymentRef,
        adapterKind: modelOption.adapterKind,
        providerModel: modelOption.providerModel,
        modelAuthorizationExpiresAt: modelOption.expiresAt,
        operationInputRevisionRef: input.operationInputRevisionRef,
        operationInputRevisionDigest: input.operationInputRevisionDigest,
        sourceGrantRefs: Object.freeze(input.sourceGrants.map((source) => source.sourceVersionRef)),
        logicalOutputSlots: input.logicalOutputSlots,
        trustEffectAllowReceiptRef: input.trustEffectAllowReceiptRef,
        trustEffectAllowReceiptDigest: input.trustEffectAllowReceiptDigest,
        attempts: Object.freeze([attempt]),
        createdAt: now,
        updatedAt: now,
      });
      const journal = journalFor({
        authorization,
        callerCommandRef: input.modelInvocationCommandRef,
        commandKind: "create",
        ownerCommandDigest,
        callerRequestFingerprint: input.callerRequestFingerprint,
        receiptKind: "create_committed",
        invocation,
        attempt,
        recordedAt: now,
      }, this.dependencies.commandDigest);
      await this.dependencies.repository.create(transaction, {
        journal,
        invocation,
        sourceGrants: input.sourceGrants,
      });
      return response(journal, invocation, false, this.dependencies.commandDigest);
    });
  }

  async recover(input: Readonly<{
    callerAccessHandle: string;
    callerCommandRef: string;
  }>): Promise<ImageEffectCommandResult> {
    accessHandle(input.callerAccessHandle);
    reference(input.callerCommandRef);
    return this.dependencies.unitOfWork.execute({
      operation: "recover",
      callerAccessHandle: input.callerAccessHandle,
    }, async (transaction, authorization) => {
      this.#assertCallerAuthorization(authorization, input.callerAccessHandle);
      const journal = await this.dependencies.repository.lockCommand(transaction, {
        callerIdentity: authorization.callerIdentity,
        callerCommandRef: input.callerCommandRef,
      });
      if (journal === null) throw new Error("IMAGE_EFFECT_COMMAND_NOT_FOUND");
      const invocation = await this.#requiredInvocation(transaction, authorization.callerIdentity, {
        logicalInvocationRef: journal.receipt.logicalInvocationRef,
      });
      return response(journal, invocation, true, this.dependencies.commandDigest);
    });
  }

  async get(input: Readonly<{
    callerAccessHandle: string;
    modelInvocationCommandRef: string;
  }>): Promise<ImageEffectView> {
    accessHandle(input.callerAccessHandle);
    reference(input.modelInvocationCommandRef);
    return this.dependencies.unitOfWork.execute({
      operation: "get",
      callerAccessHandle: input.callerAccessHandle,
    }, async (transaction, authorization) => {
      this.#assertCallerAuthorization(authorization, input.callerAccessHandle);
      return view(await this.#requiredInvocation(transaction, authorization.callerIdentity, {
        modelInvocationCommandRef: input.modelInvocationCommandRef,
      }));
    });
  }

  async requestCancel(input: Readonly<{
    callerAccessHandle: string;
    cancelCommandRef: string;
    logicalInvocationRef: string;
    expectedInvocationVersion: bigint;
    callerRequestFingerprint: string;
  }>): Promise<ImageEffectCommandResult> {
    snapshotCancelCommand(input);
    return this.dependencies.unitOfWork.execute({
      operation: "cancel",
      callerAccessHandle: input.callerAccessHandle,
    }, async (transaction, authorization) => {
      this.#assertCallerAuthorization(authorization, input.callerAccessHandle);
      const ownerCommandDigest = verifiedDigest(this.dependencies.commandDigest.cancel({
        logicalInvocationRef: input.logicalInvocationRef,
        expectedInvocationVersion: input.expectedInvocationVersion,
      }, authorization));
      if (input.callerRequestFingerprint !== ownerCommandDigest) {
        throw new Error("IMAGE_EFFECT_CALLER_REQUEST_FINGERPRINT_MISMATCH");
      }
      const prior = await this.dependencies.repository.lockCommand(transaction, {
        callerIdentity: authorization.callerIdentity,
        callerCommandRef: input.cancelCommandRef,
      });
      if (prior !== null) return replayCommand(prior, ownerCommandDigest,
        await this.#requiredInvocation(transaction, authorization.callerIdentity,
          { logicalInvocationRef: prior.receipt.logicalInvocationRef }), this.dependencies.commandDigest);
      const current = await this.#requiredInvocation(transaction, authorization.callerIdentity, {
        logicalInvocationRef: input.logicalInvocationRef,
      });
      if (current.ownerVersion !== input.expectedInvocationVersion) {
        throw new Error("IMAGE_EFFECT_INVOCATION_VERSION_CONFLICT");
      }
      const activeAttempt = currentAttempt(current);
      const changedAttempt = requestImageEffectCancellation(activeAttempt);
      const now = this.#now().toISOString();
      const invocation: ImageEffectInvocation = Object.freeze({
        ...current,
        ownerVersion: current.ownerVersion + 1n,
        state: "cancel_requested",
        attempts: Object.freeze([...current.attempts.slice(0, -1), changedAttempt]),
        updatedAt: now,
      });
      const journal = journalFor({
        authorization,
        callerCommandRef: input.cancelCommandRef,
        commandKind: "cancel",
        ownerCommandDigest,
        callerRequestFingerprint: input.callerRequestFingerprint,
        receiptKind: "cancel_intent_committed",
        invocation,
        attempt: changedAttempt,
        recordedAt: now,
      }, this.dependencies.commandDigest);
      await this.dependencies.repository.persistCommand(transaction, { journal, invocation });
      return response(journal, invocation, false, this.dependencies.commandDigest);
    });
  }

  async attachNextAttemptAuthorization(input: Readonly<{
    callerAccessHandle: string;
    attemptAuthorizationCommandRef: string;
    modelInvocationCommandRef: string;
    logicalInvocationRef: string;
    definitelyNotSubmittedReceiptRef: string;
    definitelyNotSubmittedReceiptDigest: string;
    nextAttemptOrdinal: number;
    effectBudgetCommitRef: string;
    effectBudgetCommitDigest: string;
    callerRequestFingerprint: string;
  }>): Promise<ImageEffectCommandResult> {
    snapshotAttachCommand(input);
    return this.dependencies.unitOfWork.execute({
      operation: "attach",
      callerAccessHandle: input.callerAccessHandle,
    }, async (transaction, authorization) => {
      this.#assertCallerAuthorization(authorization, input.callerAccessHandle);
      const ownerCommandDigest = verifiedDigest(this.dependencies.commandDigest.attach({
        modelInvocationCommandRef: input.modelInvocationCommandRef,
        logicalInvocationRef: input.logicalInvocationRef,
        definitelyNotSubmittedReceiptRef: input.definitelyNotSubmittedReceiptRef,
        definitelyNotSubmittedReceiptDigest: input.definitelyNotSubmittedReceiptDigest,
        nextAttemptOrdinal: input.nextAttemptOrdinal,
        effectBudgetCommitRef: input.effectBudgetCommitRef,
        effectBudgetCommitDigest: input.effectBudgetCommitDigest,
      }, authorization));
      if (input.callerRequestFingerprint !== ownerCommandDigest) {
        throw new Error("IMAGE_EFFECT_CALLER_REQUEST_FINGERPRINT_MISMATCH");
      }
      const prior = await this.dependencies.repository.lockCommand(transaction, {
        callerIdentity: authorization.callerIdentity,
        callerCommandRef: input.attemptAuthorizationCommandRef,
      });
      if (prior !== null) return replayCommand(prior, ownerCommandDigest,
        await this.#requiredInvocation(transaction, authorization.callerIdentity,
          { logicalInvocationRef: prior.receipt.logicalInvocationRef }), this.dependencies.commandDigest);
      const current = await this.#requiredInvocation(transaction, authorization.callerIdentity, {
        logicalInvocationRef: input.logicalInvocationRef,
        modelInvocationCommandRef: input.modelInvocationCommandRef,
      });
      const previous = currentAttempt(current);
      if (previous.state !== "definitely_not_submitted" ||
          previous.definitelyNotSubmittedReceiptRef !== input.definitelyNotSubmittedReceiptRef ||
          previous.definitelyNotSubmittedReceiptDigest !== input.definitelyNotSubmittedReceiptDigest ||
          input.nextAttemptOrdinal !== previous.ordinal + 1) {
        throw new Error("IMAGE_EFFECT_PREVIOUS_ATTEMPT_NOT_SAFE");
      }
      const attemptRef = this.#validReference(this.#reference("image-attempt"));
      const budget = await this.#commitBudget(transaction, authorization, current, Object.freeze({
        authorizationHandleDigest: current.modelOptionAuthorizationHandleDigest,
        modelOptionRevisionRef: current.modelOptionRevisionRef,
        definitionRoleRef: current.definitionRoleRef,
        deploymentRef: current.deploymentRef,
        adapterKind: current.adapterKind,
        providerModel: current.providerModel,
        expiresAt: current.modelAuthorizationExpiresAt,
      }), {
        ownerCommandDigest,
        logicalInvocationRef: current.logicalInvocationRef,
        attemptRef,
        attemptOrdinal: input.nextAttemptOrdinal,
        effectBudgetCommitRef: input.effectBudgetCommitRef,
        effectBudgetCommitDigest: input.effectBudgetCommitDigest,
      });
      const attempt = createImageEffectAttempt({
        attemptRef,
        ordinal: input.nextAttemptOrdinal,
        budgetCommitRef: input.effectBudgetCommitRef,
        budgetCommitDigest: input.effectBudgetCommitDigest,
        attemptAuthorizationRef: budget.attemptAuthorizationRef,
        attemptAuthorizationFenceEpoch: budget.attemptAuthorizationFenceEpoch,
        attemptAuthorizationDigest: budget.attemptAuthorizationDigest,
        providerOperationKey: this.#validReference(this.#reference("image-provider-operation")),
      });
      const now = this.#now().toISOString();
      const invocation: ImageEffectInvocation = Object.freeze({
        ...current,
        ownerVersion: current.ownerVersion + 1n,
        state: "accepted",
        attempts: Object.freeze([...current.attempts, attempt]),
        updatedAt: now,
      });
      const journal = journalFor({
        authorization,
        callerCommandRef: input.attemptAuthorizationCommandRef,
        commandKind: "attach_attempt",
        ownerCommandDigest,
        callerRequestFingerprint: input.callerRequestFingerprint,
        receiptKind: "attempt_authorization_attached",
        invocation,
        attempt,
        recordedAt: now,
      }, this.dependencies.commandDigest);
      await this.dependencies.repository.persistCommand(transaction, { journal, invocation });
      return response(journal, invocation, false, this.dependencies.commandDigest);
    });
  }

  async #commitBudget(
    transaction: PlatformTransaction,
    authorization: ImageEffectAccessAuthorization,
    command: Pick<CreateImageEffectCommand, "modelInvocationCommandRef" | "operationInputRevisionRef" |
      "operationInputRevisionDigest" | "logicalOutputSlots"> | ImageEffectInvocation,
    modelOption: NonNullable<ImageEffectAccessAuthorization["modelOption"]>,
    input: Readonly<{
      ownerCommandDigest: string;
      logicalInvocationRef: string;
      attemptRef: string;
      attemptOrdinal: number;
      effectBudgetCommitRef: string;
      effectBudgetCommitDigest: string;
    }>,
  ): Promise<Extract<ImageEffectBudgetCommitOutcome, { kind: "accepted" | "replayed" }>> {
    const outcome = await this.dependencies.budget.consume(transaction, {
      siteId: authorization.siteId,
      callerIdentity: authorization.callerIdentity,
      logicalInvocationRef: input.logicalInvocationRef,
      modelInvocationCommandRef: command.modelInvocationCommandRef,
      attemptRef: input.attemptRef,
      attemptOrdinal: input.attemptOrdinal,
      effectBudgetCommitRef: input.effectBudgetCommitRef,
      effectBudgetCommitDigest: input.effectBudgetCommitDigest,
      modelOptionRevisionRef: modelOption.modelOptionRevisionRef,
      deploymentRef: modelOption.deploymentRef,
      operationInputRevisionRef: command.operationInputRevisionRef,
      operationInputRevisionDigest: command.operationInputRevisionDigest,
      logicalOutputSlots: command.logicalOutputSlots,
      ownerCommandDigest: input.ownerCommandDigest,
    });
    if (outcome.kind === "rejected") throw new Error(`IMAGE_EFFECT_BUDGET_${safeCode(outcome.code)}`);
    if (outcome.effectBudgetCommitRef !== input.effectBudgetCommitRef ||
        outcome.effectBudgetCommitDigest !== input.effectBudgetCommitDigest ||
        outcome.attemptOrdinal !== input.attemptOrdinal ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(outcome.attemptAuthorizationRef) ||
        outcome.attemptAuthorizationFenceEpoch < 1n ||
        !/^[a-f0-9]{64}$/u.test(outcome.attemptAuthorizationDigest) ||
        Date.parse(outcome.expiresAt) <= this.#now().getTime()) {
      throw new Error("IMAGE_EFFECT_BUDGET_RECEIPT_INVALID");
    }
    return outcome;
  }

  async #requiredInvocation(
    transaction: PlatformTransaction,
    callerIdentity: string,
    input: Readonly<{ logicalInvocationRef?: string; modelInvocationCommandRef?: string }>,
  ): Promise<ImageEffectInvocation> {
    const invocation = await this.dependencies.repository.lockInvocation(transaction, {
      callerIdentity,
      ...input,
    });
    if (invocation === null) throw new Error("IMAGE_EFFECT_COMMAND_NOT_FOUND");
    return invocation;
  }

  #assertAuthorization(
    authorization: ImageEffectAccessAuthorization,
    input: CreateImageEffectCommand,
  ): NonNullable<ImageEffectAccessAuthorization["modelOption"]> {
    this.#assertCallerAuthorization(authorization, input.callerAccessHandle);
    const modelOption = authorization.modelOption;
    if (modelOption === undefined ||
        modelOption.authorizationHandleDigest !== sha256(input.modelOptionAuthorizationHandle) ||
        modelOption.modelOptionRevisionRef !== input.modelOptionRevisionRef ||
        modelOption.definitionRoleRef !== input.definitionRoleRef ||
        Date.parse(modelOption.expiresAt) <= this.#now().getTime()) {
      throw new Error("IMAGE_EFFECT_MODEL_OPTION_NOT_AUTHORIZED");
    }
    [modelOption.modelOptionRevisionRef, modelOption.deploymentRef,
      modelOption.adapterKind, modelOption.providerModel].forEach(reference);
    const sourceClaims = new Map(authorization.sourceGrantClaims.map((claim) =>
      [`${claim.sourceVersionRef}\0${claim.purposeGrantHandleDigest}`, claim] as const));
    if (sourceClaims.size !== input.sourceGrants.length || input.sourceGrants.some((source) => {
      const claim = sourceClaims.get(`${source.sourceVersionRef}\0${sha256(source.purposeGrantHandle)}`);
      return claim === undefined || Date.parse(claim.expiresAt) <= this.#now().getTime();
    })) throw new Error("IMAGE_EFFECT_SOURCE_GRANT_NOT_AUTHORIZED");
    return modelOption;
  }

  #assertCallerAuthorization(
    authorization: ImageEffectAccessAuthorization,
    callerAccessHandle: string,
  ): void {
    if (authorization.callerAccessHandleDigest !== sha256(callerAccessHandle)) {
      throw new Error("IMAGE_EFFECT_ACCESS_DENIED");
    }
    [authorization.callerIdentity, authorization.siteId, authorization.workloadIdentityRef,
      authorization.environment, authorization.region].forEach(reference);
    if (authorization.callerAudience !== "platform-media-worker" ||
        authorization.authorizationGeneration < 1n || authorization.securityEpoch < 1n) {
      throw new Error("IMAGE_EFFECT_ACCESS_DENIED");
    }
    if (Date.parse(authorization.accessExpiresAt) <= this.#now().getTime()) {
      throw new Error("IMAGE_EFFECT_ACCESS_EXPIRED");
    }
  }

  #now(): Date {
    const value = this.#clock();
    if (!Number.isFinite(value.getTime())) throw new Error("IMAGE_EFFECT_CLOCK_INVALID");
    return value;
  }

  #validReference(value: string): string {
    reference(value);
    return value;
  }
}

function response(
  journal: ImageEffectCommandJournal,
  invocation: ImageEffectInvocation,
  replayed: boolean,
  receiptAuthority: Pick<ImageEffectCommandDigestAuthority, "receipt">,
): ImageEffectCommandResult {
  assertJournalReceipt(journal, receiptAuthority);
  return Object.freeze({ receipt: journal.receipt, invocation: view(invocation), replayed });
}

function replayCommand(
  journal: ImageEffectCommandJournal,
  ownerCommandDigest: string,
  invocation: ImageEffectInvocation,
  receiptAuthority: Pick<ImageEffectCommandDigestAuthority, "receipt">,
): ImageEffectCommandResult {
  if (journal.ownerCommandDigest !== ownerCommandDigest) {
    throw new Error("IMAGE_EFFECT_IDEMPOTENCY_CONFLICT");
  }
  return response(journal, invocation, true, receiptAuthority);
}

function assertJournalReceipt(
  journal: ImageEffectCommandJournal,
  authority: Pick<ImageEffectCommandDigestAuthority, "receipt">,
): void {
  const receipt = journal.receipt;
  const identity = authority.receipt({
    callerCommandRef: receipt.callerCommandRef,
    requestDigest: receipt.requestDigest,
    kind: receipt.kind,
    logicalInvocationRef: receipt.logicalInvocationRef,
    attemptRef: receipt.attemptRef,
    attemptOrdinal: receipt.attemptOrdinal,
    receiptVersion: receipt.receiptVersion,
    recordedAt: receipt.recordedAt,
  });
  if (receipt.callerCommandRef !== journal.callerCommandRef ||
      receipt.requestDigest !== journal.ownerCommandDigest ||
      identity.receiptRef !== receipt.receiptRef || identity.receiptDigest !== receipt.receiptDigest) {
    throw new Error("IMAGE_EFFECT_RECEIPT_INTEGRITY_INVALID");
  }
}

function journalFor(input: Readonly<{
  authorization: ImageEffectAccessAuthorization;
  callerCommandRef: string;
  commandKind: ImageEffectCommandKind;
  ownerCommandDigest: string;
  callerRequestFingerprint: string;
  receiptKind: ImageEffectReceiptKind;
  invocation: ImageEffectInvocation;
  attempt: ImageEffectAttempt;
  recordedAt: string;
}>, receiptAuthority: Pick<ImageEffectCommandDigestAuthority, "receipt">): ImageEffectCommandJournal {
  const receiptCore = Object.freeze({
    callerCommandRef: input.callerCommandRef,
    requestDigest: input.ownerCommandDigest,
    kind: input.receiptKind,
    logicalInvocationRef: input.invocation.logicalInvocationRef,
    attemptRef: input.attempt.attemptRef,
    attemptOrdinal: input.attempt.ordinal,
    receiptVersion: input.invocation.ownerVersion,
    recordedAt: input.recordedAt,
  });
  const identity = receiptAuthority.receipt(receiptCore);
  reference(identity.receiptRef);
  digest(identity.receiptDigest);
  return Object.freeze({
    siteId: input.authorization.siteId,
    callerIdentity: input.authorization.callerIdentity,
    callerAccessHandleDigest: input.authorization.callerAccessHandleDigest,
    callerCommandRef: input.callerCommandRef,
    commandKind: input.commandKind,
    ownerCommandDigest: input.ownerCommandDigest,
    callerRequestFingerprint: input.callerRequestFingerprint,
    receipt: Object.freeze({ ...receiptCore, ...identity }),
  });
}

function view(invocation: ImageEffectInvocation): ImageEffectView {
  const attempt = currentAttempt(invocation);
  const state = invocation.state === "cancel_requested"
    ? "cancel_requested"
    : publicAttemptState(attempt.state);
  return Object.freeze({
    logicalInvocationRef: invocation.logicalInvocationRef,
    modelInvocationCommandRef: invocation.modelInvocationCommandRef,
    ownerVersion: invocation.ownerVersion,
    currentAttemptOrdinal: attempt.ordinal,
    attemptAuthorizationRef: attempt.attemptAuthorizationRef,
    attemptAuthorizationFenceEpoch: attempt.attemptAuthorizationFenceEpoch,
    attemptAuthorizationDigest: attempt.attemptAuthorizationDigest,
    state,
    ...(attempt.canonicalOutcomeEvidenceRef === undefined
      ? {}
      : { canonicalOutcomeEvidenceRef: attempt.canonicalOutcomeEvidenceRef }),
    ...(attempt.canonicalOutcomeEvidenceDigest === undefined
      ? {}
      : { canonicalOutcomeEvidenceDigest: attempt.canonicalOutcomeEvidenceDigest }),
    ...(attempt.usageEvidenceRef === undefined ? {} : { usageEvidenceRef: attempt.usageEvidenceRef }),
    ...(attempt.usageEvidenceDigest === undefined ? {} : { usageEvidenceDigest: attempt.usageEvidenceDigest }),
    observedAt: invocation.updatedAt,
  });
}

function currentAttempt(invocation: ImageEffectInvocation): ImageEffectAttempt {
  const attempt = invocation.attempts.at(-1);
  if (attempt === undefined || attempt.ordinal !== invocation.attempts.length) {
    throw new Error("IMAGE_EFFECT_ATTEMPT_LINEAGE_INVALID");
  }
  return attempt;
}

function publicAttemptState(state: ImageEffectAttemptState): ImageEffectInvocationState {
  return state === "planned" ? "accepted" : state;
}

function snapshotCreateCommand(input: CreateImageEffectCommand): CreateImageEffectCommand {
  accessHandle(input.callerAccessHandle);
  accessHandle(input.modelOptionAuthorizationHandle);
  [input.modelInvocationCommandRef, input.definitionRoleRef, input.modelOptionRevisionRef,
    input.operationInputRevisionRef,
    input.effectBudgetCommitRef, input.trustEffectAllowReceiptRef].forEach(reference);
  [input.callerRequestFingerprint, input.operationInputRevisionDigest,
    input.effectBudgetCommitDigest, input.trustEffectAllowReceiptDigest].forEach(digest);
  if (input.attemptOrdinal !== 1 || input.sourceGrants.length > 16 ||
      input.logicalOutputSlots.length < 1 || input.logicalOutputSlots.length > 4) {
    throw new Error("IMAGE_EFFECT_CREATE_COMMAND_INVALID");
  }
  const sourceRefs = new Set<string>();
  const slots = new Set<string>();
  const candidates = new Set<string>();
  return Object.freeze({
    ...input,
    sourceGrants: Object.freeze(input.sourceGrants.map((source) => {
      reference(source.sourceVersionRef);
      accessHandle(source.purposeGrantHandle);
      if (sourceRefs.has(source.sourceVersionRef)) throw new Error("IMAGE_EFFECT_SOURCE_GRANT_DUPLICATE");
      sourceRefs.add(source.sourceVersionRef);
      return Object.freeze({ ...source });
    })),
    logicalOutputSlots: Object.freeze(input.logicalOutputSlots.map((slot) => {
      reference(slot.candidateRef);
      reference(slot.stableOutputSlotRef);
      if (candidates.has(slot.candidateRef) || slots.has(slot.stableOutputSlotRef)) {
        throw new Error("IMAGE_EFFECT_OUTPUT_SLOT_DUPLICATE");
      }
      candidates.add(slot.candidateRef);
      slots.add(slot.stableOutputSlotRef);
      return Object.freeze({ ...slot });
    })),
  });
}

function snapshotCancelCommand(input: Readonly<{
  callerAccessHandle: string;
  cancelCommandRef: string;
  logicalInvocationRef: string;
  expectedInvocationVersion: bigint;
  callerRequestFingerprint: string;
}>): void {
  accessHandle(input.callerAccessHandle);
  reference(input.cancelCommandRef);
  reference(input.logicalInvocationRef);
  if (input.expectedInvocationVersion < 1n) throw new Error("IMAGE_EFFECT_INVOCATION_VERSION_INVALID");
  digest(input.callerRequestFingerprint);
}

function snapshotAttachCommand(input: Readonly<{
  callerAccessHandle: string;
  attemptAuthorizationCommandRef: string;
  modelInvocationCommandRef: string;
  logicalInvocationRef: string;
  definitelyNotSubmittedReceiptRef: string;
  definitelyNotSubmittedReceiptDigest: string;
  nextAttemptOrdinal: number;
  effectBudgetCommitRef: string;
  effectBudgetCommitDigest: string;
  callerRequestFingerprint: string;
}>): void {
  accessHandle(input.callerAccessHandle);
  [input.attemptAuthorizationCommandRef, input.modelInvocationCommandRef, input.logicalInvocationRef,
    input.definitelyNotSubmittedReceiptRef, input.effectBudgetCommitRef].forEach(reference);
  [input.definitelyNotSubmittedReceiptDigest, input.effectBudgetCommitDigest,
    input.callerRequestFingerprint].forEach(digest);
  if (!Number.isInteger(input.nextAttemptOrdinal) || input.nextAttemptOrdinal < 2 ||
      input.nextAttemptOrdinal > 64) throw new Error("IMAGE_EFFECT_ATTEMPT_ORDINAL_INVALID");
}

function accessHandle(value: string): void {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 32 ||
      Buffer.byteLength(value, "utf8") > 8192 || /[\0\r\n]/u.test(value)) {
    throw new Error("IMAGE_EFFECT_ACCESS_HANDLE_INVALID");
  }
}

function reference(value: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\0\r\n]/u.test(value)) {
    throw new Error("IMAGE_EFFECT_REFERENCE_INVALID");
  }
}

function digest(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error("IMAGE_EFFECT_DIGEST_INVALID");
}

function verifiedDigest(value: string): string {
  digest(value);
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeCode(value: string): string {
  return /^[A-Z][A-Z0-9_]{0,63}$/u.test(value) ? value : "REJECTED";
}
