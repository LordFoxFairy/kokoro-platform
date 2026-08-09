import { create, type DescMessage, type MessageShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { createValidator } from "@bufbuild/protovalidate";
import type { HandlerContext, ServiceImpl } from "@connectrpc/connect";
import {
  CommandDigestAlgorithmV2,
  CommandIdentityV2Schema,
  CommandReceiptStateV2,
  CommandReceiptV2Schema,
  type CommandIdentityV2,
} from "../../../../generated/proto/kokoro/common/v2/command_envelope_pb.js";
import type {
  AuthenticatedOperatorCommandContext,
  AuthenticatedOperatorQueryContext,
} from "../../../../generated/proto/kokoro/platform/admin/v2/admin_shared_pb.js";
import { AdminCommerceService } from
  "../../../../generated/proto/kokoro/platform/commerce/v1/admin_commerce_pb.js";
import {
  CommerceCommandDisposition,
  CommerceFulfillmentOutputKind,
  CommercePlanTermAction,
  CommerceProductKind,
  CreditProgramBucketClass,
  CreditProgramRevisionViewSchema,
  CreditProgramRolloverPolicy,
  CreditProgramWindowKind,
  EntitlementTemplateRevisionViewSchema,
  GetCreditProgramRevisionRequestSchema,
  GetCreditProgramRevisionResponseSchema,
  GetEntitlementTemplateRevisionRequestSchema,
  GetEntitlementTemplateRevisionResponseSchema,
  GetOfferRevisionRequestSchema,
  GetOfferRevisionResponseSchema,
  GetRedemptionProgramRevisionRequestSchema,
  GetRedemptionProgramRevisionResponseSchema,
  ListCreditProgramRevisionsRequestSchema,
  ListCreditProgramRevisionsResponseSchema,
  ListEntitlementTemplateRevisionsRequestSchema,
  ListEntitlementTemplateRevisionsResponseSchema,
  ListOfferRevisionsRequestSchema,
  ListOfferRevisionsResponseSchema,
  ListRedemptionProgramRevisionsRequestSchema,
  ListRedemptionProgramRevisionsResponseSchema,
  OfferRevisionViewSchema,
  PublishCreditProgramRevisionRequestSchema,
  PublishCreditProgramRevisionResponseSchema,
  PublishEntitlementTemplateRevisionRequestSchema,
  PublishEntitlementTemplateRevisionResponseSchema,
  PublishOfferRevisionRequestSchema,
  PublishOfferRevisionResponseSchema,
  PublishRedemptionProgramRevisionRequestSchema,
  PublishRedemptionProgramRevisionResponseSchema,
  RedemptionProgramAvailabilityState,
  RedemptionProgramRevisionViewSchema,
  type CommercePageRequest,
  type CommerceSiteCommandContext,
  type CommerceSiteQueryContext,
} from "../../../../generated/proto/kokoro/platform/commerce/v1/commerce_catalog_pb.js";
import {
  AbandonCodeBatchRequestSchema,
  AbandonCodeBatchResponseSchema,
  ActivateCodeBatchRequestSchema,
  ActivateCodeBatchResponseSchema,
  ApproveCodeBatchRequestSchema,
  ApproveCodeBatchResponseSchema,
  CodeBatchApprovalState,
  CodeBatchRecoveryAction,
  CodeBatchState,
  CodeBatchViewSchema,
  GetCodeBatchRequestSchema,
  GetCodeBatchResponseSchema,
  IssueCodeBatchRequestSchema,
  IssueCodeBatchResponseSchema,
  ListCodeBatchesRequestSchema,
  ListCodeBatchesResponseSchema,
  RevokeCodeBatchRequestSchema,
  RevokeCodeBatchResponseSchema,
  SuspendCodeBatchRequestSchema,
  SuspendCodeBatchResponseSchema,
} from "../../../../generated/proto/kokoro/platform/commerce/v1/commerce_control_pb.js";
import {
  verifyAbandonCodeBatchCommand,
  verifyActivateCodeBatchCommand,
  verifyApproveCodeBatchCommand,
  verifyIssueCodeBatchCommand,
  verifyPublishCreditProgramRevisionCommand,
  verifyPublishEntitlementTemplateRevisionCommand,
  verifyPublishOfferRevisionCommand,
  verifyPublishRedemptionProgramRevisionCommand,
  verifyRevokeCodeBatchCommand,
  verifySuspendCodeBatchCommand,
  type VerifiedCommerceSiteAxes,
} from "../../../../generated/contracts/platform-admin-commerce@v1/digest.js";
import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import {
  scopedBinding,
  type AdminPageCursorCodec,
  type AdminQueryPermit,
  type AdminQueryResolver,
} from "../../../admin/interfaces/connect/admin-query-service.js";
import type { CommerceAdministrationService } from "../../application/services/commerce-administration.js";
import type {
  CodeBatchRecord,
  CommerceAdministrationReader,
  CommerceOfferRecord,
  EntitlementTemplateRevisionRecord,
  RedemptionProgramRecord,
} from "../../infrastructure/postgres/commerce-administration-reader.js";
import type { CreditGrantProgramAdministrationRecord } from
  "../../application/contracts/credit-program-administration-reader.js";

const VALIDATOR = createValidator();
const CURSOR_KEYS = Object.freeze([
  "after_ref", "family", "first_observed_at", "permit", "site", "watermark",
]);

export type AdminCommerceConnectService = ServiceImpl<typeof AdminCommerceService>;
export type CommerceAdminCommandOperation =
  | "commerce.credit-program.publish"
  | "commerce.entitlement-template.publish"
  | "commerce.offer.publish"
  | "commerce.redemption-program.publish"
  | "commerce.code-batch.issue"
  | "commerce.code-batch.approve"
  | "commerce.code-batch.activate"
  | "commerce.code-batch.abandon"
  | "commerce.code-batch.suspend"
  | "commerce.code-batch.revoke";

export interface CommerceAdminResolver extends AdminQueryResolver {
  resolveCommerceCommand(
    claimed: AuthenticatedOperatorCommandContext,
    transport: HandlerContext,
    request: Readonly<{
      operation: CommerceAdminCommandOperation;
      siteRef: string;
      resourceRefs: readonly string[];
    }>,
  ): Promise<Readonly<{
    context: VerifiedRequestSecurityContext;
    axes: VerifiedCommerceSiteAxes;
  }>>;
}

type CommerceOwner = Pick<CommerceAdministrationService,
  "publishCreditProgramRevision" | "publishEntitlementTemplateRevision" | "publishOffer" |
  "publishProgram" | "issueBatch" | "approveBatch" | "activateBatch" | "abandonBatch" |
  "suspendBatch" | "revokeBatch">;

export function createAdminCommerceConnectService(input: Readonly<{
  owner: CommerceOwner;
  resolver: CommerceAdminResolver;
  reader: CommerceAdministrationReader;
  cursors: AdminPageCursorCodec;
}>): AdminCommerceConnectService {
  return {
    async publishCreditProgramRevision(request, transport) {
      validate(PublishCreditProgramRevisionRequestSchema, request, "COMMERCE_ADMIN_REQUEST_INVALID");
      const context = required(request.context); const effect = required(request.effect);
      const command = await resolveCommand(input, context, effect.creditProgramRevisionRef,
        "commerce.credit-program.publish", transport, (verified) =>
          verifyPublishCreditProgramRevisionCommand(context, effect, verified));
      const result = await input.owner.publishCreditProgramRevision({ ...command,
        creditProgramRevisionRef: effect.creditProgramRevisionRef, programRef: effect.programRef,
        revision: effect.revision.toString(), uxBucketClass: bucketFromWire(effect.uxBucketClass),
        unit: effect.unit, amount: effect.amount, burnPriority: effect.burnPriority,
        scopePolicy: { surfaceRefs: [...required(effect.scopePolicy).surfaceRefs],
          capabilityKeys: [...required(effect.scopePolicy).capabilityKeys],
          agentRefs: [...required(effect.scopePolicy).agentRefs],
          allowUnattributedAgent: required(effect.scopePolicy).allowUnattributedAgent },
        liabilityMerchantAccountRef: effect.liabilityMerchantAccountRef,
        rolloverPolicy: rolloverFromWire(effect.rolloverPolicy),
        calendarZone: effect.calendarZone ?? null, windowAnchor: effect.windowAnchor ?? null,
        expiresAfterSeconds: effect.expiresAfterSeconds?.toString() ?? null,
      });
      return validated(PublishCreditProgramRevisionResponseSchema, {
        receipt: receipt(result.command, result.recordedAt), disposition: disposition(result.kind),
        result: { creditProgramRevisionRef: result.creditProgramRevisionRef,
          revisionDigest: result.revisionDigest, publishedAt: timestamp(result.publishedAt) },
      });
    },

    async listCreditProgramRevisions(request, transport) {
      validate(ListCreditProgramRevisionsRequestSchema, request, "COMMERCE_ADMIN_REQUEST_INVALID");
      const authority = queryAuthority(request.context); const page = await resolvePage(input, authority,
        required(request.page), transport, "credit-program-revisions", "commerce.credit-program.read",
        creditProgramFields);
      const rows = await input.reader.listCreditProgramRevisions(page.permit, pageInput(page));
      return listResponse(ListCreditProgramRevisionsResponseSchema, input.cursors, page, rows,
        (row) => row.creditProgramRevisionRef, creditProgramMessage);
    },

    async getCreditProgramRevision(request, transport) {
      validate(GetCreditProgramRevisionRequestSchema, request, "COMMERCE_ADMIN_REQUEST_INVALID");
      const authority = queryAuthority(request.context);
      const permit = await resolveRead(input.resolver, authority, transport,
        "commerce.credit-program.read", authority.siteId,
        [authority.siteId, request.creditProgramRevisionRef], creditProgramFields);
      const row = await input.reader.getCreditProgramRevision(permit, authority.siteId,
        request.creditProgramRevisionRef);
      if (row === null) throw new Error("COMMERCE_ADMIN_CREDIT_PROGRAM_NOT_FOUND");
      return validated(GetCreditProgramRevisionResponseSchema, { revision: creditProgramMessage(row) });
    },

    async publishEntitlementTemplateRevision(request, transport) {
      validate(PublishEntitlementTemplateRevisionRequestSchema, request, "COMMERCE_ADMIN_REQUEST_INVALID");
      const context = required(request.context); const effect = required(request.effect);
      const command = await resolveCommand(input, context, effect.entitlementTemplateRevisionRef,
        "commerce.entitlement-template.publish", transport, (verified) =>
          verifyPublishEntitlementTemplateRevisionCommand(context, effect, verified));
      const result = await input.owner.publishEntitlementTemplateRevision({ ...command,
        entitlementTemplateRevisionRef: effect.entitlementTemplateRevisionRef,
        templateRef: effect.templateRef, revision: effect.revision.toString(),
        capabilityKey: effect.capabilityKey, safeLabel: effect.safeLabel,
        expiresAfterSeconds: effect.expiresAfterSeconds?.toString() ?? null,
      });
      return validated(PublishEntitlementTemplateRevisionResponseSchema, {
        receipt: receipt(result.command, result.recordedAt), disposition: disposition(result.kind),
        result: { entitlementTemplateRevisionRef: result.entitlementTemplateRevisionRef,
          revisionDigest: result.revisionDigest, publishedAt: timestamp(result.publishedAt) },
      });
    },

    async listEntitlementTemplateRevisions(request, transport) {
      validate(ListEntitlementTemplateRevisionsRequestSchema, request, "COMMERCE_ADMIN_REQUEST_INVALID");
      const authority = queryAuthority(request.context); const page = await resolvePage(input, authority,
        required(request.page), transport, "entitlement-template-revisions",
        "commerce.entitlement-template.read", entitlementFields);
      const rows = await input.reader.listEntitlementTemplateRevisions(page.permit, pageInput(page));
      return listResponse(ListEntitlementTemplateRevisionsResponseSchema, input.cursors, page, rows,
        (row) => row.entitlementTemplateRevisionRef, entitlementMessage);
    },

    async getEntitlementTemplateRevision(request, transport) {
      validate(GetEntitlementTemplateRevisionRequestSchema, request, "COMMERCE_ADMIN_REQUEST_INVALID");
      const authority = queryAuthority(request.context);
      const permit = await resolveRead(input.resolver, authority, transport,
        "commerce.entitlement-template.read", authority.siteId,
        [authority.siteId, request.entitlementTemplateRevisionRef], entitlementFields);
      const row = await input.reader.getEntitlementTemplateRevision(permit, authority.siteId,
        request.entitlementTemplateRevisionRef);
      if (row === null) throw new Error("COMMERCE_ADMIN_ENTITLEMENT_TEMPLATE_NOT_FOUND");
      return validated(GetEntitlementTemplateRevisionResponseSchema, { revision: entitlementMessage(row) });
    },

    async publishOfferRevision(request, transport) {
      validate(PublishOfferRevisionRequestSchema, request, "COMMERCE_ADMIN_REQUEST_INVALID");
      const context = required(request.context); const effect = required(request.effect);
      const command = await resolveCommand(input, context, effect.productVersionRef,
        "commerce.offer.publish", transport, (verified) =>
          verifyPublishOfferRevisionCommand(context, effect, verified));
      const result = await input.owner.publishOffer({ ...command,
        productRef: effect.productRef, productKind: productKindFromWire(effect.productKind),
        productVersionRef: effect.productVersionRef, productRevision: effect.productRevision.toString(),
        safeLabel: effect.safeLabel,
        planVersion: effect.planVersion === undefined ? null : {
          planRef: effect.planVersion.planRef, planVersionRef: effect.planVersion.planVersionRef,
          revision: effect.planVersion.revision.toString(), safeLabel: effect.planVersion.safeLabel,
          termAction: termActionFromWire(effect.planVersion.termAction),
          termSeconds: effect.planVersion.termSeconds?.toString() ?? null,
          stackingScope: effect.planVersion.stackingScope,
        },
        fulfillmentProgramRevisionRef: effect.fulfillmentProgramRevisionRef,
        fulfillmentProgramRef: effect.fulfillmentProgramRef,
        fulfillmentProgramRevision: effect.fulfillmentProgramRevision.toString(),
        outputs: effect.outputs.map((output) => ({ outputLineId: output.outputLineId,
          ordinal: output.ordinal, cardinality: output.cardinality,
          outputKind: outputKindFromWire(output.outputKind),
          targetRevisionRef: output.targetRevisionRef })),
        legalTermRefs: [...effect.legalTermRefs],
      });
      return validated(PublishOfferRevisionResponseSchema, {
        receipt: receipt(result.command, result.recordedAt), disposition: disposition(result.kind),
        result: { productVersionRef: result.productVersionRef, publishedAt: timestamp(result.publishedAt) },
      });
    },

    async listOfferRevisions(request, transport) {
      validate(ListOfferRevisionsRequestSchema, request, "COMMERCE_ADMIN_REQUEST_INVALID");
      const authority = queryAuthority(request.context); const page = await resolvePage(input, authority,
        required(request.page), transport, "offer-revisions", "commerce.offer.read", offerFields);
      const rows = await input.reader.listOffers(page.permit, pageInput(page));
      return listResponse(ListOfferRevisionsResponseSchema, input.cursors, page, rows,
        (row) => row.productVersionRef, offerMessage);
    },

    async getOfferRevision(request, transport) {
      validate(GetOfferRevisionRequestSchema, request, "COMMERCE_ADMIN_REQUEST_INVALID");
      const authority = queryAuthority(request.context);
      const permit = await resolveRead(input.resolver, authority, transport, "commerce.offer.read",
        authority.siteId, [authority.siteId, request.productVersionRef], offerFields);
      const row = await input.reader.getOffer(permit, authority.siteId, request.productVersionRef);
      if (row === null) throw new Error("COMMERCE_ADMIN_OFFER_NOT_FOUND");
      return validated(GetOfferRevisionResponseSchema, { revision: offerMessage(row) });
    },

    async publishRedemptionProgramRevision(request, transport) {
      validate(PublishRedemptionProgramRevisionRequestSchema, request, "COMMERCE_ADMIN_REQUEST_INVALID");
      const context = required(request.context); const effect = required(request.effect);
      const command = await resolveCommand(input, context, effect.redemptionProgramRevisionRef,
        "commerce.redemption-program.publish", transport, (verified) =>
          verifyPublishRedemptionProgramRevisionCommand(context, effect, verified));
      const result = await input.owner.publishProgram({ ...command,
        redemptionProgramRevisionRef: effect.redemptionProgramRevisionRef,
        programRef: effect.programRef, revision: effect.revision.toString(),
        productVersionRef: effect.productVersionRef,
        fulfillmentProgramRevisionRef: effect.fulfillmentProgramRevisionRef,
        maxRedemptionsPerAccount: effect.maxRedemptionsPerAccount,
      });
      return validated(PublishRedemptionProgramRevisionResponseSchema, {
        receipt: receipt(result.command, result.recordedAt), disposition: disposition(result.kind),
        result: { redemptionProgramRevisionRef: result.redemptionProgramRevisionRef,
          publishedAt: timestamp(result.publishedAt) },
      });
    },

    async listRedemptionProgramRevisions(request, transport) {
      validate(ListRedemptionProgramRevisionsRequestSchema, request, "COMMERCE_ADMIN_REQUEST_INVALID");
      const authority = queryAuthority(request.context); const page = await resolvePage(input, authority,
        required(request.page), transport, "redemption-program-revisions",
        "commerce.redemption-program.read", redemptionProgramFields);
      const rows = await input.reader.listRedemptionPrograms(page.permit, pageInput(page));
      return listResponse(ListRedemptionProgramRevisionsResponseSchema, input.cursors, page, rows,
        (row) => row.redemptionProgramRevisionRef, redemptionProgramMessage);
    },

    async getRedemptionProgramRevision(request, transport) {
      validate(GetRedemptionProgramRevisionRequestSchema, request, "COMMERCE_ADMIN_REQUEST_INVALID");
      const authority = queryAuthority(request.context);
      const permit = await resolveRead(input.resolver, authority, transport,
        "commerce.redemption-program.read", authority.siteId,
        [authority.siteId, request.redemptionProgramRevisionRef], redemptionProgramFields);
      const row = await input.reader.getRedemptionProgram(permit, authority.siteId,
        request.redemptionProgramRevisionRef);
      if (row === null) throw new Error("COMMERCE_ADMIN_REDEMPTION_PROGRAM_NOT_FOUND");
      return validated(GetRedemptionProgramRevisionResponseSchema, {
        revision: redemptionProgramMessage(row),
      });
    },

    async issueCodeBatch(request, transport) {
      validate(IssueCodeBatchRequestSchema, request, "COMMERCE_ADMIN_REQUEST_INVALID");
      const context = required(request.context); const effect = required(request.effect);
      const command = await resolveCommand(input, context, effect.batchRef, "commerce.code-batch.issue",
        transport, (verified) => verifyIssueCodeBatchCommand(context, effect, verified),
        [effect.redemptionProgramRevisionRef]);
      const result = await input.owner.issueBatch({ ...command, batchRef: effect.batchRef,
        redemptionProgramRevisionRef: effect.redemptionProgramRevisionRef, count: effect.count,
        startsAt: optionalTimestamp(effect.startsAt), endsAt: optionalTimestamp(effect.endsAt) });
      return validated(IssueCodeBatchResponseSchema, {
        receipt: receipt(result.command, result.recordedAt),
        disposition: result.kind === "secret_export" ? CommerceCommandDisposition.COMMITTED
          : CommerceCommandDisposition.REPLAYED,
        result: { batchRef: result.batchRef, codeCount: result.codeCount,
          redemptionProgramRevisionRef: result.redemptionProgramRevisionRef,
          createdByOperatorRef: result.createdByOperatorRef,
          ...(result.startsAt === null ? {} : { startsAt: timestamp(result.startsAt) }),
          ...(result.endsAt === null ? {} : { endsAt: timestamp(result.endsAt) }),
          exportedAt: timestamp(result.exportedAt) },
        delivery: result.kind === "secret_export"
          ? { case: "secretExport", value: { rawCodes: [...result.codes] } }
          : { case: "deliveryUnavailable", value: {
              requiredAction: CodeBatchRecoveryAction.ABANDON_AND_REISSUE,
            } },
      });
    },

    async approveCodeBatch(request, transport) {
      validate(ApproveCodeBatchRequestSchema, request, "COMMERCE_ADMIN_REQUEST_INVALID");
      const context = required(request.context); const effect = required(request.effect);
      const command = await resolveCommand(input, context, effect.batchRef, "commerce.code-batch.approve",
        transport, (verified) => verifyApproveCodeBatchCommand(context, effect, verified));
      const result = await input.owner.approveBatch({ ...command, batchRef: effect.batchRef });
      return validated(ApproveCodeBatchResponseSchema, mutationResponse(result));
    },

    async activateCodeBatch(request, transport) {
      validate(ActivateCodeBatchRequestSchema, request, "COMMERCE_ADMIN_REQUEST_INVALID");
      const context = required(request.context); const effect = required(request.effect);
      const command = await resolveCommand(input, context, effect.batchRef, "commerce.code-batch.activate",
        transport, (verified) => verifyActivateCodeBatchCommand(context, effect, verified));
      const result = await input.owner.activateBatch({ ...command, batchRef: effect.batchRef });
      return validated(ActivateCodeBatchResponseSchema, mutationResponse(result));
    },

    async abandonCodeBatch(request, transport) {
      validate(AbandonCodeBatchRequestSchema, request, "COMMERCE_ADMIN_REQUEST_INVALID");
      const context = required(request.context); const effect = required(request.effect);
      const command = await resolveCommand(input, context, effect.batchRef, "commerce.code-batch.abandon",
        transport, (verified) => verifyAbandonCodeBatchCommand(context, effect, verified));
      const result = await input.owner.abandonBatch({ ...command, batchRef: effect.batchRef,
        reason: effect.reason });
      return validated(AbandonCodeBatchResponseSchema, mutationResponse(result));
    },

    async suspendCodeBatch(request, transport) {
      validate(SuspendCodeBatchRequestSchema, request, "COMMERCE_ADMIN_REQUEST_INVALID");
      const context = required(request.context); const effect = required(request.effect);
      const command = await resolveCommand(input, context, effect.batchRef, "commerce.code-batch.suspend",
        transport, (verified) => verifySuspendCodeBatchCommand(context, effect, verified));
      const result = await input.owner.suspendBatch({ ...command, batchRef: effect.batchRef,
        reason: effect.reason });
      return validated(SuspendCodeBatchResponseSchema, mutationResponse(result));
    },

    async revokeCodeBatch(request, transport) {
      validate(RevokeCodeBatchRequestSchema, request, "COMMERCE_ADMIN_REQUEST_INVALID");
      const context = required(request.context); const effect = required(request.effect);
      const command = await resolveCommand(input, context, effect.batchRef, "commerce.code-batch.revoke",
        transport, (verified) => verifyRevokeCodeBatchCommand(context, effect, verified));
      const result = await input.owner.revokeBatch({ ...command, batchRef: effect.batchRef,
        reason: effect.reason });
      return validated(RevokeCodeBatchResponseSchema, mutationResponse(result));
    },

    async listCodeBatches(request, transport) {
      validate(ListCodeBatchesRequestSchema, request, "COMMERCE_ADMIN_REQUEST_INVALID");
      const authority = queryAuthority(request.context); const page = await resolvePage(input, authority,
        required(request.page), transport, "code-batches", "commerce.code-batch.read", codeBatchFields);
      const rows = await input.reader.listCodeBatches(page.permit, pageInput(page));
      return listResponse(ListCodeBatchesResponseSchema, input.cursors, page, rows,
        (row) => row.batchRef, codeBatchMessage);
    },

    async getCodeBatch(request, transport) {
      validate(GetCodeBatchRequestSchema, request, "COMMERCE_ADMIN_REQUEST_INVALID");
      const authority = queryAuthority(request.context);
      const permit = await resolveRead(input.resolver, authority, transport, "commerce.code-batch.read",
        authority.siteId, [authority.siteId, request.batchRef], codeBatchFields);
      const row = await input.reader.getCodeBatch(permit, authority.siteId, request.batchRef);
      if (row === null) throw new Error("COMMERCE_ADMIN_CODE_BATCH_NOT_FOUND");
      return validated(GetCodeBatchResponseSchema, { batch: codeBatchMessage(row) });
    },
  };
}

type ReadOperation = Extract<AdminQueryPermit["operation"], `commerce.${string}`>;
type OwnerCommand = Readonly<{
  commandId: string;
  environment: string;
  region: string;
  callerIdentity: string;
  operation: string;
  idempotencyKey: string;
  requestDigest: string;
}>;

interface ResolvedPage {
  readonly permit: AdminQueryPermit;
  readonly family: string;
  readonly siteId: string;
  readonly permitBinding: string;
  readonly watermark: string;
  readonly afterRef: string | null;
  readonly firstObservedAt: string;
  readonly limit: number;
}

async function resolveCommand(
  input: Parameters<typeof createAdminCommerceConnectService>[0],
  context: CommerceSiteCommandContext,
  targetRef: string,
  operation: CommerceAdminCommandOperation,
  transport: HandlerContext,
  verify: (axes: VerifiedCommerceSiteAxes) => string,
  additionalRefs: readonly string[] = [],
) {
  const operator = required(context.operator);
  const identity = commandIdentity(operator);
  const verified = await input.resolver.resolveCommerceCommand(operator, transport, {
    operation, siteRef: context.siteId, resourceRefs: [targetRef, ...additionalRefs],
  });
  const requestDigest = verify(verified.axes);
  if (requestDigest !== identity.requestDigest) throw new Error("COMMERCE_ADMIN_REQUEST_DIGEST_MISMATCH");
  return Object.freeze({
    context: verified.context,
    siteId: context.siteId,
    commandId: identity.commandId,
    idempotencyKey: identity.idempotencyKey,
    requestDigest,
  });
}

function commandIdentity(context: AuthenticatedOperatorCommandContext): CommandIdentityV2 {
  const identity = required(context.command);
  if (identity.digestAlgorithm !== CommandDigestAlgorithmV2.SHA256_COMMAND_ENVELOPE) {
    throw new Error("COMMERCE_ADMIN_DIGEST_ALGORITHM_INVALID");
  }
  return identity;
}

function queryAuthority(context: CommerceSiteQueryContext | undefined): Readonly<{
  operator: AuthenticatedOperatorQueryContext;
  siteId: string;
}> {
  const authority = required(context);
  return Object.freeze({ operator: required(authority.operator), siteId: authority.siteId });
}

async function resolveRead(
  resolver: AdminQueryResolver,
  authority: ReturnType<typeof queryAuthority>,
  transport: HandlerContext,
  operation: ReadOperation,
  siteId: string,
  resourceRefs: readonly string[],
  fieldRefs: readonly string[],
): Promise<AdminQueryPermit> {
  return resolver.resolve(authority.operator, transport, {
    operation, siteRef: siteId, resourceRefs, fieldRefs,
  });
}

async function resolvePage(
  input: Parameters<typeof createAdminCommerceConnectService>[0],
  authority: ReturnType<typeof queryAuthority>,
  page: CommercePageRequest,
  transport: HandlerContext,
  family: string,
  operation: ReadOperation,
  fields: readonly string[],
): Promise<ResolvedPage> {
  const cursor = page.pageToken === undefined ? null : input.cursors.decode(page.pageToken);
  if (cursor !== null) requireCursor(cursor);
  const permit = await resolveRead(input.resolver, authority, transport, operation, authority.siteId,
    [authority.siteId], fields);
  const permitBinding = scopedBinding(permit, authority.siteId);
  if (cursor !== null) {
    if (cursor.family !== family || cursor.site !== authority.siteId ||
        cursor.permit !== permitBinding || !catalogWatermark(cursor.watermark) ||
        !canonicalInstant(cursor.first_observed_at)) {
      throw new Error("COMMERCE_ADMIN_PAGE_TOKEN_INVALID");
    }
    return Object.freeze({ permit, family, siteId: authority.siteId, permitBinding,
      watermark: cursor.watermark!, afterRef: cursor.after_ref!,
      firstObservedAt: new Date(cursor.first_observed_at!).toISOString(), limit: page.pageSize });
  }
  const observation = await input.reader.observeCatalog(permit, authority.siteId);
  if (!catalogWatermark(observation.watermark) || !canonicalInstant(observation.observedAt)) {
    throw new Error("COMMERCE_ADMIN_WATERMARK_UNAVAILABLE");
  }
  return Object.freeze({ permit, family, siteId: authority.siteId, permitBinding,
    watermark: observation.watermark, afterRef: null,
    firstObservedAt: new Date(observation.observedAt).toISOString(), limit: page.pageSize });
}

function pageInput(page: ResolvedPage) {
  return Object.freeze({ siteId: page.siteId, afterRef: page.afterRef,
    watermark: page.watermark, limit: page.limit + 1 });
}

function listResponse<Row, Schema extends DescMessage>(
  schema: Schema,
  cursors: AdminPageCursorCodec,
  page: ResolvedPage,
  rows: readonly Row[],
  reference: (row: Row) => string,
  message: (row: Row) => unknown,
): MessageShape<Schema> {
  const visible = rows.slice(0, page.limit);
  const last = visible.at(-1);
  return validated(schema, {
    items: visible.map(message),
    ...(rows.length > page.limit && last !== undefined ? {
      nextPageToken: cursors.encode({
        family: page.family,
        site: page.siteId,
        permit: page.permitBinding,
        watermark: page.watermark,
        after_ref: reference(last),
        first_observed_at: page.firstObservedAt,
      }),
    } : {}),
    observedAt: timestamp(page.firstObservedAt),
  } as never);
}

function requireCursor(cursor: Readonly<Record<string, string>>): void {
  if (Object.keys(cursor).sort().join(",") !== [...CURSOR_KEYS].sort().join(",") ||
      cursor.after_ref === undefined || cursor.after_ref.length > 256) {
    throw new Error("COMMERCE_ADMIN_PAGE_TOKEN_INVALID");
  }
}

function receipt(command: OwnerCommand, recordedAt: string) {
  return create(CommandReceiptV2Schema, {
    identity: create(CommandIdentityV2Schema, {
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      digestAlgorithm: CommandDigestAlgorithmV2.SHA256_COMMAND_ENVELOPE,
      requestDigest: command.requestDigest,
    }),
    operation: command.operation,
    state: CommandReceiptStateV2.COMMITTED,
    recordedAt: timestamp(recordedAt),
  });
}

function mutationResponse(result: Awaited<ReturnType<CommerceAdministrationService["approveBatch"]>>) {
  return {
    receipt: receipt(result.command, result.recordedAt),
    disposition: disposition(result.kind),
    result: {
      batchRef: result.batchRef,
      state: batchState(result.state),
      ...(result.approvalState === undefined ? {} : {
        approvalState: CodeBatchApprovalState.APPROVED,
      }),
      changedAt: timestamp(result.changedAt),
    },
  };
}

function disposition(kind: "committed" | "replayed"): CommerceCommandDisposition {
  return kind === "committed" ? CommerceCommandDisposition.COMMITTED : CommerceCommandDisposition.REPLAYED;
}

function creditProgramMessage(row: CreditGrantProgramAdministrationRecord) {
  return create(CreditProgramRevisionViewSchema, {
    siteId: row.siteId,
    creditProgramRevisionRef: row.creditProgramRevisionRef,
    programRef: row.programRef,
    revision: row.revision,
    uxBucketClass: bucketToWire(row.uxBucketClass),
    unit: row.unit,
    amount: row.amount,
    burnPriority: row.burnPriority,
    scopePolicy: {
      policyVersion: 1,
      surfaceRefs: [...row.scopePolicy.surfaceRefs],
      capabilityKeys: [...row.scopePolicy.capabilityKeys],
      agentRefs: [...row.scopePolicy.agentRefs],
      allowUnattributedAgent: row.scopePolicy.allowUnattributedAgent,
    },
    liabilityMerchantAccountRef: row.liabilityMerchantAccountRef,
    windowKind: windowKind(row.windowKind),
    rolloverPolicy: CreditProgramRolloverPolicy.NONE,
    ...(row.calendarZone === null ? {} : { calendarZone: row.calendarZone }),
    ...(row.windowAnchor === null ? {} : { windowAnchor: row.windowAnchor }),
    ...(row.expiresAfterSeconds === null ? {} : { expiresAfterSeconds: row.expiresAfterSeconds }),
    revisionDigest: row.revisionDigest,
    publishedAt: timestamp(row.publishedAt),
  });
}

function entitlementMessage(row: EntitlementTemplateRevisionRecord) {
  return create(EntitlementTemplateRevisionViewSchema, {
    siteId: row.siteId,
    entitlementTemplateRevisionRef: row.entitlementTemplateRevisionRef,
    templateRef: row.templateRef,
    revision: row.revision,
    capabilityKey: row.capabilityKey,
    safeLabel: row.safeLabel,
    ...(row.expiresAfterSeconds === null ? {} : { expiresAfterSeconds: row.expiresAfterSeconds }),
    revisionDigest: row.revisionDigest,
    publishedAt: timestamp(row.publishedAt),
  });
}

function offerMessage(row: CommerceOfferRecord) {
  return create(OfferRevisionViewSchema, {
    siteId: row.siteId,
    productRef: row.productRef,
    productKind: productKindToWire(row.productKind),
    productVersionRef: row.productVersionRef,
    revision: row.revision,
    safeLabel: row.safeLabel,
    ...(row.planVersion === null ? {} : { planVersion: {
      planRef: row.planVersion.planRef,
      planVersionRef: row.planVersion.planVersionRef,
      revision: row.planVersion.revision,
      safeLabel: row.planVersion.safeLabel,
      termAction: termActionToWire(row.planVersion.termAction),
      ...(row.planVersion.termSeconds === null ? {} : { termSeconds: row.planVersion.termSeconds }),
      stackingScope: row.planVersion.stackingScope,
      revisionDigest: row.planVersion.revisionDigest,
    } }),
    fulfillmentProgramRevisionRef: row.fulfillmentProgramRevisionRef,
    outputs: row.outputs.map((output) => ({ outputLineId: output.outputLineId,
      ordinal: output.ordinal, cardinality: output.cardinality,
      outputKind: outputKindToWire(output.outputKind), targetRevisionRef: output.targetRevisionRef })),
    legalTermRefs: [...row.legalTermRefs],
    publishedAt: timestamp(row.publishedAt),
  });
}

function redemptionProgramMessage(row: RedemptionProgramRecord) {
  return create(RedemptionProgramRevisionViewSchema, {
    siteId: row.siteId,
    redemptionProgramRevisionRef: row.redemptionProgramRevisionRef,
    programRef: row.programRef,
    revision: row.revision,
    productVersionRef: row.productVersionRef,
    fulfillmentProgramRevisionRef: row.fulfillmentProgramRevisionRef,
    maxRedemptionsPerAccount: row.maxRedemptionsPerAccount,
    availabilityState: availability(row.availabilityState),
    publishedAt: timestamp(row.publishedAt),
  });
}

function codeBatchMessage(row: CodeBatchRecord) {
  return create(CodeBatchViewSchema, {
    siteId: row.siteId,
    batchRef: row.batchRef,
    redemptionProgramRevisionRef: row.redemptionProgramRevisionRef,
    state: batchState(row.state),
    approvalState: row.approvalState === "approved"
      ? CodeBatchApprovalState.APPROVED : CodeBatchApprovalState.PENDING,
    inventoryCount: row.inventoryCount,
    createdByOperatorRef: row.createdByOperatorRef,
    ...(row.startsAt === null ? {} : { startsAt: timestamp(row.startsAt) }),
    ...(row.endsAt === null ? {} : { endsAt: timestamp(row.endsAt) }),
    createdAt: timestamp(row.createdAt),
    ...(row.activatedAt === null ? {} : { activatedAt: timestamp(row.activatedAt) }),
    exportReceipt: {
      batchRef: row.exportReceipt.batchRef,
      exportCommandId: row.exportReceipt.exportCommandId,
      exportedToOperatorRef: row.exportReceipt.exportedToOperatorRef,
      codeCount: row.exportReceipt.codeCount,
      exportedAt: timestamp(row.exportReceipt.exportedAt),
    },
  });
}

function bucketFromWire(value: CreditProgramBucketClass) {
  if (value === CreditProgramBucketClass.DAILY) return "daily" as const;
  if (value === CreditProgramBucketClass.PERIOD) return "period" as const;
  if (value === CreditProgramBucketClass.PERMANENT) return "permanent" as const;
  throw new Error("COMMERCE_ADMIN_REQUEST_INVALID");
}
function bucketToWire(value: CreditGrantProgramAdministrationRecord["uxBucketClass"]) {
  return value === "daily" ? CreditProgramBucketClass.DAILY : value === "period"
    ? CreditProgramBucketClass.PERIOD : CreditProgramBucketClass.PERMANENT;
}
function rolloverFromWire(value: CreditProgramRolloverPolicy) {
  if (value !== CreditProgramRolloverPolicy.NONE) throw new Error("COMMERCE_ADMIN_REQUEST_INVALID");
  return "none" as const;
}
function windowKind(value: CreditGrantProgramAdministrationRecord["windowKind"]) {
  return value === "none" ? CreditProgramWindowKind.NONE : value === "daily"
    ? CreditProgramWindowKind.DAILY : CreditProgramWindowKind.PERIOD;
}
function productKindFromWire(value: CommerceProductKind): CommerceOfferRecord["productKind"] {
  if (value === CommerceProductKind.FREE) return "free";
  if (value === CommerceProductKind.CREDIT_PACK) return "credit_pack";
  if (value === CommerceProductKind.SUBSCRIPTION) return "subscription";
  if (value === CommerceProductKind.BUNDLE) return "bundle";
  throw new Error("COMMERCE_ADMIN_REQUEST_INVALID");
}
function productKindToWire(value: CommerceOfferRecord["productKind"]) {
  if (value === "free") return CommerceProductKind.FREE;
  if (value === "credit_pack") return CommerceProductKind.CREDIT_PACK;
  if (value === "subscription") return CommerceProductKind.SUBSCRIPTION;
  return CommerceProductKind.BUNDLE;
}
function termActionFromWire(value: CommercePlanTermAction): NonNullable<CommerceOfferRecord["planVersion"]>["termAction"] {
  if (value === CommercePlanTermAction.NONE) return "none";
  if (value === CommercePlanTermAction.NEW_SUBSCRIPTION) return "new_subscription";
  if (value === CommercePlanTermAction.EXTEND_FROM_MAX) return "extend_from_max";
  if (value === CommercePlanTermAction.REJECT_IF_ACTIVE) return "reject_if_active";
  throw new Error("COMMERCE_ADMIN_REQUEST_INVALID");
}
function termActionToWire(value: NonNullable<CommerceOfferRecord["planVersion"]>["termAction"]) {
  if (value === "none") return CommercePlanTermAction.NONE;
  if (value === "new_subscription") return CommercePlanTermAction.NEW_SUBSCRIPTION;
  if (value === "extend_from_max") return CommercePlanTermAction.EXTEND_FROM_MAX;
  return CommercePlanTermAction.REJECT_IF_ACTIVE;
}
function outputKindFromWire(value: CommerceFulfillmentOutputKind): CommerceOfferRecord["outputs"][number]["outputKind"] {
  if (value === CommerceFulfillmentOutputKind.SUBSCRIPTION_TERM) return "subscription_term";
  if (value === CommerceFulfillmentOutputKind.ENTITLEMENT_GRANT) return "entitlement_grant";
  if (value === CommerceFulfillmentOutputKind.CREDIT_GRANT) return "credit_grant";
  if (value === CommerceFulfillmentOutputKind.CREDIT_PROGRAM_ENROLLMENT) {
    return "credit_program_enrollment";
  }
  throw new Error("COMMERCE_ADMIN_REQUEST_INVALID");
}
function outputKindToWire(value: CommerceOfferRecord["outputs"][number]["outputKind"]) {
  if (value === "subscription_term") return CommerceFulfillmentOutputKind.SUBSCRIPTION_TERM;
  if (value === "entitlement_grant") return CommerceFulfillmentOutputKind.ENTITLEMENT_GRANT;
  if (value === "credit_grant") return CommerceFulfillmentOutputKind.CREDIT_GRANT;
  return CommerceFulfillmentOutputKind.CREDIT_PROGRAM_ENROLLMENT;
}
function availability(value: RedemptionProgramRecord["availabilityState"]) {
  if (value === "active") return RedemptionProgramAvailabilityState.ACTIVE;
  if (value === "paused") return RedemptionProgramAvailabilityState.PAUSED;
  if (value === "retired") return RedemptionProgramAvailabilityState.RETIRED;
  throw new Error("COMMERCE_ADMIN_ROW_CORRUPT");
}
function batchState(value: CodeBatchRecord["state"]) {
  if (value === "draft") return CodeBatchState.DRAFT;
  if (value === "active") return CodeBatchState.ACTIVE;
  if (value === "suspended") return CodeBatchState.SUSPENDED;
  if (value === "abandoned") return CodeBatchState.ABANDONED;
  return CodeBatchState.REVOKED;
}

function validate<Schema extends DescMessage>(schema: Schema, value: MessageShape<Schema>, code: string): void {
  if (VALIDATOR.validate(schema, value).kind !== "valid") throw new Error(code);
}
function validated<Schema extends DescMessage>(schema: Schema, value: Parameters<typeof create<Schema>>[1]): MessageShape<Schema> {
  const message = create(schema, value);
  validate(schema, message, "COMMERCE_ADMIN_RESPONSE_INVALID");
  return message;
}
function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("COMMERCE_ADMIN_REQUEST_INVALID");
  return value;
}
function timestamp(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error("COMMERCE_ADMIN_TIME_INVALID");
  }
  return timestampFromDate(date);
}
function optionalTimestamp(value: Readonly<{ seconds: bigint; nanos: number }> | undefined): string | null {
  if (value === undefined) return null;
  const millis = Number(value.seconds) * 1000 + Math.floor(value.nanos / 1_000_000);
  if (!Number.isSafeInteger(millis)) throw new Error("COMMERCE_ADMIN_TIME_INVALID");
  return new Date(millis).toISOString();
}
function canonicalInstant(value: string | undefined): value is string {
  if (value === undefined) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
function catalogWatermark(value: string | undefined): value is string {
  return value !== undefined && /^(?:0|[1-9][0-9]*)$/u.test(value) &&
    BigInt(value) <= 9_223_372_036_854_775_807n;
}

const creditProgramFields = Object.freeze([
  "site_ref", "credit_program_revision_ref", "program_ref", "revision", "ux_bucket_class",
  "unit", "amount", "burn_priority", "scope_policy", "liability_merchant_account_ref",
  "window_kind", "rollover_policy", "calendar_zone", "window_anchor",
  "expires_after_seconds", "revision_digest", "published_at",
]);
const entitlementFields = Object.freeze([
  "site_ref", "entitlement_template_revision_ref", "template_ref", "revision",
  "capability_key", "safe_label", "expires_after_seconds", "revision_digest", "published_at",
]);
const offerFields = Object.freeze([
  "site_ref", "product_ref", "product_kind", "product_version_ref", "revision", "safe_label",
  "plan_version", "fulfillment_program_revision_ref", "outputs", "legal_term_refs", "published_at",
]);
const redemptionProgramFields = Object.freeze([
  "site_ref", "redemption_program_revision_ref", "program_ref", "revision",
  "product_version_ref", "fulfillment_program_revision_ref", "max_redemptions_per_account",
  "availability_state", "published_at",
]);
const codeBatchFields = Object.freeze([
  "site_ref", "batch_ref", "redemption_program_revision_ref", "state", "approval_state",
  "inventory_count", "created_by_operator_ref", "starts_at", "ends_at", "created_at",
  "activated_at", "export_receipt",
]);
