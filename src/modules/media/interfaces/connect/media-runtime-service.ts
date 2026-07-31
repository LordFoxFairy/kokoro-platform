import { create } from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  CreateAgentImageOperationRequestSchema,
  CreateAgentImageOperationResponseSchema,
  GetAgentMediaOperationRequestSchema,
  GetAgentMediaOperationResponseSchema,
  AgentMediaCandidateViewSchema,
  AgentMediaOperationViewSchema,
  MediaCommandReceiptSchema,
  MediaCommandRecoveryAction,
  MediaCandidateState,
  MediaOperationOutcomeClass,
  MediaOperationState,
  MediaRuntimeErrorCode,
  MediaRuntimeErrorSchema,
  MediaRuntimeService,
  RecoverMediaOperationByCommandRequestSchema,
  RecoverMediaOperationByCommandResponseSchema,
  SubmitMediaCommandAcceptedSchema,
  SubmitMediaCommandOutcomeUnknownSchema,
  SubmitMediaCommandRejectedSchema,
} from "../../../../interfaces/connect/generated-media-runtime/kokoro/platform/media/v1/media_runtime_pb.js";
import type { ImageOperationSubmissionService } from "../../application/index.js";
import type {
  PostgresMediaRuntimeQueryRepository,
  StoredAgentMediaOperationView,
} from "../../infrastructure/postgres/media-runtime-query-repository.js";

const VALIDATOR = createValidator();

export type MediaRuntimeConnectService = ServiceImpl<typeof MediaRuntimeService>;

export interface VerifiedMediaRuntimeCallerResolver {
  resolve(context: HandlerContext): Readonly<{ identity: string }>;
}

