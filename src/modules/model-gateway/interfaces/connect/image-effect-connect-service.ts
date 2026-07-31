import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import {
  AttachNextAttemptAuthorizationResponseSchema,
  AttachNextAttemptAuthorizationEffectSchema,
  CanonicalImageEffectCommandReceiptV1Schema,
  CreateImageEffectEffectSchema,
  CreateImageEffectResponseSchema,
  GetImageEffectByCommandResponseSchema,
  ImageEffectCommandReceiptSchema,
  ImageEffectReceiptKind,
  ImageEffectState,
  ImageEffectV1Service,
  ImageEffectViewSchema,
  RecoverImageEffectByCommandResponseSchema,
  RequestCancelImageEffectResponseSchema,
  RequestCancelImageEffectEffectSchema,
} from "../../../../interfaces/connect/generated-model-image-effect/kokoro/platform/model/image/v1/image_effect_pb.js";
import type {
  CreateImageEffectCommand,
  ImageEffectAccessAuthorization,
  ImageEffectCommandDigestAuthority,
  ImageEffectCommandResult,
  ImageEffectService,
  ImageEffectView,
} from "../../application/image-effect-service.js";
import type { VerifiedModelGatewayCallerResolver } from "./model-gateway-connect-service.js";
import {
  attachNextAttemptAuthorizationRequestDigest,
  createImageEffectRequestDigest,
  imageEffectCommandReceiptDigest,
  imageEffectCommandReceiptRef,
  requestCancelImageEffectRequestDigest,
  type VerifiedModelImageEffectCommandAxes,
} from "../../../../interfaces/connect/generated-model-image-effect/command-envelope-digest.js";

export type ImageEffectConnectService = ServiceImpl<typeof ImageEffectV1Service>;

export function createImageEffectConnectService(input: Readonly<{
  application: Pick<ImageEffectService, "create" | "recover" | "get" | "requestCancel" |
    "attachNextAttemptAuthorization">;
  caller: VerifiedModelGatewayCallerResolver;
  mediaCallerIdentity: string;
}>): ImageEffectConnectService {
  if (!input.mediaCallerIdentity.startsWith("spiffe://") || typeof input.caller?.resolve !== "function" ||
      typeof input.application?.create !== "function") {
    throw new Error("IMAGE_EFFECT_CONNECT_COMPOSITION_INVALID");
  }
  const authorize = (context: HandlerContext): void => {
    if (input.caller.resolve(context).identity !== input.mediaCallerIdentity) {
      throw new ConnectError("image effect caller not authorized", Code.PermissionDenied);
    }
  };
  return {
    createImageEffect: (request, context) => safe(async () => {
      authorize(context);
      if (request.attemptOrdinal !== 1) throw new Error("IMAGE_EFFECT_ATTEMPT_ORDINAL_INVALID");
      const result = await input.application.create({
        callerAccessHandle: request.callerAccessHandle,
        modelInvocationCommandRef: request.modelInvocationCommandRef,
        callerRequestFingerprint: request.callerRequestFingerprint,
        definitionRoleRef: request.definitionRoleRef,
        modelOptionAuthorizationHandle: request.modelOptionAuthorizationHandle,
        modelOptionRevisionRef: request.modelOptionRevisionRef,
        operationInputRevisionRef: request.operationInputRevisionRef,
        operationInputRevisionDigest: request.operationInputRevisionDigest,
        sourceGrants: request.sourceGrants.map((source) => Object.freeze({
          sourceVersionRef: source.sourceVersionRef,
          purposeGrantHandle: source.purposeGrantHandle,
        })),
        logicalOutputSlots: request.logicalOutputSlots.map((slot) => Object.freeze({
          candidateRef: slot.candidateRef,
          stableOutputSlotRef: slot.stableOutputSlotRef,
        })),
        effectBudgetCommitRef: request.effectBudgetCommitRef,
        effectBudgetCommitDigest: request.effectBudgetCommitDigest,
        attemptOrdinal: 1,
        trustEffectAllowReceiptRef: request.trustEffectAllowReceiptRef,
        trustEffectAllowReceiptDigest: request.trustEffectAllowReceiptDigest,
      });
      return create(CreateImageEffectResponseSchema, resultMessage(result));
    }),
    recoverImageEffectByCommand: (request, context) => safe(async () => {
      authorize(context);
      const result = await input.application.recover({
        callerAccessHandle: request.callerAccessHandle,
        callerCommandRef: request.callerCommandRef,
      });
      return create(RecoverImageEffectByCommandResponseSchema, resultMessage(result));
    }),
    getImageEffectByCommand: (request, context) => safe(async () => {
      authorize(context);
      const invocation = await input.application.get({
        callerAccessHandle: request.callerAccessHandle,
        modelInvocationCommandRef: request.modelInvocationCommandRef,
      });
      return create(GetImageEffectByCommandResponseSchema, { invocation: mapView(invocation) });
    }),
    getImageEffectEvidence: (_request, context) => safe(async () => {
      authorize(context);
      throw new ConnectError("image effect evidence owner not activated", Code.Unimplemented);
    }),
    issueImageEffectOutputAccess: (_request, context) => safe(async () => {
      authorize(context);
      throw new ConnectError("image effect output access owner not activated", Code.Unimplemented);
    }),
    recoverImageEffectOutputAccessByCommand: (_request, context) => safe(async () => {
      authorize(context);
      throw new ConnectError("image effect output access owner not activated", Code.Unimplemented);
    }),
    requestCancelImageEffect: (request, context) => safe(async () => {
      authorize(context);
      const result = await input.application.requestCancel({
        callerAccessHandle: request.callerAccessHandle,
        cancelCommandRef: request.cancelCommandRef,
        logicalInvocationRef: request.logicalInvocationRef,
        expectedInvocationVersion: request.expectedInvocationVersion,
        callerRequestFingerprint: request.callerRequestFingerprint,
      });
      return create(RequestCancelImageEffectResponseSchema, resultMessage(result));
    }),
    attachNextAttemptAuthorization: (request, context) => safe(async () => {
      authorize(context);
      const result = await input.application.attachNextAttemptAuthorization({
        callerAccessHandle: request.callerAccessHandle,
        attemptAuthorizationCommandRef: request.attemptAuthorizationCommandRef,
        modelInvocationCommandRef: request.modelInvocationCommandRef,
        logicalInvocationRef: request.logicalInvocationRef,
        definitelyNotSubmittedReceiptRef: request.definitelyNotSubmittedReceiptRef,
        definitelyNotSubmittedReceiptDigest: request.definitelyNotSubmittedReceiptDigest,
        nextAttemptOrdinal: request.nextAttemptOrdinal,
        effectBudgetCommitRef: request.effectBudgetCommitRef,
        effectBudgetCommitDigest: request.effectBudgetCommitDigest,
        callerRequestFingerprint: request.callerRequestFingerprint,
      });
      return create(AttachNextAttemptAuthorizationResponseSchema, resultMessage(result));
    }),
    readImageEffectOutput: (_request, context) => {
      authorize(context);
      return failClosedStream(new ConnectError("image effect output data plane not activated", Code.Unimplemented));
    },
  };
}

