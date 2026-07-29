import { createHash, timingSafeEqual } from "node:crypto";
import { create, fromBinary, toBinary, type DescMessage, type Message } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { createValidator } from "@bufbuild/protovalidate";
import {
  CommandDigestAlgorithm,
  CommandIdentitySchema,
  CommandReceiptSchema,
  CommandReceiptState,
  type CommandIdentity,
  type CommandReceipt,
} from "../../../interfaces/connect/generated/kokoro/common/v1/receipt_pb.js";
import {
  AdmissionDenialSchema,
  AdmissionOperation,
  AdmissionOutcomeUnknownSchema,
  AdmissionPendingSchema,
  AdmissionRetryClass,
  AlreadyReleasedRunAuthorizationSchema,
  AuthorizationExpiredSchema,
  AuthorizationNotReleasableSchema,
  AuthorizationReconciliationResultSchema,
  CommandReceiptNotFoundSchema,
  CommittedRunAuthorizationSchema,
  EncryptedRunRequestMaterialSchema,
  FinalizeRunAuthorizationEffectSchema,
  FinalizeRunAuthorizationResponseSchema,
  GetCommandReceiptResponseSchema,
  GetCommandReceiptRequestSchema,
  PrepareRunAcceptedSchema,
  PrepareRunEffectSchema,
  PreparedRunAuthorizationSchema,
  PrepareRunResponseSchema,
  PrepareRunWaitingPrerequisiteSchema,
  ReconcileRunAuthorizationEffectSchema,
  ReconcileRunAuthorizationResponseSchema,
  ReleasedRunAuthorizationSchema,
  ReleaseRunAuthorizationEffectSchema,
  ReleaseRunAuthorizationResponseSchema,
  type FinalizeRunAuthorizationRequest,
  type FinalizeRunAuthorizationResponse,
  type GetCommandReceiptRequest,
  type GetCommandReceiptResponse,
  type PrepareRunRequest,
  type PrepareRunResponse,
  type ReconcileRunAuthorizationRequest,
  type ReconcileRunAuthorizationResponse,
  type ReleaseRunAuthorizationRequest,
  type ReleaseRunAuthorizationResponse,
} from "../../../interfaces/connect/generated/kokoro/platform/admission/v1/admission_pb.js";
import {
  MAX_GA_RUN_REQUEST_DRAFT_TTL_MS,
  type GaRunRequestDraftFactory,
} from "./ga-run-request-draft-factory.js";
import { mapOpaqueExecutionContextIntent } from "../interfaces/connect/opaque-execution-context.js";
import type {
  AdmissionCaller,
  AdmissionCommandJournal,
  AdmissionCommandKey,
  AdmissionOperationName,
  AdmissionOwnerAuthority,
  FinalizeRunOwnerDecision,
  PrepareRunOwnerDecision,
  ReconcileRunOwnerDecision,
  ReleaseRunOwnerDecision,
} from "./admission-ports.js";

const SHA256 = /^[0-9a-f]{64}$/u;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const PROTO_VALIDATOR = createValidator();
const OPERATION_LABELS = {
  prepare_run: "kokoro.platform.admission.v1.AdmissionService.PrepareRun",
  finalize_run_authorization:
    "kokoro.platform.admission.v1.AdmissionService.FinalizeRunAuthorization",
  release_run_authorization:
    "kokoro.platform.admission.v1.AdmissionService.ReleaseRunAuthorization",
  reconcile_run_authorization:
    "kokoro.platform.admission.v1.AdmissionService.ReconcileRunAuthorization",
} as const satisfies Record<AdmissionOperationName, string>;

export class AdmissionApplicationService {
  readonly #authority: AdmissionOwnerAuthority;
  readonly #journal: AdmissionCommandJournal;
  readonly #drafts: GaRunRequestDraftFactory;
  readonly #clock: () => Date;

  constructor(input: Readonly<{
    authority: AdmissionOwnerAuthority;
    journal: AdmissionCommandJournal;
    gaRunRequestDraftFactory: GaRunRequestDraftFactory;
    clock?: () => Date;
  }>) {
    this.#authority = input.authority;
    this.#journal = input.journal;
    this.#drafts = input.gaRunRequestDraftFactory;
    this.#clock = input.clock ?? (() => new Date());
  }