/** Private GA-only transport. Studio uses the public BFF surface, not this service. */
export function createMediaRuntimeConnectService(input: Readonly<{
  application: Pick<ImageOperationSubmissionService, "submitAgentImage">;
  query: Pick<PostgresMediaRuntimeQueryRepository, "recoverByCommand" | "get">;
  caller: VerifiedMediaRuntimeCallerResolver;
  agentCallerIdentity: string;
  clock?: () => Date;
}>): MediaRuntimeConnectService {
  if (typeof input.caller?.resolve !== "function" || !input.agentCallerIdentity.startsWith("spiffe://")) {
    throw new Error("MEDIA_RUNTIME_VERIFIED_CALLER_REQUIRED");
  }
  const clock = input.clock ?? (() => new Date());
  return {
    createAgentImageOperation: async (request, context) => {
      authorize(input.caller.resolve(context), input.agentCallerIdentity);
      if (VALIDATOR.validate(CreateAgentImageOperationRequestSchema, request).kind !== "valid" ||
          request.imageIntent === undefined) {
        throw new ConnectError("media image request invalid", Code.InvalidArgument);
      }
      try {
        const result = await input.application.submitAgentImage({
          mediaAccessHandle: request.mediaAccessHandle,
          mediaProjectionReservationHandle: request.mediaProjectionReservationHandle,
          stableOutputSlotRef: request.stableOutputSlotRef,
          agentMediaCommandRef: request.agentMediaCommandRef,
          callerRequestFingerprint: request.callerRequestFingerprint,
          imageIntent: request.imageIntent,
          signal: context.signal,
        });
        const operation = await input.query.get({ mediaAccessHandle: request.mediaAccessHandle,
          operationRef: result.operationRef });
        return create(CreateAgentImageOperationResponseSchema, {
          receipt: create(MediaCommandReceiptSchema, { outcome: {
            case: "submitAccepted",
            value: create(SubmitMediaCommandAcceptedSchema, {
              mediaCommandRef: request.agentMediaCommandRef,
              callerRequestFingerprint: result.callerRequestFingerprint,
              operationRef: result.operationRef,
              receiptVersion: result.receipt.version,
              recordedAt: timestampFromDate(storedInstant(result.receipt.recordedAt)),
              recoveryAction: MediaCommandRecoveryAction.GET_OPERATION,
            }),
          } }),
          ...(operation === null ? {} : { operation: operationView(operation) }),
        });
      } catch (error) {
        const rejection = rejectionCode(error);
        if (rejection === undefined) throw connectError(error, context.signal);
        return create(CreateAgentImageOperationResponseSchema, {
          receipt: create(MediaCommandReceiptSchema, { outcome: {
            case: "submitRejected",
            value: create(SubmitMediaCommandRejectedSchema, {
              mediaCommandRef: request.agentMediaCommandRef,
              callerRequestFingerprint: request.callerRequestFingerprint,
              error: create(MediaRuntimeErrorSchema, rejection),
              receiptVersion: 1n,
              recordedAt: timestampFromDate(instant(clock())),
            }),
          } }),
        });
      }
    },
    cancelAgentMediaOperation: () => unimplemented("media cancellation is not enabled"),
    recoverMediaOperationByCommand: async (request, context) => {
      authorize(input.caller.resolve(context), input.agentCallerIdentity);
      if (VALIDATOR.validate(RecoverMediaOperationByCommandRequestSchema, request).kind !== "valid") {
        throw new ConnectError("media recovery request invalid", Code.InvalidArgument);
      }
      const recovered = await input.query.recoverByCommand({
        mediaAccessHandle: request.mediaAccessHandle,
        commandRef: request.mediaCommandRef,
      });
      if (recovered.kind === "not_found") {
        return create(RecoverMediaOperationByCommandResponseSchema, {
          receipt: create(MediaCommandReceiptSchema, { outcome: {
            case: "submitRejected",
            value: create(SubmitMediaCommandRejectedSchema, {
              mediaCommandRef: request.mediaCommandRef,
              callerRequestFingerprint: "0".repeat(64),
              error: create(MediaRuntimeErrorSchema, { code: MediaRuntimeErrorCode.OPERATION_NOT_FOUND,
                safeMessage: "media command not found" }),
              receiptVersion: 1n,
              recordedAt: timestampFromDate(instant(clock())),
            }),
          } }),
        });
      }
      if (recovered.kind === "processing") {
        return create(RecoverMediaOperationByCommandResponseSchema, {
          receipt: create(MediaCommandReceiptSchema, { outcome: {
            case: "submitOutcomeUnknown",
            value: create(SubmitMediaCommandOutcomeUnknownSchema, {
              mediaCommandRef: request.mediaCommandRef,
              callerRequestFingerprint: recovered.callerRequestFingerprint,
              error: create(MediaRuntimeErrorSchema, { code: MediaRuntimeErrorCode.OUTCOME_UNKNOWN,
                safeMessage: "media command outcome is not yet known" }),
              receiptVersion: recovered.receipt.version,
              recordedAt: timestampFromDate(storedInstant(recovered.receipt.recordedAt)),
              recoveryAction: MediaCommandRecoveryAction.RECOVER_COMMAND,
            }),
          } }),
        });
      }
      const operation = await input.query.get({ mediaAccessHandle: request.mediaAccessHandle,
        operationRef: recovered.operationRef });
      if (operation === null) throw new ConnectError("media operation unavailable", Code.Unavailable);
      return create(RecoverMediaOperationByCommandResponseSchema, {
        receipt: create(MediaCommandReceiptSchema, { outcome: {
          case: "submitAccepted",
          value: create(SubmitMediaCommandAcceptedSchema, {
            mediaCommandRef: request.mediaCommandRef,
            callerRequestFingerprint: recovered.callerRequestFingerprint,
            operationRef: recovered.operationRef,
            receiptVersion: recovered.receipt.version,
            recordedAt: timestampFromDate(storedInstant(recovered.receipt.recordedAt)),
            recoveryAction: MediaCommandRecoveryAction.GET_OPERATION,
          }),
        } }),
        operation: operationView(operation),
      });
    },
    getAgentMediaOperation: async (request, context) => {
      authorize(input.caller.resolve(context), input.agentCallerIdentity);
      if (VALIDATOR.validate(GetAgentMediaOperationRequestSchema, request).kind !== "valid") {
        throw new ConnectError("media operation request invalid", Code.InvalidArgument);
      }
      const operation = await input.query.get({ mediaAccessHandle: request.mediaAccessHandle,
        operationRef: request.operationRef });
      if (operation === null) throw new ConnectError("media operation not found", Code.NotFound);
      return create(GetAgentMediaOperationResponseSchema, { operation: operationView(operation) });
    },
  };
}

function authorize(caller: Readonly<{ identity: string }>, expected: string): void {
  if (caller.identity !== expected) throw new ConnectError("media runtime caller not authorized", Code.PermissionDenied);
}

