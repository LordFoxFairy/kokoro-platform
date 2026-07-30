import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { HandlerContext, ServiceImpl } from "@connectrpc/connect";
import {
  AdminCommerceService,
  CodeBatchApprovalState,
  CodeBatchMutationResultSchema,
  CodeBatchState,
  CodeBatchSummarySchema,
  CodeDeliveryState,
  CodeExportReceiptSchema,
  FulfillmentOutputDraftSchema,
  FulfillmentOutputKind,
  OfferSummarySchema,
  PlanTermAction,
  ProductKind,
  RedemptionProgramSummarySchema,
  type CodeBatchActionEffect,
  type FulfillmentOutputDraft,
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
  RedemptionProgramRecord,
} from "../../infrastructure/postgres/commerce-administration-reader.js";

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
    async publishOffer(request, transport) {
      const context = commandContext(request.context); const effect = required(request.effect, "COMMERCE_OFFER_EFFECT_REQUIRED");
      const verified = await command(input.resolver, context, transport, "commerce.offer.publish", request.siteId,
        [effect.productVersionRef, effect.fulfillmentProgramRevisionRef]);
      verifyDigest(context, publishOfferRequestDigest(context, request.siteId, effect, verified.axes));
      const result = await input.owner.publishOffer({ context: verified.context, ...identity(context), siteId: request.siteId,
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
        outputs: effect.outputs.map(outputFromWire), legalTermRefs: effect.legalTermRefs });
      return { receipt: receipt(context, "commerce.offer.publish", result.publishedAt),
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
      const result = await input.owner.publishProgram({ context: verified.context, ...identity(context),
        requestDigest: context.command!.requestDigest, siteId: request.siteId,
        redemptionProgramRevisionRef: effect.redemptionProgramRevisionRef, programRef: effect.programRef,
        revision: effect.revision.toString(), productVersionRef: effect.productVersionRef,
        fulfillmentProgramRevisionRef: effect.fulfillmentProgramRevisionRef,
        maxRedemptionsPerAccount: effect.maxRedemptionsPerAccount });
      const publishedAt = result.publishedAt;
      return { receipt: receipt(context, "commerce.redemption-program.publish", publishedAt),
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
      const result = await input.owner.issueBatch({ context: verified.context, ...identity(context),
        requestDigest: context.command!.requestDigest, siteId: request.siteId, batchRef: effect.batchRef,
        redemptionProgramRevisionRef: effect.redemptionProgramRevisionRef, count: effect.count,
        startsAt: optionalTimestamp(effect.startsAt), endsAt: optionalTimestamp(effect.endsAt) });
      const batch = batchMessage({ siteId: request.siteId, batchRef: effect.batchRef,
        redemptionProgramRevisionRef: effect.redemptionProgramRevisionRef, state: "draft",
        approvalState: "pending", inventoryCount: effect.count, createdByOperatorRef: context.actorRef,
        startsAt: optionalTimestamp(effect.startsAt), endsAt: optionalTimestamp(effect.endsAt),
        createdAt: result.exportedAt, activatedAt: null,
        exportReceipt: { batchRef: effect.batchRef, exportCommandId: context.command!.commandId,
          exportedToOperatorRef: context.actorRef, codeCount: effect.count, exportedAt: result.exportedAt } });
      return { receipt: receipt(context, "commerce.code-batch.issue", result.exportedAt),
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
  digest: BatchDigest, state: CodeBatchState, approval: CodeBatchApprovalState | undefined,
  now: () => Date) {
  const context = commandContext(request.context); const effect = required(request.effect, "COMMERCE_BATCH_EFFECT_REQUIRED");
  const operation = `commerce.code-batch.${action}` as CommerceAdminCommandOperation;
  const verified = await command(input.resolver, context, transport, operation, request.siteId, [effect.batchRef]);
  verifyDigest(context, digest(context, request.siteId, effect, verified.axes));
  const ownerInput = { context: verified.context, ...identity(context), requestDigest: context.command!.requestDigest,
    siteId: request.siteId, batchRef: effect.batchRef };
  if (action === "approve") await input.owner.approveBatch(ownerInput);
  else if (action === "activate") await input.owner.activateBatch(ownerInput);
  else await input.owner[`${action}Batch`]({ ...ownerInput, reason: effect.reason });
  const recordedAt = now().toISOString();
  return { receipt: receipt(context, operation, recordedAt), result: create(CodeBatchMutationResultSchema, {
    batchRef: effect.batchRef, state, ...(approval === undefined ? {} : { approvalState: approval }),
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
function receipt(context: AuthenticatedOperatorCommandContext, operation: string, recordedAt: string) {
  return create(CommandReceiptV2Schema, { identity: context.command, operation,
    state: CommandReceiptStateV2.COMMITTED, recordedAt: timestampFromDate(new Date(recordedAt)) });
}

type ResolvedPage = Readonly<{ permit: AdminQueryPermit; limit: number; after: string | null;
  watermark: string; binding: string }>;
async function pageInput(input: Parameters<typeof createAdminCommerceConnectService>[0],
  context: AuthenticatedOperatorQueryContext, transport: HandlerContext,
  operation: AdminQueryPermit["operation"], siteId: string, token: string | undefined,
  requestedSize: number, kind: string, now: () => Date): Promise<ResolvedPage> {
  const limit = pageSize(requestedSize); const cursor = token === undefined ? null : input.cursors.decode(token);
  if (cursor !== null && (cursor.kind !== kind || Object.keys(cursor).sort().join(",") !==
      "after,binding,kind,watermark")) throw new Error("ADMIN_PAGE_TOKEN_INVALID");
  const permit = await query(input.resolver, context, transport, operation, siteId, [siteId]);
  const binding = scopedBinding(permit, siteId);
  if (cursor !== null && cursor.binding !== binding) throw new Error("ADMIN_PAGE_TOKEN_INVALID");
  return Object.freeze({ permit, limit, after: cursor?.after ?? null,
    watermark: cursor?.watermark ?? now().toISOString(), binding });
}
function pageResult<Row, Message>(rows: readonly Row[], page: ResolvedPage, cursors: AdminPageCursorCodec,
  kind: string, reference: (row: Row) => string, map: (row: Row) => Message, field: string) {
  const visible = rows.slice(0, page.limit); const last = visible.at(-1);
  return { [field]: visible.map(map), ...(rows.length > page.limit && last !== undefined
    ? { nextPageToken: cursors.encode({ kind, after: reference(last), watermark: page.watermark,
        binding: page.binding }) } : {}) };
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
    credit_grant: "creditProgramRevisionRef" } as const;
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
  throw new Error("COMMERCE_OUTPUT_KIND_INVALID");
}
function outputKindToWire(value: CommerceOfferRecord["outputs"][number]["outputKind"]): FulfillmentOutputKind {
  return { subscription_term: FulfillmentOutputKind.SUBSCRIPTION_TERM,
    entitlement_grant: FulfillmentOutputKind.ENTITLEMENT_GRANT,
    credit_grant: FulfillmentOutputKind.CREDIT_GRANT }[value];
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