  async prepareRun(request: PrepareRunRequest, caller: AdmissionCaller): Promise<PrepareRunResponse> {
    const command = validateCommand(
      request,
      caller,
      "prepare_run",
      PrepareRunEffectSchema,
    );
    if (command.effect.executionContext === undefined) {
      throw invalid("ADMISSION_EXECUTION_CONTEXT_INVALID");
    }
    mapOpaqueExecutionContextIntent(command.effect.executionContext);
    const started = await this.#journal.begin(command.key);
    if (started.kind === "replay") {
      return restore(PrepareRunResponseSchema, started.response, command);
    }
    if (started.kind === "pending") {
      return preparePending(command, started.recordedAt);
    }
    let response: PrepareRunResponse;
    try {
      const decision = await this.#authority.prepareRun({
        caller: command.caller,
        siteId: command.key.siteId,
        commandId: command.key.commandId,
        requestDigest: command.key.requestDigest,
        effect: command.effect,
      });
      response = await this.#prepareResponse(command, decision);
      assertValidProto(PrepareRunResponseSchema, response, "ADMISSION_PREPARE_RESPONSE_INVALID");
    } catch {
      response = prepareUnknown(command, this.#now());
    }
    return restore(
      PrepareRunResponseSchema,
      await this.#journal.complete(
        command.key,
        started.leaseToken,
        toBinary(PrepareRunResponseSchema, response),
      ),
      command,
    );
  }

  async finalizeRunAuthorization(
    request: FinalizeRunAuthorizationRequest,
    caller: AdmissionCaller,
  ): Promise<FinalizeRunAuthorizationResponse> {
    const command = validateCommand(
      request,
      caller,
      "finalize_run_authorization",
      FinalizeRunAuthorizationEffectSchema,
    );
    positiveSegmentVersion(command.effect.expectedSegmentVersion);
    const started = await this.#journal.begin(command.key);
    if (started.kind === "replay") {
      return restore(FinalizeRunAuthorizationResponseSchema, started.response, command);
    }
    if (started.kind === "pending") return finalizePending(command, started.recordedAt);
    let response: FinalizeRunAuthorizationResponse;
    try {
      response = finalizeResponse(
        command,
        await this.#authority.finalizeRunAuthorization({
          caller: command.caller,
          siteId: command.key.siteId,
          commandId: command.key.commandId,
          requestDigest: command.key.requestDigest,
          effect: command.effect,
        }),
        this.#now(),
      );
      assertValidProto(FinalizeRunAuthorizationResponseSchema, response, "ADMISSION_FINALIZE_RESPONSE_INVALID");
    } catch {
      response = finalizeUnknown(command, this.#now());
    }
    return restore(
      FinalizeRunAuthorizationResponseSchema,
      await this.#journal.complete(
        command.key,
        started.leaseToken,
        toBinary(FinalizeRunAuthorizationResponseSchema, response),
      ),
      command,
    );
  }

  async releaseRunAuthorization(
    request: ReleaseRunAuthorizationRequest,
    caller: AdmissionCaller,
  ): Promise<ReleaseRunAuthorizationResponse> {
    const command = validateCommand(
      request,
      caller,
      "release_run_authorization",
      ReleaseRunAuthorizationEffectSchema,
    );
    positiveSegmentVersion(command.effect.expectedSegmentVersion);
    const started = await this.#journal.begin(command.key);
    if (started.kind === "replay") {
      return restore(ReleaseRunAuthorizationResponseSchema, started.response, command);
    }
    if (started.kind === "pending") return releasePending(command, started.recordedAt);
    let response: ReleaseRunAuthorizationResponse;
    try {
      response = releaseResponse(
        command,
        await this.#authority.releaseRunAuthorization({
          caller: command.caller,
          siteId: command.key.siteId,
          commandId: command.key.commandId,
          requestDigest: command.key.requestDigest,
          effect: command.effect,
        }),
        this.#now(),
      );
      assertValidProto(ReleaseRunAuthorizationResponseSchema, response, "ADMISSION_RELEASE_RESPONSE_INVALID");
    } catch {
      response = releaseUnknown(command, this.#now());
    }
    return restore(
      ReleaseRunAuthorizationResponseSchema,
      await this.#journal.complete(
        command.key,
        started.leaseToken,
        toBinary(ReleaseRunAuthorizationResponseSchema, response),
      ),
      command,
    );
  }

  async reconcileRunAuthorization(
    request: ReconcileRunAuthorizationRequest,
    caller: AdmissionCaller,
  ): Promise<ReconcileRunAuthorizationResponse> {
    const command = validateCommand(
      request,
      caller,
      "reconcile_run_authorization",
      ReconcileRunAuthorizationEffectSchema,
    );
    positiveSegmentVersion(command.effect.expectedSegmentVersion);
    const started = await this.#journal.begin(command.key);
    if (started.kind === "replay") {
      return restore(ReconcileRunAuthorizationResponseSchema, started.response, command);
    }
    if (started.kind === "pending") return reconcilePending(command, started.recordedAt);
    let response: ReconcileRunAuthorizationResponse;
    try {
      response = reconcileResponse(
        command,
        await this.#authority.reconcileRunAuthorization({
          caller: command.caller,
          siteId: command.key.siteId,
          commandId: command.key.commandId,
          requestDigest: command.key.requestDigest,
          effect: command.effect,
        }),
        this.#now(),
      );
      assertValidProto(ReconcileRunAuthorizationResponseSchema, response, "ADMISSION_RECONCILE_RESPONSE_INVALID");
    } catch {
      response = reconcileUnknown(command, this.#now());
    }
    return restore(
      ReconcileRunAuthorizationResponseSchema,
      await this.#journal.complete(
        command.key,
        started.leaseToken,
        toBinary(ReconcileRunAuthorizationResponseSchema, response),
      ),
      command,
    );
  }

  async getCommandReceipt(
    request: GetCommandReceiptRequest,
    caller: AdmissionCaller,
  ): Promise<GetCommandReceiptResponse> {
    assertValidProto(GetCommandReceiptRequestSchema, request, "ADMISSION_RECEIPT_LOOKUP_INVALID");
    const operation = wireOperation(request.operation);
    const query = {
      ...validatedCaller(caller),
      siteId: bounded(request.siteId, "ADMISSION_SITE_ID", 128),
      operation,
      commandId: bounded(request.commandId, "ADMISSION_COMMAND_ID", 128),
      requestDigest: digest(request.requestDigest),
    };
    if (request.digestAlgorithm !== CommandDigestAlgorithm.SHA256_PROTOBUF_V1) {
      throw invalid("ADMISSION_DIGEST_ALGORITHM_INVALID");
    }
    const found = await this.#journal.lookup(query);
    if (found.kind === "not_found") {
      return create(GetCommandReceiptResponseSchema, {
        result: { case: "notFound", value: create(CommandReceiptNotFoundSchema) },
      });
    }
    const response = found.kind === "found"
      ? restoreForLookup(operation, found.response, query)
      : pendingForLookup(operation, query, found.idempotencyKey, found.recordedAt);
    return receiptEnvelope(operation, response);
  }

  async #prepareResponse(
    command: ValidatedCommand<typeof PrepareRunEffectSchema>,
    decision: PrepareRunOwnerDecision,
  ): Promise<PrepareRunResponse> {
    const now = this.#now();
    if (decision.kind === "denied") {
      return create(PrepareRunResponseSchema, {
        receipt: receipt(command, CommandReceiptState.REJECTED, now),
        result: { case: "denied", value: create(AdmissionDenialSchema, decision.denial) },
      });
    }
    if (decision.kind === "pending") return preparePending(command, now, decision.pending);
    if (decision.kind === "outcome_unknown") {
      return prepareUnknown(command, now, decision.unknown);
    }
    if (
      decision.ownerFacts.run_id !== command.effect.proposedRunId ||
      decision.ownerFacts.input.message_id !== command.effect.triggerMessageId ||
      decision.ownerFacts.context.session_id !== command.effect.sessionId
    ) throw new Error("ADMISSION_OWNER_FACTS_INTENT_MISMATCH");
    const executionContext = mapOpaqueExecutionContextIntent(command.effect.executionContext!);
    const material = await this.#drafts.create({
      ownerFacts: decision.ownerFacts,
      executionContext,
    });
    const preparedInput = { ...decision.prepared } as Record<string, unknown>;
    delete preparedInput.$typeName;
    delete preparedInput.runRequestMaterial;
    const prepared = create(PreparedRunAuthorizationSchema, {
      ...preparedInput,
      runRequestMaterial: create(EncryptedRunRequestMaterialSchema, {
        ...material,
        expiresAt: timestampFromDate(new Date(material.expiresAt)),
      }),
    });
    const authorizationExpiresAt = prepared.expiresAt === undefined
      ? Number.NaN
      : timestampMilliseconds(prepared.expiresAt);
    if (
      prepared.expiresAt === undefined || prepared.runRequestMaterial?.expiresAt === undefined ||
      authorizationExpiresAt <= Date.parse(now) ||
      authorizationExpiresAt > Date.parse(now) + MAX_GA_RUN_REQUEST_DRAFT_TTL_MS ||
      timestampMilliseconds(prepared.runRequestMaterial.expiresAt) > authorizationExpiresAt
    ) throw new Error("ADMISSION_PREPARED_AUTHORIZATION_LIFETIME_INVALID");
    if (decision.kind === "accepted") {
      return create(PrepareRunResponseSchema, {
        receipt: receipt(command, CommandReceiptState.ACCEPTED, now),
        result: {
          case: "accepted",
          value: create(PrepareRunAcceptedSchema, { prepared }),
        },
      });
    }
    return create(PrepareRunResponseSchema, {
      receipt: receipt(command, CommandReceiptState.ACCEPTED, now),
      result: {
        case: "waitingPrerequisite",
        value: create(PrepareRunWaitingPrerequisiteSchema, {
          prepared,
          prerequisiteRefs: [...decision.prerequisiteRefs],
        }),
      },
    });
  }

  #now(): string {
    const value = this.#clock();
    if (!Number.isFinite(value.getTime())) throw new Error("ADMISSION_CLOCK_INVALID");
    return value.toISOString();
  }
}

