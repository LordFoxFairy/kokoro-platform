import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { HandlerContext, ServiceImpl } from "@connectrpc/connect";
import { withCommandReceiptConflictMapping } from
  "../../../../interfaces/connect/command-receipt-conflict.js";
import {
  AdminCommerceService,
  CodeBatchApprovalState,
  CodeBatchMutationResultSchema,
  CodeBatchState,
  CodeBatchSummarySchema,
  CodeDeliveryState,
  CodeExportReceiptSchema,
  CreditBucketClass,
  CreditRolloverPolicy,
  CreditProgramRevisionSummarySchema,
  CreditScopePolicySchema,
  EntitlementTemplateRevisionSummarySchema,
  FulfillmentOutputDraftSchema,
  FulfillmentOutputKind,
  OfferSummarySchema,
  PermanentCreditWindowPolicySchema,
  PlanTermAction,
  ProductKind,
  RecurringCreditWindowPolicySchema,
  RedemptionProgramSummarySchema,
  type CodeBatchActionEffect,
  type FulfillmentOutputDraft,
  type PublishCreditProgramRevisionEffect,
} from "../../../../interfaces/connect/generated-admin-commerce/kokoro/platform/commerce/v1/admin_commerce_pb.js";
import {
  CommandDigestAlgorithmV2,
  CommandReceiptStateV2,
  CommandReceiptV2Schema,
} from "../../../../interfaces/connect/generated-admin-commerce/kokoro/common/v2/command_envelope_pb.js";
import {
  abandonCodeBatchRequestDigest,
  activateCodeBatchRequestDigest,
  approveCodeBatchRequestDigest,
  issueCodeBatchRequestDigest,
  publishCreditProgramRevisionRequestDigest,
  publishEntitlementTemplateRevisionRequestDigest,
  publishOfferRequestDigest,
  publishRedemptionProgramRequestDigest,
  revokeCodeBatchRequestDigest,
  suspendCodeBatchRequestDigest,
  type VerifiedAuthenticatedAdminAxes,
} from "../../../../interfaces/connect/generated-admin-commerce/command-envelope-digest.js";
import type { AuthenticatedOperatorCommandContext, AuthenticatedOperatorQueryContext } from
  "../../../../interfaces/connect/generated-admin-commerce/kokoro/platform/admin/v2/admin_shared_pb.js";
import type { AdminControlPlaneResolver, CommerceAdminCommandOperation } from
  "../../../admin/infrastructure/security/admin-control-plane-resolver.js";
import type { AdminPageCursorCodec, AdminQueryPermit } from
  "../../../admin/interfaces/connect/admin-query-service.js";
import { scopedBinding } from "../../../admin/interfaces/connect/admin-query-service.js";
import type { CommerceAdministrationService } from "../../application/services/commerce-administration.js";
import type {
  CodeBatchRecord,
  CommerceAdministrationReader,
  CommerceOfferRecord,
  EntitlementTemplateRevisionRecord,
  RedemptionProgramRecord,
} from "../../infrastructure/postgres/commerce-administration-reader.js";
import type { CreditGrantProgramAdministrationRecord as CreditProgramRevisionRecord } from
  "../../application/contracts/credit-program-administration-reader.js";

export type AdminCommerceConnectService = ServiceImpl<typeof AdminCommerceService>;

