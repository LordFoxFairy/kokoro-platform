import { create, toBinary } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import {
  AttachNextAttemptAuthorizationResponseSchema,
  AttachNextAttemptAuthorizationEffectSchema,
  CanonicalImageEffectCommandReceiptV1Schema,
  CreateImageEffectEffectSchema,
  CreateImageEffectResponseSchema,
  GetImageEffectByCommandResponseSchema,
  GetImageEffectEvidenceResponseSchema,
  ImageEffectEvidenceFactSchema,
  ImageEffectEvidenceKind,
  ImageEffectOutputEvidenceSchema,
  ImageEffectCommandReceiptSchema,
  ImageEffectReceiptKind,
  ImageEffectState,
  ImageEffectV1Service,
  ImageEffectViewSchema,
  IssueImageEffectOutputAccessEffectSchema,
  IssueImageEffectOutputAccessResponseSchema,
  ReadImageEffectOutputResponseSchema,
  RecoverImageEffectOutputAccessByCommandResponseSchema,
  RecoverImageEffectByCommandResponseSchema,
  RequestCancelImageEffectResponseSchema,
  RequestCancelImageEffectEffectSchema,
} from "../../../../generated/proto/kokoro/platform/model/image/v1/image_effect_pb.js";
import type {
  CreateImageEffectCommand,
  ImageEffectAccessAuthorization,
  ImageEffectCommandDigestAuthority,
  ImageEffectCommandResult,
  ImageEffectService,
  ImageEffectView,
} from "../../application/image-effect-service.js";
import type { ImageEffectEvidenceService } from "../../application/image-effect-evidence-service.js";
import type {
  ImageEffectOutputAccessResult,
  ImageEffectOutputService,
} from "../../application/image-effect-output-service.js";
import type { ImageEffectEvidenceFact } from "../../domain/image-effect-evidence.js";
import type { ImageEffectOutputEvidenceIdentityAuthority } from "../../domain/image-effect-evidence.js";
import type { VerifiedModelGatewayCallerResolver } from "./model-gateway-connect-service.js";
import {
  attachNextAttemptAuthorizationRequestDigest,
  createImageEffectRequestDigest,
  imageEffectCommandReceiptDigest,
  imageEffectCommandReceiptRef,
  issueImageEffectOutputAccessRequestDigest,
  requestCancelImageEffectRequestDigest,
  type VerifiedModelImageEffectCommandAxes,
} from "../../../../generated/contracts/model-image-effect@v1/digest.js";

export type ImageEffectConnectService = ServiceImpl<typeof ImageEffectV1Service>;