type AdmissionRequest<Effect extends Message> = Readonly<{
  command?: CommandIdentity | undefined;
  siteId: string;
  effect?: Effect | undefined;
}>;

interface ValidatedCommand<Schema extends DescMessage> {
  readonly key: AdmissionCommandKey;
  readonly caller: AdmissionCaller;
  readonly identity: CommandIdentity;
  readonly effect: ReturnType<typeof create<Schema>>;
}

type ReceiptCommand = Pick<ValidatedCommand<DescMessage>, "identity" | "key">;

function validateCommand<Schema extends DescMessage>(
  request: AdmissionRequest<ReturnType<typeof create<Schema>>>,
  callerInput: AdmissionCaller,
  operation: AdmissionOperationName,
  effectSchema: Schema,
): ValidatedCommand<Schema> {
  const caller = validatedCaller(callerInput);
  const identity = request.command;
  const effect = request.effect;
  if (identity === undefined || effect === undefined) throw invalid("ADMISSION_COMMAND_INVALID");
  if (identity.digestAlgorithm !== CommandDigestAlgorithm.SHA256_PROTOBUF_V1) {
    throw invalid("ADMISSION_DIGEST_ALGORITHM_INVALID");
  }
  const normalizedEffect = fromBinary(
    effectSchema,
    toBinary(effectSchema, effect, { writeUnknownFields: false }),
    { readUnknownFields: false },
  );
  const validation = PROTO_VALIDATOR.validate(effectSchema, normalizedEffect);
  if (validation.kind !== "valid") throw invalid("ADMISSION_EFFECT_INVALID");
  const expected = effectDigest(effectSchema, normalizedEffect);
  const supplied = digest(identity.requestDigest);
  const expectedBytes = Buffer.from(expected, "hex");
  const suppliedBytes = Buffer.from(supplied, "hex");
  if (
    suppliedBytes.byteLength !== expectedBytes.byteLength ||
    !timingSafeEqual(suppliedBytes, expectedBytes)
  ) throw invalid("ADMISSION_COMMAND_DIGEST_MISMATCH");
  const key: AdmissionCommandKey = Object.freeze({
    ...caller,
    siteId: bounded(request.siteId, "ADMISSION_SITE_ID", 128),
    operation,
    commandId: bounded(identity.commandId, "ADMISSION_COMMAND_ID", 128),
    idempotencyKey: bounded(identity.idempotencyKey, "ADMISSION_IDEMPOTENCY_KEY", 191),
    requestDigest: supplied,
  });
  return Object.freeze({ key, caller, identity, effect: normalizedEffect });
}