export function createAdminCommerceConnectService(input: Readonly<{
  resolver: AdminControlPlaneResolver;
  owner: CommerceAdministrationService;
  reader: CommerceAdministrationReader;
  cursors: AdminPageCursorCodec;
  clock?: () => Date;
}>): AdminCommerceConnectService {
  const now = input.clock ?? (() => new Date());
  return {
    async publishCreditProgramRevision(request, transport) {
      const context = commandContext(request.context);
      const effect = required(request.effect, "COMMERCE_CREDIT_PROGRAM_EFFECT_REQUIRED");
      const verified = await command(input.resolver, context, transport, "commerce.credit-program.publish",
        request.siteId, [effect.creditProgramRevisionRef, effect.programRef]);
      verifyDigest(context, publishCreditProgramRevisionRequestDigest(
        context, request.siteId, effect, verified.axes));
      const scopePolicy = required(effect.scopePolicy, "COMMERCE_CREDIT_SCOPE_POLICY_REQUIRED");
      const canonicalScopePolicy = scopePolicyFromWire(scopePolicy);
      const uxBucketClass = bucketFromWire(effect.uxBucketClass);
      const window = creditWindowFromWire(effect, uxBucketClass);
      const result = await withCommandReceiptConflictMapping(() => input.owner.publishCreditProgramRevision({ context: verified.context, ...identity(context),
        requestDigest: context.command!.requestDigest, siteId: request.siteId,
        creditProgramRevisionRef: effect.creditProgramRevisionRef, programRef: effect.programRef,
        revision: effect.revision.toString(), uxBucketClass,
        unit: effect.unit, amount: effect.amount, burnPriority: effect.burnPriority,
        scopePolicy: canonicalScopePolicy,
        liabilityMerchantAccountRef: effect.liabilityMerchantAccountRef, ...window }));
      return { receipt: receipt(context, result.command.operation, result.recordedAt, result.command),
        creditProgramRevision: creditProgramMessage({ siteId: request.siteId,
          creditProgramRevisionRef: result.creditProgramRevisionRef, programRef: effect.programRef,
          revision: effect.revision, uxBucketClass,
          unit: effect.unit, amount: effect.amount, burnPriority: effect.burnPriority,
          scopePolicy: { version: 1, ...canonicalScopePolicy },
          liabilityMerchantAccountRef: effect.liabilityMerchantAccountRef, ...window,
          expiresAfterSeconds: window.expiresAfterSeconds === null ? null : BigInt(window.expiresAfterSeconds),
          revisionDigest: result.revisionDigest, publishedAt: result.publishedAt }) };
    },

    async listCreditProgramRevisions(request, transport) {
      const resolved = await pageInput(input, queryContext(request.context), transport,
        "commerce.credit-program.read", request.siteId, request.pageToken, request.pageSize,
        "credit-program-revisions", now);
      const rows = await input.reader.listCreditProgramRevisions(resolved.permit, { siteId: request.siteId,
        afterRef: resolved.after, watermark: resolved.watermark, limit: resolved.limit + 1 });
      return pageResult(rows, resolved, input.cursors, "credit-program-revisions",
        (row) => row.creditProgramRevisionRef, creditProgramMessage,
        "creditProgramRevisions");
    },

    async getCreditProgramRevision(request, transport) {
      const permit = await query(input.resolver, queryContext(request.context), transport,
        "commerce.credit-program.read", request.siteId,
        [request.siteId, request.creditProgramRevisionRef]);
      const row = await input.reader.getCreditProgramRevision(
        permit, request.siteId, request.creditProgramRevisionRef);
      if (row === null) throw new Error("COMMERCE_CREDIT_PROGRAM_NOT_FOUND");
      return { creditProgramRevision: creditProgramMessage(row) };
    },

    async publishEntitlementTemplateRevision(request, transport) {
      const context = commandContext(request.context);
      const effect = required(request.effect, "COMMERCE_ENTITLEMENT_TEMPLATE_EFFECT_REQUIRED");
      const verified = await command(input.resolver, context, transport,
        "commerce.entitlement-template.publish", request.siteId,
        [effect.entitlementTemplateRevisionRef, effect.templateRef]);
      verifyDigest(context, publishEntitlementTemplateRevisionRequestDigest(
        context, request.siteId, effect, verified.axes));
      const result = await withCommandReceiptConflictMapping(() => input.owner.publishEntitlementTemplateRevision({ context: verified.context,
        ...identity(context), requestDigest: context.command!.requestDigest, siteId: request.siteId,
        entitlementTemplateRevisionRef: effect.entitlementTemplateRevisionRef,
        templateRef: effect.templateRef, revision: effect.revision.toString(),
        capabilityKey: effect.capabilityKey, safeLabel: effect.safeLabel,
        expiresAfterSeconds: effect.expiresAfterSeconds?.toString() ?? null }));
      return { receipt: receipt(context, result.command.operation, result.recordedAt, result.command),
        entitlementTemplateRevision: entitlementTemplateMessage({ siteId: request.siteId,
          entitlementTemplateRevisionRef: result.entitlementTemplateRevisionRef,
          templateRef: effect.templateRef, revision: effect.revision,
          capabilityKey: effect.capabilityKey, safeLabel: effect.safeLabel,
          expiresAfterSeconds: effect.expiresAfterSeconds ?? null,
          revisionDigest: result.revisionDigest, publishedAt: result.publishedAt }) };
    },

    async listEntitlementTemplateRevisions(request, transport) {
      const resolved = await pageInput(input, queryContext(request.context), transport,
        "commerce.entitlement-template.read", request.siteId, request.pageToken, request.pageSize,
        "entitlement-template-revisions", now);
      const rows = await input.reader.listEntitlementTemplateRevisions(resolved.permit, { siteId: request.siteId,
        afterRef: resolved.after, watermark: resolved.watermark, limit: resolved.limit + 1 });
      return pageResult(rows, resolved, input.cursors, "entitlement-template-revisions",
        (row) => row.entitlementTemplateRevisionRef, entitlementTemplateMessage,
        "entitlementTemplateRevisions");
    },

    async getEntitlementTemplateRevision(request, transport) {
      const permit = await query(input.resolver, queryContext(request.context), transport,
        "commerce.entitlement-template.read", request.siteId,
        [request.siteId, request.entitlementTemplateRevisionRef]);
      const row = await input.reader.getEntitlementTemplateRevision(
        permit, request.siteId, request.entitlementTemplateRevisionRef);
      if (row === null) throw new Error("COMMERCE_ENTITLEMENT_TEMPLATE_NOT_FOUND");
      return { entitlementTemplateRevision: entitlementTemplateMessage(row) };
    },

    async publishOffer(request, transport) {
      const context = commandContext(request.context); const effect = required(request.effect, "COMMERCE_OFFER_EFFECT_REQUIRED");
      const verified = await command(input.resolver, context, transport, "commerce.offer.publish", request.siteId,
        [effect.productVersionRef, effect.fulfillmentProgramRevisionRef]);
      verifyDigest(context, publishOfferRequestDigest(context, request.siteId, effect, verified.axes));
      const result = await withCommandReceiptConflictMapping(() => input.owner.publishOffer({ context: verified.context, ...identity(context), siteId: request.siteId,
        requestDigest: context.command!.requestDigest, productRef: effect.productRef,
        productKind: productKindFromWire(effect.productKind), productVersionRef: effect.productVersionRef,
        productRevision: effect.productRevision.toString(), safeLabel: effect.safeLabel,
        planVersion: effect.planVersion === undefined ? null : { planRef: effect.planVersion.planRef,
          planVersionRef: effect.planVersion.planVersionRef, revision: effect.planVersion.revision.toString(),
          safeLabel: effect.planVersion.safeLabel, termAction: planActionFromWire(effect.planVersion.termAction),
          termSeconds: effect.planVersion.termSeconds?.toString() ?? null,
          stackingScope: effect.planVersion.stackingScope },
        fulfillmentProgramRevisionRef: effect.fulfillmentProgramRevisionRef,
        fulfillmentProgramRef: effect.fulfillmentProgramRef,
        fulfillmentProgramRevision: effect.fulfillmentProgramRevision.toString(),
        outputs: effect.outputs.map(outputFromWire), legalTermRefs: effect.legalTermRefs }));
      return { receipt: receipt(context, result.command.operation, result.recordedAt, result.command),
        offer: offerMessage({ siteId: request.siteId, productRef: effect.productRef,
          productKind: productKindFromWire(effect.productKind), productVersionRef: effect.productVersionRef,
          revision: effect.productRevision, safeLabel: effect.safeLabel,
          planVersionRef: effect.planVersion?.planVersionRef ?? null,
          fulfillmentProgramRevisionRef: effect.fulfillmentProgramRevisionRef,
          outputs: effect.outputs.map(outputFromWire), legalTermRefs: effect.legalTermRefs,
          publishedAt: result.publishedAt }) };
    },

    async listOffers(request, transport) {
      const context = queryContext(request.context); const page = pageInput(input, context, transport,
        "commerce.offer.read", request.siteId, request.pageToken, request.pageSize, "offers", now);
      const resolved = await page;
      const rows = await input.reader.listOffers(resolved.permit, { siteId: request.siteId,
        afterRef: resolved.after, watermark: resolved.watermark, limit: resolved.limit + 1 });
      return pageResult(rows, resolved, input.cursors, "offers", (row) => row.productVersionRef, offerMessage, "offers");
    },

    async getOffer(request, transport) {
      const permit = await query(input.resolver, queryContext(request.context), transport, "commerce.offer.read",
        request.siteId, [request.siteId, request.productVersionRef]);
      const row = await input.reader.getOffer(permit, request.siteId, request.productVersionRef);
      if (row === null) throw new Error("COMMERCE_OFFER_NOT_FOUND");
      return { offer: offerMessage(row) };
    },

    async publishRedemptionProgram(request, transport) {
      const context = commandContext(request.context); const effect = required(request.effect, "COMMERCE_PROGRAM_EFFECT_REQUIRED");
      const verified = await command(input.resolver, context, transport, "commerce.redemption-program.publish",
        request.siteId, [effect.redemptionProgramRevisionRef]);
      verifyDigest(context, publishRedemptionProgramRequestDigest(context, request.siteId, effect, verified.axes));
      const result = await withCommandReceiptConflictMapping(() => input.owner.publishProgram({ context: verified.context, ...identity(context),
        requestDigest: context.command!.requestDigest, siteId: request.siteId,
        redemptionProgramRevisionRef: effect.redemptionProgramRevisionRef, programRef: effect.programRef,
        revision: effect.revision.toString(), productVersionRef: effect.productVersionRef,
        fulfillmentProgramRevisionRef: effect.fulfillmentProgramRevisionRef,
        maxRedemptionsPerAccount: effect.maxRedemptionsPerAccount }));
      const publishedAt = result.publishedAt;
      return { receipt: receipt(context, result.command.operation, result.recordedAt, result.command),
        program: programMessage({ siteId: request.siteId,
          redemptionProgramRevisionRef: effect.redemptionProgramRevisionRef, programRef: effect.programRef,
          revision: effect.revision, productVersionRef: effect.productVersionRef,
          fulfillmentProgramRevisionRef: effect.fulfillmentProgramRevisionRef,
          maxRedemptionsPerAccount: effect.maxRedemptionsPerAccount, availabilityState: "active", publishedAt }) };
    },

    async listRedemptionPrograms(request, transport) {
      const resolved = await pageInput(input, queryContext(request.context), transport,
        "commerce.redemption-program.read", request.siteId, request.pageToken, request.pageSize, "programs", now);
      const rows = await input.reader.listRedemptionPrograms(resolved.permit, { siteId: request.siteId,
        afterRef: resolved.after, watermark: resolved.watermark, limit: resolved.limit + 1 });
      return pageResult(rows, resolved, input.cursors, "programs", (row) => row.redemptionProgramRevisionRef,
        programMessage, "programs");
    },

    async getRedemptionProgram(request, transport) {
      const permit = await query(input.resolver, queryContext(request.context), transport,
        "commerce.redemption-program.read", request.siteId,
        [request.siteId, request.redemptionProgramRevisionRef]);
      const row = await input.reader.getRedemptionProgram(permit, request.siteId, request.redemptionProgramRevisionRef);
      if (row === null) throw new Error("COMMERCE_REDEMPTION_PROGRAM_NOT_FOUND");
      return { program: programMessage(row) };
    },

    async issueCodeBatch(request, transport) {
      const context = commandContext(request.context); const effect = required(request.effect, "COMMERCE_BATCH_EFFECT_REQUIRED");
      const verified = await command(input.resolver, context, transport, "commerce.code-batch.issue",
        request.siteId, [effect.batchRef, effect.redemptionProgramRevisionRef]);
      verifyDigest(context, issueCodeBatchRequestDigest(context, request.siteId, effect, verified.axes));
      const result = await withCommandReceiptConflictMapping(() => input.owner.issueBatch({ context: verified.context, ...identity(context),
        requestDigest: context.command!.requestDigest, siteId: request.siteId, batchRef: effect.batchRef,
        redemptionProgramRevisionRef: effect.redemptionProgramRevisionRef, count: effect.count,
        startsAt: optionalTimestamp(effect.startsAt), endsAt: optionalTimestamp(effect.endsAt) }));
      const batch = batchMessage({ siteId: request.siteId, batchRef: result.batchRef,
        redemptionProgramRevisionRef: result.redemptionProgramRevisionRef, state: "draft",
        approvalState: "pending", inventoryCount: result.codeCount, createdByOperatorRef: result.createdByOperatorRef,
        startsAt: result.startsAt, endsAt: result.endsAt,
        createdAt: result.exportedAt, activatedAt: null,
        exportReceipt: { batchRef: result.batchRef, exportCommandId: result.command.commandId,
          exportedToOperatorRef: result.createdByOperatorRef, codeCount: result.codeCount, exportedAt: result.exportedAt } });
      return { receipt: receipt(context, result.command.operation, result.recordedAt, result.command),
        deliveryState: result.kind === "secret_export" ? CodeDeliveryState.SECRET_EXPORT : CodeDeliveryState.DELIVERY_UNAVAILABLE,
        batch, rawCodes: result.kind === "secret_export" ? [...result.codes] : [] };
    },

    async listCodeBatches(request, transport) {
      const resolved = await pageInput(input, queryContext(request.context), transport,
        "commerce.code-batch.read", request.siteId, request.pageToken, request.pageSize, "batches", now);
      const rows = await input.reader.listCodeBatches(resolved.permit, { siteId: request.siteId,
        afterRef: resolved.after, watermark: resolved.watermark, limit: resolved.limit + 1 });
      return pageResult(rows, resolved, input.cursors, "batches", (row) => row.batchRef, batchMessage, "batches");
    },

    async getCodeBatch(request, transport) {
      const permit = await query(input.resolver, queryContext(request.context), transport,
        "commerce.code-batch.read", request.siteId, [request.siteId, request.batchRef]);
      const row = await input.reader.getCodeBatch(permit, request.siteId, request.batchRef);
      if (row === null) throw new Error("COMMERCE_CODE_BATCH_NOT_FOUND");
      return { batch: batchMessage(row) };
    },

    approveCodeBatch: (request, transport) => batchCommand(input, request, transport, "approve",
      approveCodeBatchRequestDigest, CodeBatchState.DRAFT, CodeBatchApprovalState.APPROVED, now),
    activateCodeBatch: (request, transport) => batchCommand(input, request, transport, "activate",
      activateCodeBatchRequestDigest, CodeBatchState.ACTIVE, CodeBatchApprovalState.APPROVED, now),
    abandonCodeBatch: (request, transport) => batchCommand(input, request, transport, "abandon",
      abandonCodeBatchRequestDigest, CodeBatchState.ABANDONED, undefined, now),
    suspendCodeBatch: (request, transport) => batchCommand(input, request, transport, "suspend",
      suspendCodeBatchRequestDigest, CodeBatchState.SUSPENDED, CodeBatchApprovalState.APPROVED, now),
    revokeCodeBatch: (request, transport) => batchCommand(input, request, transport, "revoke",
      revokeCodeBatchRequestDigest, CodeBatchState.REVOKED, CodeBatchApprovalState.APPROVED, now),
  };
}