function failClosedStream<Output>(error: ConnectError): AsyncIterable<Output> {
  return Object.freeze({
    [Symbol.asyncIterator](): AsyncIterator<Output> {
      return Object.freeze({
        next: async (): Promise<IteratorResult<Output>> => Promise.reject(error),
      });
    },
  });
}

export function createGeneratedImageEffectCommandDigestAuthority(): ImageEffectCommandDigestAuthority {
  return Object.freeze({
    create(input: CreateImageEffectCommand, authorization: ImageEffectAccessAuthorization) {
      const sourceClaims = new Map(authorization.sourceGrantClaims.map((claim) =>
        [claim.sourceVersionRef, claim] as const));
      return createImageEffectRequestDigest(create(CreateImageEffectEffectSchema, {
        definitionRoleRef: input.definitionRoleRef,
        modelOptionRevisionRef: input.modelOptionRevisionRef,
        operationInputRevisionRef: input.operationInputRevisionRef,
        operationInputRevisionDigest: input.operationInputRevisionDigest,
        sourceGrants: input.sourceGrants.map((source) => {
          const claim = sourceClaims.get(source.sourceVersionRef);
          if (claim === undefined) throw new Error("IMAGE_EFFECT_SOURCE_GRANT_NOT_AUTHORIZED");
          return { sourceVersionRef: source.sourceVersionRef,
            purposeGrantHandleDigest: claim.purposeGrantHandleDigest };
        }),
        logicalOutputSlots: input.logicalOutputSlots.map((slot) => ({ ...slot })),
        effectBudgetCommitRef: input.effectBudgetCommitRef,
        effectBudgetCommitDigest: input.effectBudgetCommitDigest,
        attemptOrdinal: input.attemptOrdinal,
        trustEffectAllowReceiptRef: input.trustEffectAllowReceiptRef,
        trustEffectAllowReceiptDigest: input.trustEffectAllowReceiptDigest,
      }), axes(authorization));
    },
    cancel(
      input: Parameters<ImageEffectCommandDigestAuthority["cancel"]>[0],
      authorization: ImageEffectAccessAuthorization,
    ) {
      return requestCancelImageEffectRequestDigest(create(RequestCancelImageEffectEffectSchema, input),
        axes(authorization));
    },
    attach(
      input: Parameters<ImageEffectCommandDigestAuthority["attach"]>[0],
      authorization: ImageEffectAccessAuthorization,
    ) {
      return attachNextAttemptAuthorizationRequestDigest(
        create(AttachNextAttemptAuthorizationEffectSchema, input), axes(authorization));
    },
    receipt(input: Parameters<ImageEffectCommandDigestAuthority["receipt"]>[0]) {
      const record = create(CanonicalImageEffectCommandReceiptV1Schema, {
        callerCommandRef: input.callerCommandRef,
        requestDigest: input.requestDigest,
        kind: receiptKind(input.kind),
        logicalInvocationRef: input.logicalInvocationRef,
        attemptRef: input.attemptRef,
        attemptOrdinal: input.attemptOrdinal,
        receiptVersion: input.receiptVersion,
        recordedAt: timestampFromDate(new Date(input.recordedAt)),
      });
      return Object.freeze({
        receiptRef: imageEffectCommandReceiptRef(record),
        receiptDigest: imageEffectCommandReceiptDigest(record),
      });
    },
  });
}