function validatedCaller(input: AdmissionCaller): AdmissionCaller {
  return Object.freeze({
    identity: bounded(input.identity, "ADMISSION_CALLER_IDENTITY", 256),
    environment: bounded(input.environment, "ADMISSION_ENVIRONMENT", 64),
    region: bounded(input.region, "ADMISSION_REGION", 64),
  });
}

function effectDigest<Schema extends DescMessage>(
  schema: Schema,
  value: ReturnType<typeof create<Schema>>,
): string {
  return createHash("sha256")
    .update(value.$typeName)
    .update("\0")
    .update(toBinary(schema, value, { writeUnknownFields: false }))
    .digest("hex");
}

function receipt(
  command: ReceiptCommand,
  state: CommandReceiptState,
  recordedAt: string,
): CommandReceipt {
  return create(CommandReceiptSchema, {
    identity: create(CommandIdentitySchema, {
      commandId: command.key.commandId,
      idempotencyKey: command.key.idempotencyKey,
      digestAlgorithm: CommandDigestAlgorithm.SHA256_PROTOBUF_V1,
      requestDigest: command.key.requestDigest,
    }),
    operation: OPERATION_LABELS[command.key.operation],
    state,
    recordedAt: timestampFromDate(new Date(recordedAt)),
  });
}