type CommandRequest = Readonly<{ context?: AuthenticatedOperatorCommandContext | undefined; siteId: string;
  effect?: CodeBatchActionEffect | undefined }>;
type BatchDigest = (context: AuthenticatedOperatorCommandContext, siteId: string,
  effect: CodeBatchActionEffect, axes: VerifiedAuthenticatedAdminAxes) => string;
async function batchCommand(input: Parameters<typeof createAdminCommerceConnectService>[0], request: CommandRequest,
  transport: HandlerContext, action: "approve" | "activate" | "abandon" | "suspend" | "revoke",
  digest: BatchDigest, _state: CodeBatchState, _approval: CodeBatchApprovalState | undefined,
  _now: () => Date) {
  const context = commandContext(request.context); const effect = required(request.effect, "COMMERCE_BATCH_EFFECT_REQUIRED");
  const operation = `commerce.code-batch.${action}` as CommerceAdminCommandOperation;
  const verified = await command(input.resolver, context, transport, operation, request.siteId, [effect.batchRef]);
  verifyDigest(context, digest(context, request.siteId, effect, verified.axes));
  const ownerInput = { context: verified.context, ...identity(context), requestDigest: context.command!.requestDigest,
    siteId: request.siteId, batchRef: effect.batchRef };
  const result = await withCommandReceiptConflictMapping(async () => {
    if (action === "approve") return input.owner.approveBatch(ownerInput);
    if (action === "activate") return input.owner.activateBatch(ownerInput);
    return input.owner[`${action}Batch`]({ ...ownerInput, reason: effect.reason });
  });
  return { receipt: receipt(context, result.command.operation, result.recordedAt, result.command),
    result: create(CodeBatchMutationResultSchema, {
    batchRef: result.batchRef, state: batchStateToWire(result.state),
    ...(result.approvalState === undefined ? {} : { approvalState: CodeBatchApprovalState.APPROVED }),
  }) };
}