function rejectionCode(error: unknown): Readonly<{
  code: MediaRuntimeErrorCode;
  safeMessage: string;
}> | undefined {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("MEDIA_ACCESS_DENIED")) {
    return Object.freeze({ code: MediaRuntimeErrorCode.ACCESS_DENIED, safeMessage: "media access denied" });
  }
  if (message.includes("MEDIA_COMMAND_OWNER_DIGEST_CONFLICT") ||
      message.includes("MEDIA_CALLER_FINGERPRINT_MISMATCH")) {
    return Object.freeze({ code: MediaRuntimeErrorCode.IDEMPOTENCY_CONFLICT,
      safeMessage: "media command conflicts with an existing command" });
  }
  if (message.includes("POLICY") || message.includes("CREDIT")) {
    return Object.freeze({ code: MediaRuntimeErrorCode.POLICY_REJECTED,
      safeMessage: "media request rejected by policy" });
  }
  return undefined;
}

function connectError(error: unknown, signal: AbortSignal): ConnectError {
  if (error instanceof ConnectError) return error;
  if (signal.aborted) return new ConnectError("media request canceled", Code.Canceled);
  const message = error instanceof Error ? error.message : "";
  if (message.includes("INVALID") || message.includes("TOO_LARGE")) {
    return new ConnectError("media image request invalid", Code.InvalidArgument);
  }
  return new ConnectError("media runtime unavailable", Code.Unavailable);
}

function instant(value: Date): Date {
  if (!Number.isFinite(value.getTime())) throw new Error("MEDIA_RUNTIME_CLOCK_INVALID");
  return value;
}

function storedInstant(value: string): Date {
  return instant(new Date(value));
}

function unimplemented(message: string): never {
  throw new ConnectError(message, Code.Unimplemented);
}

function operationView(input: StoredAgentMediaOperationView) {
  return create(AgentMediaOperationViewSchema, {
    mediaOperationHandle: input.mediaOperationHandle,
    operationRef: input.operationRef,
    ownerVersion: input.ownerVersion,
    state: operationState(input.state),
    outcomeClass: input.outcomeClass === "canonical"
      ? MediaOperationOutcomeClass.CANONICAL
      : input.outcomeClass === "irreconcilable"
        ? MediaOperationOutcomeClass.IRRECONCILABLE
        : MediaOperationOutcomeClass.UNSPECIFIED,
    safeProgressBps: progress(input.state),
    candidates: input.candidates.map((candidate) => create(AgentMediaCandidateViewSchema, {
      candidateRef: candidate.candidateRef,
      ownerVersion: candidate.ownerVersion,
      state: candidateState(candidate.state),
      ...(candidate.artifactVersionHandle === undefined
        ? {} : { artifactVersionHandle: candidate.artifactVersionHandle }),
    })),
    observedAt: timestampFromDate(new Date(input.observedAt)),
  });
}

function operationState(value: string): MediaOperationState {
  const values: Readonly<Record<string, MediaOperationState>> = {
    admission_pending: MediaOperationState.ADMISSION_PENDING, authorized: MediaOperationState.AUTHORIZED,
    queued: MediaOperationState.QUEUED, active: MediaOperationState.ACTIVE,
    finalizing: MediaOperationState.FINALIZING, cancel_requested: MediaOperationState.CANCEL_REQUESTED,
    reconciling: MediaOperationState.RECONCILING, completed: MediaOperationState.COMPLETED,
    partial: MediaOperationState.PARTIAL, failed: MediaOperationState.FAILED,
    canceled: MediaOperationState.CANCELED,
  };
  const mapped = values[value];
  if (mapped === undefined) throw new Error("MEDIA_OPERATION_ROW_INVALID");
  return mapped;
}

function candidateState(value: string): MediaCandidateState {
  const values: Readonly<Record<string, MediaCandidateState>> = {
    allocated: MediaCandidateState.ALLOCATED, producing: MediaCandidateState.PRODUCING,
    output_received: MediaCandidateState.OUTPUT_RECEIVED, validating: MediaCandidateState.VALIDATING,
    ready: MediaCandidateState.READY, restricted: MediaCandidateState.RESTRICTED,
    failed: MediaCandidateState.FAILED, unknown: MediaCandidateState.UNKNOWN,
    cancel_requested: MediaCandidateState.CANCEL_REQUESTED, canceled: MediaCandidateState.CANCELED,
  };
  const mapped = values[value];
  if (mapped === undefined) throw new Error("MEDIA_CANDIDATE_ROW_INVALID");
  return mapped;
}

function progress(state: string): number {
  if (state === "completed" || state === "partial" || state === "failed" || state === "canceled") return 10_000;
  if (state === "finalizing") return 8_000;
  if (state === "active") return 4_000;
  if (state === "queued") return 1_000;
  return 0;
}