function retryAfter(recordedAt: string): ReturnType<typeof timestampFromDate> {
  return timestampFromDate(new Date(Date.parse(recordedAt) + 1_000));
}

function timestampMilliseconds(value: Readonly<{ seconds: bigint; nanos: number }>): number {
  if (
    value.seconds < 0n || value.seconds > 253_402_300_799n ||
    !Number.isInteger(value.nanos) || value.nanos < 0 || value.nanos > 999_999_999
  ) throw new Error("ADMISSION_TIMESTAMP_INVALID");
  return Number(value.seconds) * 1_000 + Math.floor(value.nanos / 1_000_000);
}

function preparePending(
  command: ReceiptCommand,
  at: string,
  value: Parameters<typeof create<typeof AdmissionPendingSchema>>[1] = {
    retryAfter: retryAfter(at),
  },
): PrepareRunResponse {
  return create(PrepareRunResponseSchema, {
    receipt: receipt(command, CommandReceiptState.ACCEPTED, at),
    result: { case: "pending", value: create(AdmissionPendingSchema, value) },
  });
}

function prepareUnknown(
  command: ReceiptCommand,
  at: string,
  value: Parameters<typeof create<typeof AdmissionOutcomeUnknownSchema>>[1] = {
    retryClass: AdmissionRetryClass.RECONCILE_RECEIPT,
    retryAfter: retryAfter(at),
  },
): PrepareRunResponse {
  return create(PrepareRunResponseSchema, {
    receipt: receipt(command, CommandReceiptState.OUTCOME_UNKNOWN, at),
    result: { case: "outcomeUnknown", value: create(AdmissionOutcomeUnknownSchema, value) },
  });
}

function finalizeResponse(
  command: ValidatedCommand<typeof FinalizeRunAuthorizationEffectSchema>,
  decision: FinalizeRunOwnerDecision,
  at: string,
): FinalizeRunAuthorizationResponse {
  if (decision.kind === "committed") {
    const committed = create(CommittedRunAuthorizationSchema, decision.committed);
    if (
      committed.authorizationSegmentRef !== command.effect.authorizationSegmentRef ||
      committed.segmentVersion !== command.effect.expectedSegmentVersion + 1n
    ) throw new Error("ADMISSION_SEGMENT_TRANSITION_INVALID");
    return create(FinalizeRunAuthorizationResponseSchema, {
      receipt: receipt(command, CommandReceiptState.COMMITTED, at),
      result: { case: "committed", value: committed },
    });
  }
  if (decision.kind === "expired") return create(FinalizeRunAuthorizationResponseSchema, {
    receipt: receipt(command, CommandReceiptState.REJECTED, at),
    result: { case: "expired", value: create(AuthorizationExpiredSchema, decision.expired) },
  });
  if (decision.kind === "denied") return create(FinalizeRunAuthorizationResponseSchema, {
    receipt: receipt(command, CommandReceiptState.REJECTED, at),
    result: { case: "denied", value: create(AdmissionDenialSchema, decision.denial) },
  });
  if (decision.kind === "pending") return finalizePending(command, at, decision.pending);
  return finalizeUnknown(command, at, decision.unknown);
}