async function command(resolver: AdminControlPlaneResolver, context: AuthenticatedOperatorCommandContext,
  transport: HandlerContext, operation: CommerceAdminCommandOperation, siteId: string,
  resourceRefs: readonly string[]) {
  return resolver.resolveCommerceCommand(context, transport, { operation, siteRef: siteId, resourceRefs });
}
async function query(resolver: AdminControlPlaneResolver, context: AuthenticatedOperatorQueryContext,
  transport: HandlerContext, operation: AdminQueryPermit["operation"], siteId: string,
  resourceRefs: readonly string[]) {
  return resolver.resolve(context, transport, { operation, siteRef: siteId, resourceRefs, fieldRefs: [] });
}
function verifyDigest(context: AuthenticatedOperatorCommandContext, expected: string): void {
  const identity = required(context.command, "COMMERCE_COMMAND_IDENTITY_REQUIRED");
  if (identity.digestAlgorithm !== CommandDigestAlgorithmV2.SHA256_COMMAND_ENVELOPE ||
      identity.requestDigest !== expected) throw new Error("COMMERCE_COMMAND_DIGEST_MISMATCH");
}
function identity(context: AuthenticatedOperatorCommandContext) {
  const value = required(context.command, "COMMERCE_COMMAND_IDENTITY_REQUIRED");
  return { commandId: value.commandId, idempotencyKey: value.idempotencyKey };
}
function receipt(context: AuthenticatedOperatorCommandContext, operation: string, recordedAt: string,
  persisted?: Readonly<{ commandId: string; idempotencyKey: string; requestDigest: string }>) {
  const claimed = required(context.command, "COMMERCE_COMMAND_IDENTITY_REQUIRED");
  return create(CommandReceiptV2Schema, { identity: persisted === undefined ? claimed : {
    ...claimed, commandId: persisted.commandId, idempotencyKey: persisted.idempotencyKey,
    requestDigest: persisted.requestDigest,
  }, operation,
    state: CommandReceiptStateV2.COMMITTED, recordedAt: timestampFromDate(new Date(recordedAt)) });
}