function axes(authorization: ImageEffectAccessAuthorization): VerifiedModelImageEffectCommandAxes {
  return Object.freeze({
    workloadIdentityRef: authorization.workloadIdentityRef,
    audience: authorization.callerAudience,
    environment: authorization.environment,
    region: authorization.region,
    siteRef: authorization.siteId,
    callerIdentity: authorization.callerIdentity,
    authorizationGeneration: authorization.authorizationGeneration,
    securityEpoch: authorization.securityEpoch,
  });
}

function resultMessage(result: ImageEffectCommandResult) {
  return { receipt: create(ImageEffectCommandReceiptSchema, {
    callerCommandRef: result.receipt.callerCommandRef,
    kind: receiptKind(result.receipt.kind),
    logicalInvocationRef: result.receipt.logicalInvocationRef,
    attemptRef: result.receipt.attemptRef,
    attemptOrdinal: result.receipt.attemptOrdinal,
    receiptVersion: result.receipt.receiptVersion,
    recordedAt: timestampFromDate(new Date(result.receipt.recordedAt)),
    receiptRef: result.receipt.receiptRef,
    receiptDigest: result.receipt.receiptDigest,
    requestDigest: result.receipt.requestDigest,
  }), invocation: mapView(result.invocation) };
}

function mapView(view: ImageEffectView) {
  return create(ImageEffectViewSchema, {
    logicalInvocationRef: view.logicalInvocationRef,
    modelInvocationCommandRef: view.modelInvocationCommandRef,
    ownerVersion: view.ownerVersion,
    currentAttemptOrdinal: view.currentAttemptOrdinal,
    state: state(view.state),
    ...(view.canonicalOutcomeEvidenceRef === undefined ? {} : {
      canonicalOutcomeEvidenceRef: view.canonicalOutcomeEvidenceRef,
    }),
    ...(view.usageEvidenceRef === undefined ? {} : { usageEvidenceRef: view.usageEvidenceRef }),
    ...(view.canonicalOutcomeEvidenceDigest === undefined ? {} : {
      canonicalOutcomeEvidenceDigest: view.canonicalOutcomeEvidenceDigest,
    }),
    ...(view.usageEvidenceDigest === undefined ? {} : { usageEvidenceDigest: view.usageEvidenceDigest }),
    observedAt: timestampFromDate(new Date(view.observedAt)),
  });
}

function state(value: ImageEffectView["state"]): ImageEffectState {
  const values: Readonly<Record<ImageEffectView["state"], ImageEffectState>> = {
    accepted: ImageEffectState.ACCEPTED,
    definitely_not_submitted: ImageEffectState.DEFINITELY_NOT_SUBMITTED,
    submitted: ImageEffectState.SUBMITTED,
    submission_unknown: ImageEffectState.SUBMISSION_UNKNOWN,
    running: ImageEffectState.RUNNING,
    succeeded: ImageEffectState.SUCCEEDED,
    failed: ImageEffectState.FAILED,
    cancel_requested: ImageEffectState.CANCEL_REQUESTED,
    canceled: ImageEffectState.CANCELED,
    outcome_unknown: ImageEffectState.OUTCOME_UNKNOWN,
  };
  return values[value];
}

function receiptKind(value: ImageEffectCommandResult["receipt"]["kind"]): ImageEffectReceiptKind {
  return value === "create_committed"
    ? ImageEffectReceiptKind.CREATE_COMMITTED
    : value === "attempt_authorization_attached"
      ? ImageEffectReceiptKind.ATTEMPT_AUTHORIZATION_ATTACHED
      : ImageEffectReceiptKind.CANCEL_INTENT_COMMITTED;
}

async function safe<Result>(work: () => Promise<Result>): Promise<Result> {
  try { return await work(); }
  catch (error) { throw connectError(error); }
}

function connectError(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  const value = error instanceof Error ? error.message : "";
  if (value.includes("ACCESS_DENIED") || value.includes("NOT_AUTHORIZED")) {
    return new ConnectError("image effect not authorized", Code.PermissionDenied);
  }
  if (value.includes("NOT_FOUND")) return new ConnectError("image effect command not found", Code.NotFound);
  if (value.includes("INVALID") || value.includes("ORDINAL")) {
    return new ConnectError("image effect command invalid", Code.InvalidArgument);
  }
  if (value.includes("CONFLICT") || value.includes("PREVIOUS_ATTEMPT_NOT_SAFE") ||
      value.includes("BUDGET")) {
    return new ConnectError("image effect command rejected", Code.FailedPrecondition);
  }
  return new ConnectError("image effect unavailable", Code.Unavailable);
}