function finalizePending(
  command: ReceiptCommand, at: string,
  value: Parameters<typeof create<typeof AdmissionPendingSchema>>[1] = { retryAfter: retryAfter(at) },
): FinalizeRunAuthorizationResponse {
  return create(FinalizeRunAuthorizationResponseSchema, {
    receipt: receipt(command, CommandReceiptState.ACCEPTED, at),
    result: { case: "pending", value: create(AdmissionPendingSchema, value) },
  });
}
function finalizeUnknown(
  command: ReceiptCommand, at: string,
  value: Parameters<typeof create<typeof AdmissionOutcomeUnknownSchema>>[1] = { retryClass: AdmissionRetryClass.RECONCILE_RECEIPT, retryAfter: retryAfter(at) },
): FinalizeRunAuthorizationResponse {
  return create(FinalizeRunAuthorizationResponseSchema, {
    receipt: receipt(command, CommandReceiptState.OUTCOME_UNKNOWN, at),
    result: { case: "outcomeUnknown", value: create(AdmissionOutcomeUnknownSchema, value) },
  });
}

function releaseResponse(
  command: ValidatedCommand<typeof ReleaseRunAuthorizationEffectSchema>,
  decision: ReleaseRunOwnerDecision,
  at: string,
): ReleaseRunAuthorizationResponse {
  if (decision.kind === "released") {
    const released = create(ReleasedRunAuthorizationSchema, decision.released);
    if (
      released.authorizationSegmentRef !== command.effect.authorizationSegmentRef ||
      released.segmentVersion !== command.effect.expectedSegmentVersion + 1n
    ) throw new Error("ADMISSION_SEGMENT_TRANSITION_INVALID");
    return create(ReleaseRunAuthorizationResponseSchema, {
      receipt: receipt(command, CommandReceiptState.COMMITTED, at),
      result: { case: "released", value: released },
    });
  }
  if (decision.kind === "already_released") {
    const release = create(ReleasedRunAuthorizationSchema, decision.released);
    if (
      release.authorizationSegmentRef !== command.effect.authorizationSegmentRef ||
      release.segmentVersion < command.effect.expectedSegmentVersion
    ) throw new Error("ADMISSION_SEGMENT_TRANSITION_INVALID");
    return create(ReleaseRunAuthorizationResponseSchema, {
      receipt: receipt(command, CommandReceiptState.COMMITTED, at),
      result: { case: "alreadyReleased", value: create(AlreadyReleasedRunAuthorizationSchema, { release }) },
    });
  }
  if (decision.kind === "not_releasable") return create(ReleaseRunAuthorizationResponseSchema, {
    receipt: receipt(command, CommandReceiptState.REJECTED, at),
    result: { case: "notReleasable", value: create(AuthorizationNotReleasableSchema, decision.notReleasable) },
  });
  if (decision.kind === "pending") return releasePending(command, at, decision.pending);
  return releaseUnknown(command, at, decision.unknown);
}

function releasePending(
  command: ReceiptCommand, at: string,
  value: Parameters<typeof create<typeof AdmissionPendingSchema>>[1] = { retryAfter: retryAfter(at) },
): ReleaseRunAuthorizationResponse {
  return create(ReleaseRunAuthorizationResponseSchema, {
    receipt: receipt(command, CommandReceiptState.ACCEPTED, at),
    result: { case: "pending", value: create(AdmissionPendingSchema, value) },
  });
}
function releaseUnknown(
  command: ReceiptCommand, at: string,
  value: Parameters<typeof create<typeof AdmissionOutcomeUnknownSchema>>[1] = { retryClass: AdmissionRetryClass.RECONCILE_RECEIPT, retryAfter: retryAfter(at) },
): ReleaseRunAuthorizationResponse {
  return create(ReleaseRunAuthorizationResponseSchema, {
    receipt: receipt(command, CommandReceiptState.OUTCOME_UNKNOWN, at),
    result: { case: "outcomeUnknown", value: create(AdmissionOutcomeUnknownSchema, value) },
  });
}

const RECONCILE_CASES = {
  execution_observed: "executionObserved",
  released_no_effect: "releasedNoEffect",
  awaiting_owner_evidence: "awaitingOwnerEvidence",
  reconciliation_required: "reconciliationRequired",
  settled: "settled",
} as const;