type ResolvedPage = Readonly<{ permit: AdminQueryPermit; limit: number; after: string | null;
  watermark: string; observedAt: string; binding: string }>;
async function pageInput(input: Parameters<typeof createAdminCommerceConnectService>[0],
  context: AuthenticatedOperatorQueryContext, transport: HandlerContext,
  operation: AdminQueryPermit["operation"], siteId: string, token: string | undefined,
  requestedSize: number, kind: string, _now?: () => Date): Promise<ResolvedPage> {
  const limit = pageSize(requestedSize); const cursor = token === undefined ? null : input.cursors.decode(token);
  if (cursor !== null && (cursor.kind !== kind || Object.keys(cursor).sort().join(",") !==
      "after,binding,kind,watermark" || typeof cursor.watermark !== "string" ||
      !catalogEpoch(cursor.watermark))) throw new Error("ADMIN_PAGE_TOKEN_INVALID");
  const permit = await query(input.resolver, context, transport, operation, siteId, [siteId]);
  const binding = scopedBinding(permit, siteId);
  if (cursor !== null && cursor.binding !== binding) throw new Error("ADMIN_PAGE_TOKEN_INVALID");
  const observation = await input.reader.observeCatalog(permit);
  const watermark = cursor?.watermark ?? observation.watermark;
  return Object.freeze({ permit, limit, after: cursor?.after ?? null, watermark,
    observedAt: observation.observedAt, binding });
}
function pageResult<Row, Message>(rows: readonly Row[], page: ResolvedPage, cursors: AdminPageCursorCodec,
  kind: string, reference: (row: Row) => string, map: (row: Row) => Message, field: string) {
  const visible = rows.slice(0, page.limit); const last = visible.at(-1);
  return { [field]: visible.map(map), observedAt: timestampFromDate(new Date(page.observedAt)),
    ...(rows.length > page.limit && last !== undefined
    ? { nextPageToken: cursors.encode({ kind, after: reference(last), watermark: page.watermark,
        binding: page.binding }) } : {}) };
}