export function createImageEffectConnectService(input: Readonly<{
  application: Pick<ImageEffectService, "create" | "recover" | "get" | "requestCancel" |
    "attachNextAttemptAuthorization">;
  evidence?: Pick<ImageEffectEvidenceService, "get">;
  output?: Pick<ImageEffectOutputService, "issue" | "recover" | "read">;
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
    getImageEffectEvidence: (request, context) => safe(async () => {
      authorize(context);
      if (input.evidence === undefined) {
        throw new ConnectError("image effect evidence owner not activated", Code.Unimplemented);
      }
      const page = await input.evidence.get({ callerAccessHandle: request.callerAccessHandle,
        logicalInvocationRef: request.logicalInvocationRef,
        afterEvidenceSequence: request.afterEvidenceSequence, limit: request.limit });
      return create(GetImageEffectEvidenceResponseSchema, { invocation: mapView(page.invocation),
        evidenceFacts: page.evidenceFacts.map(mapEvidenceFact),
        nextEvidenceSequence: page.nextEvidenceSequence, caughtUp: page.caughtUp });
    }),
    issueImageEffectOutputAccess: (request, context) => safe(async () => {
      authorize(context);
      if (input.output === undefined) {
        throw new ConnectError("image effect output access owner not activated", Code.Unimplemented);
      }
      const result = await input.output.issue({ callerAccessHandle: request.callerAccessHandle,
        outputAccessCommandRef: request.outputAccessCommandRef,
        logicalInvocationRef: request.logicalInvocationRef, outputEvidenceRef: request.outputEvidenceRef,
        outputEvidenceDigest: request.outputEvidenceDigest,
        callerRequestFingerprint: request.callerRequestFingerprint });
      return create(IssueImageEffectOutputAccessResponseSchema, outputAccessMessage(result));
    }),
    recoverImageEffectOutputAccessByCommand: (request, context) => safe(async () => {
      authorize(context);
      if (input.output === undefined) {
        throw new ConnectError("image effect output access owner not activated", Code.Unimplemented);
      }
      const result = await input.output.recover({ callerAccessHandle: request.callerAccessHandle,
        outputAccessCommandRef: request.outputAccessCommandRef });
      return create(RecoverImageEffectOutputAccessByCommandResponseSchema, outputAccessMessage(result));
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
    readImageEffectOutput: (request, context) => {
      authorize(context);
      if (input.output === undefined) {
        return failClosedStream(new ConnectError("image effect output data plane not activated", Code.Unimplemented));
      }
      return readOutput(input.output, request, context.signal);
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

async function* readOutput(
  output: Pick<ImageEffectOutputService, "read">,
  request: Readonly<{ sourceAccessHandle: string; outputEvidenceRef: string;
    outputEvidenceDigest: string; offset: bigint; maxBytes: number }>,
  signal: AbortSignal,
) {
  try {
    for await (const frame of output.read({ ...request, signal })) {
      yield create(ReadImageEffectOutputResponseSchema, frame);
    }
  } catch (error) { throw connectError(error); }
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
    issueOutput(
      input: Parameters<ImageEffectCommandDigestAuthority["issueOutput"]>[0],
      authorization: ImageEffectAccessAuthorization,
    ) {
      return issueImageEffectOutputAccessRequestDigest(
        create(IssueImageEffectOutputAccessEffectSchema, input), axes(authorization));
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

export function createGeneratedImageEffectOutputEvidenceIdentityAuthority():
ImageEffectOutputEvidenceIdentityAuthority {
  return (output, context) => {
    const record = create(ImageEffectOutputEvidenceSchema, {
      candidateOrdinal: context.candidateOrdinal, candidateRef: output.candidateRef,
      stableOutputSlotRef: output.stableOutputSlotRef,
      outputEvidenceRef: `image-effect-output:${context.logicalInvocationRef}:${context.attemptRef}:` +
        context.candidateOrdinal,
      outputEvidenceDigest: "0".repeat(64), mediaType: output.mediaType, width: output.width,
      height: output.height,
      ...(output.declaredByteSize === undefined ? {} : { declaredByteSize: output.declaredByteSize }),
    });
    const digest = createHash("sha256")
      .update("kokoro.platform.model.image.v1.ImageEffectOutputEvidence\0", "utf8")
      .update(toBinary(ImageEffectOutputEvidenceSchema, record))
      .digest("hex");
    return Object.freeze({ outputEvidenceRef: `image-effect-output:sha256:${digest}`,
      outputEvidenceDigest: digest });
  };
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
  const receipt = create(ImageEffectCommandReceiptSchema, {
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
  });
  return result.receipt.kind === "rejected" || result.receipt.kind === "outcome_unknown"
    ? { receipt }
    : { receipt, invocation: mapView(result.invocation) };
}

function outputAccessMessage(result: ImageEffectOutputAccessResult) {
  if (result.receipt.kind !== "output_access_issued") {
    throw new Error("IMAGE_EFFECT_OUTPUT_ACCESS_RECEIPT_KIND_CORRUPT");
  }
  return { receipt: mapReceipt(result.receipt), outputAccess: {
    outputEvidenceRef: result.outputAccess.outputEvidenceRef,
    outputEvidenceDigest: result.outputAccess.outputEvidenceDigest,
    sourceAccessHandle: result.outputAccess.sourceAccessHandle,
    sourceAccessExpiresAt: timestampFromDate(new Date(result.outputAccess.sourceAccessExpiresAt)),
    maxReadableBytes: result.outputAccess.maxReadableBytes,
  } };
}

function mapReceipt(receipt: ImageEffectCommandResult["receipt"]) {
  return create(ImageEffectCommandReceiptSchema, {
    callerCommandRef: receipt.callerCommandRef, kind: receiptKind(receipt.kind),
    logicalInvocationRef: receipt.logicalInvocationRef, attemptRef: receipt.attemptRef,
    attemptOrdinal: receipt.attemptOrdinal, receiptVersion: receipt.receiptVersion,
    recordedAt: timestampFromDate(new Date(receipt.recordedAt)), receiptRef: receipt.receiptRef,
    receiptDigest: receipt.receiptDigest, requestDigest: receipt.requestDigest,
  });
}

function mapEvidenceFact(fact: ImageEffectEvidenceFact) {
  return create(ImageEffectEvidenceFactSchema, { evidenceSequence: fact.evidenceSequence,
    kind: fact.kind === "outcome" ? ImageEffectEvidenceKind.OUTCOME
      : fact.kind === "usage" ? ImageEffectEvidenceKind.USAGE : ImageEffectEvidenceKind.OUTPUT,
    evidenceRef: fact.evidenceRef, evidenceDigest: fact.evidenceDigest,
    ...(fact.output === undefined ? {} : { output: create(ImageEffectOutputEvidenceSchema, {
      candidateOrdinal: fact.output.candidateOrdinal, candidateRef: fact.output.candidateRef,
      stableOutputSlotRef: fact.output.stableOutputSlotRef, outputEvidenceRef: fact.output.outputEvidenceRef,
      outputEvidenceDigest: fact.output.outputEvidenceDigest, mediaType: fact.output.mediaType,
      width: fact.output.width, height: fact.output.height,
      ...(fact.output.declaredByteSize === undefined ? {} : { declaredByteSize: fact.output.declaredByteSize }),
    }) }), recordedAt: timestampFromDate(new Date(fact.recordedAt)) });
}

function mapView(view: ImageEffectView) {
  return create(ImageEffectViewSchema, {
    logicalInvocationRef: view.logicalInvocationRef,
    modelInvocationCommandRef: view.modelInvocationCommandRef,
    ownerVersion: view.ownerVersion,
    currentAttemptOrdinal: view.currentAttemptOrdinal,
    // The current generated wire contract does not yet expose the Credit attempt fence.
    // Production activation remains blocked until Root regenerates this message with both fields.
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
  const values = {
    create_committed: ImageEffectReceiptKind.CREATE_COMMITTED,
    definitely_not_submitted: ImageEffectReceiptKind.DEFINITELY_NOT_SUBMITTED,
    attempt_authorization_attached: ImageEffectReceiptKind.ATTEMPT_AUTHORIZATION_ATTACHED,
    cancel_intent_committed: ImageEffectReceiptKind.CANCEL_INTENT_COMMITTED,
    rejected: ImageEffectReceiptKind.REJECTED,
    outcome_unknown: ImageEffectReceiptKind.OUTCOME_UNKNOWN,
    output_access_issued: ImageEffectReceiptKind.OUTPUT_ACCESS_ISSUED,
  } satisfies Readonly<Record<ImageEffectCommandResult["receipt"]["kind"], ImageEffectReceiptKind>>;
  const mapped = values[value];
  if (mapped === undefined) throw new Error("IMAGE_EFFECT_RECEIPT_KIND_CORRUPT");
  return mapped;
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