function reconcileResponse(
  command: ValidatedCommand<typeof ReconcileRunAuthorizationEffectSchema>,
  decision: ReconcileRunOwnerDecision,
  at: string,
): ReconcileRunAuthorizationResponse {
  if (decision.kind === "pending") return reconcilePending(command, at, decision.pending);
  if (decision.kind === "outcome_unknown") return reconcileUnknown(command, at, decision.unknown);
  const result = create(AuthorizationReconciliationResultSchema, decision.result);
  if (
    result.authorizationSegmentRef !== command.effect.authorizationSegmentRef ||
    result.segmentVersion < command.effect.expectedSegmentVersion
  ) throw new Error("ADMISSION_SEGMENT_TRANSITION_INVALID");
  return create(ReconcileRunAuthorizationResponseSchema, {
    receipt: receipt(command, CommandReceiptState.COMMITTED, at),
    result: {
      case: RECONCILE_CASES[decision.kind],
      value: result,
    },
  });
}

function reconcilePending(
  command: ReceiptCommand, at: string,
  value: Parameters<typeof create<typeof AdmissionPendingSchema>>[1] = { retryAfter: retryAfter(at) },
): ReconcileRunAuthorizationResponse {
  return create(ReconcileRunAuthorizationResponseSchema, {
    receipt: receipt(command, CommandReceiptState.ACCEPTED, at),
    result: { case: "pending", value: create(AdmissionPendingSchema, value) },
  });
}
function reconcileUnknown(
  command: ReceiptCommand, at: string,
  value: Parameters<typeof create<typeof AdmissionOutcomeUnknownSchema>>[1] = { retryClass: AdmissionRetryClass.RECONCILE_RECEIPT, retryAfter: retryAfter(at) },
): ReconcileRunAuthorizationResponse {
  return create(ReconcileRunAuthorizationResponseSchema, {
    receipt: receipt(command, CommandReceiptState.OUTCOME_UNKNOWN, at),
    result: { case: "outcomeUnknown", value: create(AdmissionOutcomeUnknownSchema, value) },
  });
}

function restore<Schema extends DescMessage>(
  schema: Schema,
  bytes: Uint8Array,
  command: ReceiptCommand,
): ReturnType<typeof fromBinary<Schema>> {
  let response: ReturnType<typeof fromBinary<Schema>>;
  try {
    response = fromBinary(schema, bytes, { readUnknownFields: false });
    assertValidProto(schema, response, "ADMISSION_STORED_RESPONSE_INVALID");
  } catch (cause) {
    throw new ConnectError("admission receipt corrupt", Code.DataLoss, undefined, undefined, cause);
  }
  const candidate = response as Message & { readonly receipt?: CommandReceipt | undefined };
  assertReceipt(candidate.receipt, command);
  return response;
}

function assertReceipt(
  value: CommandReceipt | undefined,
  command: ReceiptCommand,
): void {
  const identity = value?.identity;
  if (
    identity === undefined ||
    identity.commandId !== command.key.commandId ||
    identity.idempotencyKey !== command.key.idempotencyKey ||
    identity.digestAlgorithm !== CommandDigestAlgorithm.SHA256_PROTOBUF_V1 ||
    identity.requestDigest !== command.key.requestDigest ||
    value?.operation !== OPERATION_LABELS[command.key.operation] ||
    value.recordedAt === undefined
  ) throw new ConnectError("admission receipt corrupt", Code.DataLoss);
}

function restoreForLookup(
  operation: AdmissionOperationName,
  bytes: Uint8Array,
  query: AdmissionCaller & Readonly<{ siteId: string; commandId: string; requestDigest: string }>,
) {
  const schema = responseSchema(operation);
  let response: Message & { readonly receipt?: CommandReceipt | undefined };
  try {
    const decoded = fromBinary(schema, bytes, { readUnknownFields: false });
    assertValidProto(schema, decoded, "ADMISSION_STORED_RESPONSE_INVALID");
    response = decoded as Message & { readonly receipt?: CommandReceipt | undefined };
  } catch (cause) {
    throw new ConnectError("admission receipt corrupt", Code.DataLoss, undefined, undefined, cause);
  }
  const identity = response.receipt?.identity;
  if (
    identity === undefined || identity.commandId !== query.commandId ||
    identity.requestDigest !== query.requestDigest ||
    identity.digestAlgorithm !== CommandDigestAlgorithm.SHA256_PROTOBUF_V1 ||
    identity.idempotencyKey.length < 1 || identity.idempotencyKey.trim() !== identity.idempotencyKey ||
    response.receipt?.operation !== OPERATION_LABELS[operation]
  ) throw new ConnectError("admission receipt corrupt", Code.DataLoss);
  return response;
}