function creditProgramMessage(row: CreditProgramRevisionRecord) {
  return create(CreditProgramRevisionSummarySchema, { siteId: row.siteId,
    creditProgramRevisionRef: row.creditProgramRevisionRef, programRef: row.programRef,
    revision: row.revision, uxBucketClass: bucketToWire(row.uxBucketClass), unit: row.unit,
    amount: row.amount, burnPriority: row.burnPriority,
    scopePolicy: create(CreditScopePolicySchema, { surfaceRefs: [...row.scopePolicy.surfaceRefs],
      capabilityKeys: [...row.scopePolicy.capabilityKeys], agentRefs: [...row.scopePolicy.agentRefs],
      allowUnattributedAgent: row.scopePolicy.allowUnattributedAgent }),
    liabilityMerchantAccountRef: row.liabilityMerchantAccountRef,
    windowPolicy: row.windowKind === "none" ? { case: "permanentWindow", value: create(
      PermanentCreditWindowPolicySchema, { rolloverPolicy: CreditRolloverPolicy.NONE },
    ) } : { case: "recurringWindow", value: create(RecurringCreditWindowPolicySchema, {
      calendarZone: row.calendarZone!,
      anchor: row.windowKind === "daily" ? { case: "dailyLocalTime",
        value: row.windowAnchor!.slice("daily@".length) } : { case: "subscriptionTermStart", value: true },
      expiresAfterSeconds: row.expiresAfterSeconds!, rolloverPolicy: CreditRolloverPolicy.NONE,
    }) },
    revisionDigest: row.revisionDigest, publishedAt: timestampFromDate(new Date(row.publishedAt)) });
}
function entitlementTemplateMessage(row: EntitlementTemplateRevisionRecord) {
  return create(EntitlementTemplateRevisionSummarySchema, { siteId: row.siteId,
    entitlementTemplateRevisionRef: row.entitlementTemplateRevisionRef,
    templateRef: row.templateRef, revision: row.revision, capabilityKey: row.capabilityKey,
    safeLabel: row.safeLabel,
    ...(row.expiresAfterSeconds === null ? {} : { expiresAfterSeconds: row.expiresAfterSeconds }),
    revisionDigest: row.revisionDigest, publishedAt: timestampFromDate(new Date(row.publishedAt)) });
}
function offerMessage(row: CommerceOfferRecord) {
  return create(OfferSummarySchema, { siteId: row.siteId, productRef: row.productRef,
    productKind: productKindToWire(row.productKind), productVersionRef: row.productVersionRef,
    revision: row.revision, safeLabel: row.safeLabel,
    fulfillmentProgramRevisionRef: row.fulfillmentProgramRevisionRef,
    outputs: row.outputs.map(outputMessage), legalTermRefs: [...row.legalTermRefs],
    ...(row.planVersionRef === null ? {} : { planVersionRef: row.planVersionRef }),
    publishedAt: timestampFromDate(new Date(row.publishedAt)) });
}
function programMessage(row: RedemptionProgramRecord) {
  return create(RedemptionProgramSummarySchema, { ...row,
    publishedAt: timestampFromDate(new Date(row.publishedAt)) });
}
function batchMessage(row: CodeBatchRecord) {
  return create(CodeBatchSummarySchema, { siteId: row.siteId, batchRef: row.batchRef,
    redemptionProgramRevisionRef: row.redemptionProgramRevisionRef, state: batchStateToWire(row.state),
    approvalState: row.approvalState === "approved" ? CodeBatchApprovalState.APPROVED : CodeBatchApprovalState.PENDING,
    inventoryCount: row.inventoryCount, createdByOperatorRef: row.createdByOperatorRef,
    ...(row.startsAt === null ? {} : { startsAt: timestampFromDate(new Date(row.startsAt)) }),
    ...(row.endsAt === null ? {} : { endsAt: timestampFromDate(new Date(row.endsAt)) }),
    createdAt: timestampFromDate(new Date(row.createdAt)),
    ...(row.activatedAt === null ? {} : { activatedAt: timestampFromDate(new Date(row.activatedAt)) }),
    ...(row.exportReceipt === null ? {} : { exportReceipt: create(CodeExportReceiptSchema, {
      ...row.exportReceipt, exportedAt: timestampFromDate(new Date(row.exportReceipt.exportedAt)),
    }) }) });
}
function outputMessage(output: CommerceOfferRecord["outputs"][number]) {
  const targets = { subscription_term: "planVersionRef", entitlement_grant: "entitlementTemplateRevisionRef",
    credit_grant: "creditProgramRevisionRef", credit_program_enrollment: "creditProgramRevisionRef" } as const;
  return create(FulfillmentOutputDraftSchema, { ...output, outputKind: outputKindToWire(output.outputKind),
    target: { case: targets[output.outputKind], value: output.targetRevisionRef } });
}
function outputFromWire(value: FulfillmentOutputDraft): CommerceOfferRecord["outputs"][number] {
  if (value.target.case === undefined) throw new Error("COMMERCE_OUTPUT_TARGET_REQUIRED");
  return Object.freeze({ outputLineId: value.outputLineId, ordinal: value.ordinal, cardinality: value.cardinality,
    outputKind: outputKindFromWire(value.outputKind), targetRevisionRef: value.target.value });
}
function productKindFromWire(value: ProductKind): CommerceOfferRecord["productKind"] {
  if (value === ProductKind.FREE) return "free"; if (value === ProductKind.CREDIT_PACK) return "credit_pack";
  if (value === ProductKind.SUBSCRIPTION) return "subscription"; if (value === ProductKind.BUNDLE) return "bundle";
  throw new Error("COMMERCE_PRODUCT_KIND_INVALID");
}
function bucketFromWire(value: CreditBucketClass): CreditProgramRevisionRecord["uxBucketClass"] {
  if (value === CreditBucketClass.DAILY) return "daily";
  if (value === CreditBucketClass.PERIOD) return "period";
  if (value === CreditBucketClass.PERMANENT) return "permanent";
  throw new Error("COMMERCE_CREDIT_BUCKET_INVALID");
}
function bucketToWire(value: CreditProgramRevisionRecord["uxBucketClass"]): CreditBucketClass {
  return { daily: CreditBucketClass.DAILY, period: CreditBucketClass.PERIOD,
    permanent: CreditBucketClass.PERMANENT }[value];
}
function scopePolicyFromWire(value: NonNullable<PublishCreditProgramRevisionEffect["scopePolicy"]>) {
  return Object.freeze({ surfaceRefs: Object.freeze([...value.surfaceRefs].sort()),
    capabilityKeys: Object.freeze([...value.capabilityKeys].sort()),
    agentRefs: Object.freeze([...value.agentRefs].sort()),
    allowUnattributedAgent: value.allowUnattributedAgent });
}
function creditWindowFromWire(effect: PublishCreditProgramRevisionEffect,
  bucket: CreditProgramRevisionRecord["uxBucketClass"]) {
  const policy = effect.windowPolicy;
  if (bucket === "permanent") {
    if (policy.case !== "permanentWindow" || policy.value.rolloverPolicy !== CreditRolloverPolicy.NONE) {
      throw new Error("COMMERCE_CREDIT_WINDOW_INVALID");
    }
    return Object.freeze({ windowKind: "none" as const, rolloverPolicy: "none" as const,
      calendarZone: null, windowAnchor: null, expiresAfterSeconds: null });
  }
  if (policy.case !== "recurringWindow" || policy.value.rolloverPolicy !== CreditRolloverPolicy.NONE ||
      (bucket === "daily" && policy.value.anchor.case !== "dailyLocalTime") ||
      (bucket === "period" && (policy.value.anchor.case !== "subscriptionTermStart" ||
        policy.value.anchor.value !== true))) throw new Error("COMMERCE_CREDIT_WINDOW_INVALID");
  const anchor = policy.value.anchor;
  return Object.freeze({ windowKind: bucket, rolloverPolicy: "none" as const,
    calendarZone: policy.value.calendarZone,
    windowAnchor: anchor.case === "dailyLocalTime" ? `daily@${anchor.value}` : "subscription-term-start",
    expiresAfterSeconds: policy.value.expiresAfterSeconds.toString() });
}
function productKindToWire(value: CommerceOfferRecord["productKind"]): ProductKind {
  return { free: ProductKind.FREE, credit_pack: ProductKind.CREDIT_PACK,
    subscription: ProductKind.SUBSCRIPTION, bundle: ProductKind.BUNDLE }[value];
}
function planActionFromWire(value: PlanTermAction) {
  if (value === PlanTermAction.NONE) return "none" as const;
  if (value === PlanTermAction.NEW_SUBSCRIPTION) return "new_subscription" as const;
  if (value === PlanTermAction.EXTEND_FROM_MAX) return "extend_from_max" as const;
  if (value === PlanTermAction.REJECT_IF_ACTIVE) return "reject_if_active" as const;
  throw new Error("COMMERCE_PLAN_ACTION_INVALID");
}
function outputKindFromWire(value: FulfillmentOutputKind): CommerceOfferRecord["outputs"][number]["outputKind"] {
  if (value === FulfillmentOutputKind.SUBSCRIPTION_TERM) return "subscription_term";
  if (value === FulfillmentOutputKind.ENTITLEMENT_GRANT) return "entitlement_grant";
  if (value === FulfillmentOutputKind.CREDIT_GRANT) return "credit_grant";
  if (Number(value) === 4) return "credit_program_enrollment";
  throw new Error("COMMERCE_OUTPUT_KIND_INVALID");
}
function outputKindToWire(value: CommerceOfferRecord["outputs"][number]["outputKind"]): FulfillmentOutputKind {
  return { subscription_term: FulfillmentOutputKind.SUBSCRIPTION_TERM,
    entitlement_grant: FulfillmentOutputKind.ENTITLEMENT_GRANT,
    credit_grant: FulfillmentOutputKind.CREDIT_GRANT,
    credit_program_enrollment: 4 as FulfillmentOutputKind }[value];
}
function batchStateToWire(value: CodeBatchRecord["state"]): CodeBatchState {
  return { draft: CodeBatchState.DRAFT, active: CodeBatchState.ACTIVE, suspended: CodeBatchState.SUSPENDED,
    abandoned: CodeBatchState.ABANDONED, revoked: CodeBatchState.REVOKED }[value];
}
function queryContext(value: AuthenticatedOperatorQueryContext | undefined): AuthenticatedOperatorQueryContext {
  return required(value, "COMMERCE_QUERY_CONTEXT_REQUIRED");
}
function commandContext(value: AuthenticatedOperatorCommandContext | undefined): AuthenticatedOperatorCommandContext {
  return required(value, "COMMERCE_COMMAND_CONTEXT_REQUIRED");
}
function required<Value>(value: Value | undefined, code: string): Value { if (value === undefined) throw new Error(code); return value; }
function pageSize(value: number): number { if (value === 0) return 50; if (!Number.isInteger(value) || value < 1 || value > 200) throw new Error("ADMIN_PAGE_SIZE_INVALID"); return value; }
function catalogEpoch(value: string): boolean {
  return /^(?:0|[1-9][0-9]*)$/u.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
}
function optionalTimestamp(value: Readonly<{ seconds: bigint; nanos: number }> | undefined): string | null {
  return value === undefined ? null : new Date(Number(value.seconds) * 1000 + Math.floor(value.nanos / 1_000_000)).toISOString();
}

// Safe for any future structured telemetry hook. The Admin listener currently emits no payload logs.
export function redactAdminCommerceTelemetry(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return Object.freeze({ ...record, ...(Array.isArray(record.rawCodes)
    ? { rawCodes: [`[REDACTED:${record.rawCodes.length}]`] } : {}) });
}