function pendingForLookup(
  operation: AdmissionOperationName,
  query: AdmissionCaller & Readonly<{ siteId: string; commandId: string; requestDigest: string }>,
  idempotencyKey: string,
  recordedAt: string,
) {
  const identity = create(CommandIdentitySchema, {
    commandId: query.commandId,
    idempotencyKey,
    digestAlgorithm: CommandDigestAlgorithm.SHA256_PROTOBUF_V1,
    requestDigest: query.requestDigest,
  });
  const base: ReceiptCommand = { identity, key: { ...query, operation, idempotencyKey } };
  if (operation === "prepare_run") return preparePending(base, recordedAt);
  if (operation === "finalize_run_authorization") return finalizePending(base, recordedAt);
  if (operation === "release_run_authorization") return releasePending(base, recordedAt);
  return reconcilePending(base, recordedAt);
}

function receiptEnvelope(
  operation: AdmissionOperationName,
  response: Message & { readonly receipt?: CommandReceipt | undefined },
): GetCommandReceiptResponse {
  if (response.receipt === undefined) throw new ConnectError("admission receipt corrupt", Code.DataLoss);
  if (operation === "prepare_run") return create(GetCommandReceiptResponseSchema, {
    receipt: response.receipt,
    result: { case: "prepareRun", value: response as PrepareRunResponse },
  });
  if (operation === "finalize_run_authorization") return create(GetCommandReceiptResponseSchema, {
    receipt: response.receipt,
    result: { case: "finalizeRunAuthorization", value: response as FinalizeRunAuthorizationResponse },
  });
  if (operation === "release_run_authorization") return create(GetCommandReceiptResponseSchema, {
    receipt: response.receipt,
    result: { case: "releaseRunAuthorization", value: response as ReleaseRunAuthorizationResponse },
  });
  return create(GetCommandReceiptResponseSchema, {
    receipt: response.receipt,
    result: { case: "reconcileRunAuthorization", value: response as ReconcileRunAuthorizationResponse },
  });
}

function responseSchema(operation: AdmissionOperationName) {
  if (operation === "prepare_run") return PrepareRunResponseSchema;
  if (operation === "finalize_run_authorization") return FinalizeRunAuthorizationResponseSchema;
  if (operation === "release_run_authorization") return ReleaseRunAuthorizationResponseSchema;
  return ReconcileRunAuthorizationResponseSchema;
}

function wireOperation(value: AdmissionOperation): AdmissionOperationName {
  if (value === AdmissionOperation.PREPARE_RUN) return "prepare_run";
  if (value === AdmissionOperation.FINALIZE_RUN_AUTHORIZATION) return "finalize_run_authorization";
  if (value === AdmissionOperation.RELEASE_RUN_AUTHORIZATION) return "release_run_authorization";
  if (value === AdmissionOperation.RECONCILE_RUN_AUTHORIZATION) return "reconcile_run_authorization";
  throw invalid("ADMISSION_OPERATION_INVALID");
}

function bounded(value: string, name: string, maximum: number): string {
  const hasControl = [...value].some((character) => {
    const point = character.codePointAt(0)!;
    return point < 32 || point === 127;
  });
  if (value.length < 1 || value.length > maximum || value.trim() !== value || hasControl) {
    throw invalid(`${name}_INVALID`);
  }
  return value;
}

function digest(value: string): string {
  if (!SHA256.test(value)) throw invalid("ADMISSION_REQUEST_DIGEST_INVALID");
  return value;
}

function positiveSegmentVersion(value: bigint): void {
  if (value < 1n || value > POSTGRES_BIGINT_MAX) {
    throw invalid("ADMISSION_SEGMENT_VERSION_INVALID");
  }
}

function invalid(message: string): ConnectError {
  return new ConnectError(message, Code.InvalidArgument);
}

function assertValidProto<Schema extends DescMessage>(
  schema: Schema,
  message: ReturnType<typeof create<Schema>>,
  code: string,
): void {
  if (PROTO_VALIDATOR.validate(schema, message).kind !== "valid") throw new Error(code);
}
