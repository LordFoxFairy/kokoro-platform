import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { HandlerContext, ServiceImpl } from "@connectrpc/connect";
import {
  AdminCreditService,
  CreditAccountState,
  CreditAccountSummarySchema,
  CreditBalanceSummarySchema,
  CreditBucketClass,
  CreditGrantSourceType,
  CreditGrantSummarySchema,
  CreditHoldAllocationSummarySchema,
  CreditHoldResolutionKind,
  CreditHoldState,
  CreditHoldSummarySchema,
  CreditJournalAccountType,
  CreditJournalEntrySide,
  CreditJournalEntrySummarySchema,
  CreditJournalOperationKind,
  CreditJournalTransactionSummarySchema,
  CreditReadFreshness,
  CreditUsageSourceDirection,
  RatedUsageSourceAllocationSummarySchema,
  RatedUsageSummarySchema,
  SiteCreditSummarySchema,
} from "../../../../interfaces/connect/generated-admin-credit/kokoro/platform/credit/v1/admin_credit_pb.js";
import type { AuthenticatedOperatorQueryContext } from
  "../../../../interfaces/connect/generated-admin-credit/kokoro/platform/admin/v2/admin_shared_pb.js";
import { scopedBinding, type AdminPageCursorCodec, type AdminQueryPermit,
  type AdminQueryResolver } from "../../../admin/interfaces/connect/admin-query-service.js";
import type {
  AdminCreditAccountRecord,
  AdminCreditGrantRecord,
  AdminCreditHoldAllocationRecord,
  AdminCreditHoldRecord,
  AdminCreditJournalEntryRecord,
  AdminCreditJournalTransactionRecord,
  AdminCreditReader,
  AdminRatedUsageRecord,
  AdminRatedUsageSourceAllocationRecord,
  AdminCreditMembershipPageResult,
  CreditBalanceRecord,
} from "../../application/contracts/admin-credit-reader.js";

export type AdminCreditConnectService = ServiceImpl<typeof AdminCreditService>;

export function createAdminCreditConnectService(input: Readonly<{
  resolver: AdminQueryResolver;
  reader: AdminCreditReader;
  cursors: AdminPageCursorCodec;
}>): AdminCreditConnectService {
  return {
    async getSiteCreditSummary(request, transport) {
      const context = required(request.context); const permit = await resolve(input.resolver,
        context, transport, "credit.summary.read", request.siteId, [request.siteId], summaryFields);
      const summary = await input.reader.getSiteCreditSummary(permit, request.siteId);
      return { summary: create(SiteCreditSummarySchema, { siteId: summary.siteId,
        creditAccountCount: summary.creditAccountCount,
        activeCreditAccountCount: summary.activeCreditAccountCount, openHoldCount: summary.openHoldCount,
        reconciliationRequiredHoldCount: summary.reconciliationRequiredHoldCount,
        balances: summary.balances.map(balanceMessage),
        freshness: CreditReadFreshness.AUTHORITATIVE_DATABASE_OBSERVATION,
        asOf: timestamp(summary.asOf) }) };
    },

    async listCreditAccounts(request, transport) {
      const page = await pageInput(input, required(request.context), transport, "credit.account.read",
        request.siteId, "credit-accounts", { billingAccountRef: request.billingAccountRef ?? null },
        request.pageToken, request.pageSize, accountFields);
      const result = await input.reader.listCreditAccounts(page.permit, { siteId: request.siteId,
        billingAccountRef: request.billingAccountRef ?? null, afterRef: page.after,
        membershipWatermark: page.membershipWatermark, limit: page.limit + 1 });
      return listResult(result, page, input.cursors, (row) => row.creditAccountRef, accountMessage,
        "accounts");
    },

    async getCreditAccount(request, transport) {
      const context = required(request.context); const permit = await resolve(input.resolver,
        context, transport, "credit.account.read", request.siteId,
        [request.siteId, request.creditAccountRef], accountFields);
      const row = await input.reader.getCreditAccount(permit, request.siteId, request.creditAccountRef);
      if (row === null) throw new Error("ADMIN_CREDIT_ACCOUNT_NOT_FOUND");
      return { account: accountMessage(row) };
    },

    async listCreditGrants(request, transport) {
      const source = sourceFilter(request.sourceType, request.sourceRef);
      const filters = { creditAccountRef: request.creditAccountRef ?? null,
        creditGrantId: request.creditGrantId ?? null, ...source,
        executionRootRef: request.executionRootRef ?? null };
      const page = await pageInput(input, required(request.context), transport, "credit.grant.read",
        request.siteId, "credit-grants", filters, request.pageToken, request.pageSize, grantFields);
      const result = await input.reader.listCreditGrants(page.permit, { siteId: request.siteId, ...filters,
        afterRef: page.after, membershipWatermark: page.membershipWatermark, limit: page.limit + 1 });
      return listResult(result, page, input.cursors, (row) => row.creditGrantId, grantMessage,
        "grants");
    },

    async listCreditHolds(request, transport) {
      const source = sourceFilter(request.sourceType, request.sourceRef);
      const filters = { creditAccountRef: request.creditAccountRef ?? null,
        creditGrantId: request.creditGrantId ?? null, ...source,
        executionRootRef: request.executionRootRef ?? null };
      const page = await pageInput(input, required(request.context), transport, "credit.hold.read",
        request.siteId, "credit-holds", filters, request.pageToken, request.pageSize, holdFields);
      const result = await input.reader.listCreditHolds(page.permit, { siteId: request.siteId, ...filters,
        afterRef: page.after, membershipWatermark: page.membershipWatermark, limit: page.limit + 1 });
      return listResult(result, page, input.cursors, (row) => row.creditHoldRef, holdMessage,
        "holds");
    },

    async listCreditHoldAllocations(request, transport) {
      const trace = holdAllocationTrace(request.trace);
      const page = await pageInput(input, required(request.context), transport, "credit.hold.read",
        request.siteId, "credit-hold-allocations", trace, request.pageToken, request.pageSize,
        holdAllocationFields);
      const after = allocationAfter(page.after, "ADMIN_CREDIT_PAGE_TOKEN_INVALID");
      const result = await input.reader.listCreditHoldAllocations(page.permit, { siteId: request.siteId,
        ...trace, afterHoldRef: after?.ref ?? null, afterAllocationOrdinal: after?.ordinal ?? null,
        membershipWatermark: page.membershipWatermark, limit: page.limit + 1 });
      return listResult(result, page, input.cursors,
        (row) => `${row.creditHoldRef}:${String(row.allocationOrdinal)}`, holdAllocationMessage,
        "allocations");
    },

    async listCreditJournalTransactions(request, transport) {
      const source = sourceFilter(request.sourceType, request.sourceRef);
      const filters = { creditAccountRef: request.creditAccountRef ?? null,
        creditGrantId: request.creditGrantId ?? null, creditHoldRef: request.creditHoldRef ?? null,
        ...source, executionRootRef: request.executionRootRef ?? null };
      const page = await pageInput(input, required(request.context), transport, "credit.journal.read",
        request.siteId, "credit-journal-transactions", filters, request.pageToken, request.pageSize,
        journalTransactionFields);
      const result = await input.reader.listCreditJournalTransactions(page.permit, {
        siteId: request.siteId, ...filters, afterRef: page.after,
        membershipWatermark: page.membershipWatermark, limit: page.limit + 1,
      });
      return listResult(result, page, input.cursors, (row) => row.journalTransactionRef,
        journalTransactionMessage, "transactions");
    },

    async listCreditJournalEntries(request, transport) {
      const context = required(request.context); const filters = {
        journalTransactionRef: request.journalTransactionRef };
      const page = await pageInput(input, context, transport, "credit.journal.read", request.siteId,
        "credit-journal-entries", filters, request.pageToken, request.pageSize, journalEntryFields);
      const afterOrdinal = page.after === null ? null : boundedOrdinal(page.after);
      const result = await input.reader.listCreditJournalEntries(page.permit, { siteId: request.siteId,
        journalTransactionRef: request.journalTransactionRef, afterOrdinal,
        membershipWatermark: page.membershipWatermark, limit: page.limit + 1 });
      return listResult(result, page, input.cursors, (row) => String(row.entryOrdinal),
        journalEntryMessage, "entries");
    },

    async listRatedUsage(request, transport) {
      const source = sourceFilter(request.sourceType, request.sourceRef);
      const filters = { creditAccountRef: request.creditAccountRef ?? null,
        creditGrantId: request.creditGrantId ?? null, creditHoldRef: request.creditHoldRef ?? null, ...source,
        executionRootRef: request.executionRootRef ?? null, attemptRef: request.attemptRef ?? null };
      const page = await pageInput(input, required(request.context), transport, "credit.rated-usage.read",
        request.siteId, "credit-rated-usage", filters, request.pageToken, request.pageSize,
        ratedUsageFields);
      const result = await input.reader.listRatedUsage(page.permit, { siteId: request.siteId, ...filters,
        afterRef: page.after, membershipWatermark: page.membershipWatermark, limit: page.limit + 1 });
      return listResult(result, page, input.cursors, (row) => row.ratedUsageRef, ratedUsageMessage,
        "ratedUsage");
    },

    async listRatedUsageSourceAllocations(request, transport) {
      const trace = ratedUsageAllocationTrace(request.trace);
      const page = await pageInput(input, required(request.context), transport, "credit.rated-usage.read",
        request.siteId, "credit-rated-usage-source-allocations", trace, request.pageToken,
        request.pageSize, ratedUsageAllocationFields);
      const after = allocationAfter(page.after, "ADMIN_CREDIT_PAGE_TOKEN_INVALID");
      const result = await input.reader.listRatedUsageSourceAllocations(page.permit, { siteId: request.siteId,
        ...trace, afterRatedUsageRef: after?.ref ?? null, afterSourceOrdinal: after?.ordinal ?? null,
        membershipWatermark: page.membershipWatermark, limit: page.limit + 1 });
      return listResult(result, page, input.cursors,
        (row) => `${row.ratedUsageRef}:${String(row.sourceOrdinal)}`, ratedUsageSourceAllocationMessage,
        "allocations");
    },
  };
}

type CreditReadOperation = Extract<AdminQueryPermit["operation"], `credit.${string}`>;
interface ResolvedPage { readonly permit: AdminQueryPermit; readonly after: string | null;
  readonly membershipWatermark: string | null; readonly binding: string; readonly kind: string;
  readonly limit: number }

async function pageInput(input: Readonly<{ resolver: AdminQueryResolver; cursors: AdminPageCursorCodec }>,
  context: AuthenticatedOperatorQueryContext, transport: HandlerContext, operation: CreditReadOperation,
  siteId: string, kind: string, filters: Readonly<Record<string, string | null>>,
  token: string | undefined, requestedSize: number, fields: readonly string[]): Promise<ResolvedPage> {
  const limit = pageSize(requestedSize); const cursor = token === undefined ? null : input.cursors.decode(token);
  if (cursor !== null) requireCursor(cursor, ["after", "binding", "kind", "membership"], kind);
  const resourceRefs = [siteId, ...Object.values(filters).filter((value): value is string => value !== null)];
  const permit = await resolve(input.resolver, context, transport, operation, siteId, resourceRefs, fields);
  const binding = filterBinding(scopedBinding(permit, siteId), kind, filters);
  if (cursor !== null && cursor.binding !== binding) throw new Error("ADMIN_CREDIT_PAGE_TOKEN_INVALID");
  const membershipWatermark = cursor?.membership ?? null;
  if (membershipWatermark !== null && !Number.isFinite(Date.parse(membershipWatermark))) {
    throw new Error("ADMIN_CREDIT_PAGE_TOKEN_INVALID");
  }
  return Object.freeze({ permit, after: cursor?.after ?? null, membershipWatermark,
    binding, kind, limit });
}

function listResult<Row, Message>(result: AdminCreditMembershipPageResult<Row>, page: ResolvedPage,
  cursors: AdminPageCursorCodec, reference: (row: Row) => string, message: (row: Row) => Message,
  field: string): Record<string, unknown> {
  const membershipWatermark = canonicalTime(result.membershipWatermark);
  const observedAt = canonicalTime(result.observedAt);
  if ((page.membershipWatermark === null && membershipWatermark !== observedAt)
    || (page.membershipWatermark !== null
      && canonicalTime(page.membershipWatermark) !== membershipWatermark)) {
    throw new Error("ADMIN_CREDIT_MEMBERSHIP_WATERMARK_MISMATCH");
  }
  const visible = result.items.slice(0, page.limit); const last = visible.at(-1);
  return { [field]: visible.map(message), membershipWatermark: timestamp(membershipWatermark),
    observedAt: timestamp(observedAt),
    ...(result.items.length > page.limit && last !== undefined ? { nextPageToken: cursors.encode({
      kind: page.kind, after: reference(last), membership: membershipWatermark, binding: page.binding,
    }) } : {}) };
}

function accountMessage(row: AdminCreditAccountRecord) {
  return create(CreditAccountSummarySchema, { siteId: row.siteId, creditAccountRef: row.creditAccountRef,
    billingAccountRef: row.billingAccountRef, unit: row.unit, state: accountState(row.state),
    aggregateVersion: row.aggregateVersion, balance: balanceMessage(row.balance), grantCount: row.grantCount,
    openHoldCount: row.openHoldCount, reconciliationRequiredHoldCount: row.reconciliationRequiredHoldCount,
    createdAt: timestamp(row.createdAt), updatedAt: timestamp(row.updatedAt),
    freshness: CreditReadFreshness.AUTHORITATIVE_DATABASE_OBSERVATION, asOf: timestamp(row.asOf) });
}
function balanceMessage(row: CreditBalanceRecord) { return create(CreditBalanceSummarySchema, row); }
function grantMessage(row: AdminCreditGrantRecord) {
  return create(CreditGrantSummarySchema, { siteId: row.siteId, creditGrantId: row.creditGrantId,
    creditAccountRef: row.creditAccountRef, billingAccountRef: row.billingAccountRef,
    creditProgramRevisionRef: row.creditProgramRevisionRef, sourceType: grantSource(row.sourceType),
    sourceRef: row.sourceRef, issuanceJournalTransactionRef: row.issuanceJournalTransactionRef,
    uxBucketClass: bucket(row.uxBucketClass), unit: row.unit, originalAmount: row.originalAmount,
    burnPriority: row.burnPriority, effectiveAt: timestamp(row.effectiveAt),
    ...(row.expiresAt === null ? {} : { expiresAt: timestamp(row.expiresAt) }),
    issuedAt: timestamp(row.issuedAt), relatedHoldCount: row.relatedHoldCount,
    relatedExecutionCount: row.relatedExecutionCount });
}
function holdMessage(row: AdminCreditHoldRecord) {
  return create(CreditHoldSummarySchema, { siteId: row.siteId, creditHoldRef: row.creditHoldRef,
    creditAccountRef: row.creditAccountRef, executionRootRef: row.executionRootRef, unit: row.unit,
    requestedAmount: row.requestedAmount, reservedAmount: row.reservedAmount,
    capturedAmount: row.capturedAmount, releasedAmount: row.releasedAmount, state: holdState(row.state),
    ...(row.resolutionKind === null ? {} : { resolutionKind: holdResolution(row.resolutionKind) }),
    ...(row.resolutionRef === null ? {} : { resolutionRef: row.resolutionRef }),
    fenceEpoch: row.fenceEpoch, expiresAt: timestamp(row.expiresAt),
    ...(row.settledAt === null ? {} : { settledAt: timestamp(row.settledAt) }),
    ...(row.releasedAt === null ? {} : { releasedAt: timestamp(row.releasedAt) }),
    createdAt: timestamp(row.createdAt), updatedAt: timestamp(row.updatedAt),
    grantCount: row.grantCount, sourceCount: row.sourceCount });
}
function holdAllocationMessage(row: AdminCreditHoldAllocationRecord) {
  return create(CreditHoldAllocationSummarySchema, { siteId: row.siteId,
    creditHoldRef: row.creditHoldRef, creditGrantId: row.creditGrantId,
    creditAccountRef: row.creditAccountRef, unit: row.unit,
    reserveJournalTransactionRef: row.reserveJournalTransactionRef,
    allocatedAmount: row.allocatedAmount, allocationOrdinal: row.allocationOrdinal,
    createdAt: timestamp(row.createdAt) });
}
function journalTransactionMessage(row: AdminCreditJournalTransactionRecord) {
  return create(CreditJournalTransactionSummarySchema, { siteId: row.siteId,
    journalTransactionRef: row.journalTransactionRef, creditAccountRef: row.creditAccountRef,
    unit: row.unit, businessOperationKey: row.businessOperationKey,
    operationKind: journalOperation(row.operationKind), entryCount: row.entryCount,
    ...(row.reversalOfTransactionRef === null ? {} : {
      reversalOfTransactionRef: row.reversalOfTransactionRef }),
    occurredAt: timestamp(row.occurredAt), createdAt: timestamp(row.createdAt) });
}
function journalEntryMessage(row: AdminCreditJournalEntryRecord) {
  return create(CreditJournalEntrySummarySchema, { siteId: row.siteId,
    journalTransactionRef: row.journalTransactionRef, entryOrdinal: row.entryOrdinal,
    creditAccountRef: row.creditAccountRef, unit: row.unit, entrySide: journalSide(row.entrySide),
    accountType: journalAccount(row.accountType), amount: row.amount, creditGrantId: row.creditGrantId,
    ...(row.creditHoldRef === null ? {} : { creditHoldRef: row.creditHoldRef }),
    sourceType: grantSource(row.sourceType), sourceRef: row.sourceRef,
    ...(row.executionRootRef === null ? {} : { executionRootRef: row.executionRootRef }),
    createdAt: timestamp(row.createdAt) });
}
function ratedUsageMessage(row: AdminRatedUsageRecord) {
  return create(RatedUsageSummarySchema, { siteId: row.siteId, ratedUsageRef: row.ratedUsageRef,
    authorizationSegmentRef: row.authorizationSegmentRef, closureRef: row.closureRef,
    settlementRef: row.settlementRef, evidenceRef: row.evidenceRef, attemptRef: row.attemptRef,
    executionRootRef: row.executionRootRef, creditHoldRef: row.creditHoldRef,
    creditAccountRef: row.creditAccountRef, unit: row.unit, policyRatedAmount: row.policyRatedAmount,
    customerAmount: row.customerAmount, platformExposureAmount: row.platformExposureAmount,
    lineItemCount: row.lineItemCount, ratedUsageDigest: row.ratedUsageDigest,
    sourceCount: row.sourceCount, createdAt: timestamp(row.createdAt) });
}
function ratedUsageSourceAllocationMessage(row: AdminRatedUsageSourceAllocationRecord) {
  return create(RatedUsageSourceAllocationSummarySchema, { siteId: row.siteId,
    ratedUsageRef: row.ratedUsageRef, settlementRef: row.settlementRef,
    creditGrantId: row.creditGrantId, direction: usageSourceDirection(row.direction),
    amount: row.amount, allocationOrdinal: row.allocationOrdinal });
}

function accountState(value: AdminCreditAccountRecord["state"]): CreditAccountState { return {
  active: CreditAccountState.ACTIVE, suspended: CreditAccountState.SUSPENDED,
  closed: CreditAccountState.CLOSED }[value]; }
function bucket(value: AdminCreditGrantRecord["uxBucketClass"]): CreditBucketClass { return {
  daily: CreditBucketClass.DAILY, period: CreditBucketClass.PERIOD,
  permanent: CreditBucketClass.PERMANENT }[value]; }
function grantSource(value: AdminCreditGrantRecord["sourceType"]): CreditGrantSourceType { return {
  redemption: CreditGrantSourceType.REDEMPTION, payment: CreditGrantSourceType.PAYMENT,
  admin_grant: CreditGrantSourceType.ADMIN_GRANT, program_window: CreditGrantSourceType.PROGRAM_WINDOW }[value]; }
function holdState(value: AdminCreditHoldRecord["state"]): CreditHoldState { return {
  open: CreditHoldState.OPEN, closing: CreditHoldState.CLOSING, settled: CreditHoldState.SETTLED,
  released: CreditHoldState.RELEASED, expired: CreditHoldState.EXPIRED,
  reconciliation_required: CreditHoldState.RECONCILIATION_REQUIRED }[value]; }
function holdResolution(value: NonNullable<AdminCreditHoldRecord["resolutionKind"]>): CreditHoldResolutionKind {
  return { reservation_expiry: CreditHoldResolutionKind.RESERVATION_EXPIRY,
    known_outcome: CreditHoldResolutionKind.KNOWN_OUTCOME,
    reconciled: CreditHoldResolutionKind.RECONCILED }[value]; }
function journalOperation(value: AdminCreditJournalTransactionRecord["operationKind"]): CreditJournalOperationKind {
  return { grant_issue: CreditJournalOperationKind.GRANT_ISSUE,
    hold_reserve: CreditJournalOperationKind.HOLD_RESERVE,
    hold_capture: CreditJournalOperationKind.HOLD_CAPTURE,
    hold_release: CreditJournalOperationKind.HOLD_RELEASE,
    grant_expire: CreditJournalOperationKind.GRANT_EXPIRE,
    grant_revoke: CreditJournalOperationKind.GRANT_REVOKE,
    correction: CreditJournalOperationKind.CORRECTION, reversal: CreditJournalOperationKind.REVERSAL }[value]; }
function journalSide(value: AdminCreditJournalEntryRecord["entrySide"]): CreditJournalEntrySide {
  return value === "debit" ? CreditJournalEntrySide.DEBIT : CreditJournalEntrySide.CREDIT; }
function journalAccount(value: AdminCreditJournalEntryRecord["accountType"]): CreditJournalAccountType { return {
  grant_issuance_source: CreditJournalAccountType.GRANT_ISSUANCE_SOURCE,
  customer_available: CreditJournalAccountType.CUSTOMER_AVAILABLE,
  customer_reserved: CreditJournalAccountType.CUSTOMER_RESERVED,
  customer_consumed: CreditJournalAccountType.CUSTOMER_CONSUMED, expired: CreditJournalAccountType.EXPIRED,
  revoked: CreditJournalAccountType.REVOKED, adjustment: CreditJournalAccountType.ADJUSTMENT,
  recovery_exposure: CreditJournalAccountType.RECOVERY_EXPOSURE }[value]; }
function usageSourceDirection(value: AdminRatedUsageSourceAllocationRecord["direction"]): CreditUsageSourceDirection {
  return { capture: CreditUsageSourceDirection.CAPTURE, increase: CreditUsageSourceDirection.INCREASE,
    decrease: CreditUsageSourceDirection.DECREASE }[value];
}

function sourceFilter(sourceType: CreditGrantSourceType | undefined, sourceRef: string | undefined): Readonly<{
  sourceType: AdminCreditGrantRecord["sourceType"] | null; sourceRef: string | null;
}> {
  if ((sourceType === undefined) !== (sourceRef === undefined)) {
    throw new Error("ADMIN_CREDIT_SOURCE_FILTER_INCOMPLETE");
  }
  if (sourceType === undefined) return Object.freeze({ sourceType: null, sourceRef: null });
  return Object.freeze({ sourceType: grantSourceFromWire(sourceType), sourceRef: sourceRef! });
}

function grantSourceFromWire(value: CreditGrantSourceType): AdminCreditGrantRecord["sourceType"] {
  if (value === CreditGrantSourceType.REDEMPTION) return "redemption";
  if (value === CreditGrantSourceType.PAYMENT) return "payment";
  if (value === CreditGrantSourceType.ADMIN_GRANT) return "admin_grant";
  if (value === CreditGrantSourceType.PROGRAM_WINDOW) return "program_window";
  throw new Error("ADMIN_CREDIT_SOURCE_TYPE_INVALID");
}

function holdAllocationTrace(trace: Readonly<{
  case?: "creditHoldRef" | "creditGrantId" | undefined; value?: string | undefined;
}>): Readonly<{ creditHoldRef: string | null; creditGrantId: string | null }> {
  if (trace.case === "creditHoldRef" && trace.value !== undefined) {
    return Object.freeze({ creditHoldRef: trace.value, creditGrantId: null });
  }
  if (trace.case === "creditGrantId" && trace.value !== undefined) {
    return Object.freeze({ creditHoldRef: null, creditGrantId: trace.value });
  }
  throw new Error("ADMIN_CREDIT_ALLOCATION_TRACE_REQUIRED");
}

function ratedUsageAllocationTrace(trace: Readonly<{
  case?: "ratedUsageRef" | "settlementRef" | undefined; value?: string | undefined;
}>): Readonly<{ ratedUsageRef: string | null; settlementRef: string | null }> {
  if (trace.case === "ratedUsageRef" && trace.value !== undefined) {
    return Object.freeze({ ratedUsageRef: trace.value, settlementRef: null });
  }
  if (trace.case === "settlementRef" && trace.value !== undefined) {
    return Object.freeze({ ratedUsageRef: null, settlementRef: trace.value });
  }
  throw new Error("ADMIN_CREDIT_RATED_USAGE_ALLOCATION_TRACE_REQUIRED");
}

function allocationAfter(value: string | null, code: string): Readonly<{ ref: string; ordinal: number }> | null {
  if (value === null) return null;
  const match = /^([0-9a-f-]{36}):([0-9]{1,10})$/u.exec(value);
  if (match === null) throw new Error(code);
  const ordinal = boundedOrdinal(match[2]!);
  return Object.freeze({ ref: match[1]!, ordinal });
}

function resolve(resolver: AdminQueryResolver, context: AuthenticatedOperatorQueryContext,
  transport: HandlerContext, operation: CreditReadOperation, siteRef: string,
  resourceRefs: readonly string[], fieldRefs: readonly string[]) {
  return resolver.resolve(context, transport, { operation, siteRef, resourceRefs, fieldRefs });
}
function filterBinding(scope: string, kind: string, filters: Readonly<Record<string, string | null>>): string {
  return createHash("sha256").update("kokoro.admin-credit-page.v1").update("\0").update(scope)
    .update("\0").update(kind).update("\0").update(JSON.stringify(Object.fromEntries(
      Object.entries(filters).sort(([left], [right]) => compareCodeUnits(left, right))))).digest("hex");
}
function compareCodeUnits(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function requireCursor(cursor: Readonly<Record<string, string>>, keys: readonly string[], kind: string): void {
  if (cursor.kind !== kind || Object.keys(cursor).sort().join(",") !== [...keys].sort().join(",")) {
    throw new Error("ADMIN_CREDIT_PAGE_TOKEN_INVALID");
  }
}
function pageSize(value: number): number { if (value === 0) return 50;
  if (!Number.isInteger(value) || value < 1 || value > 200) throw new Error("ADMIN_CREDIT_PAGE_SIZE_INVALID");
  return value; }
function boundedOrdinal(value: string): number { if (!/^[0-9]{1,10}$/u.test(value))
  throw new Error("ADMIN_CREDIT_PAGE_TOKEN_INVALID"); const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("ADMIN_CREDIT_PAGE_TOKEN_INVALID"); return result; }
function timestamp(value: string) { const date = new Date(value); if (!Number.isFinite(date.getTime()))
  throw new Error("ADMIN_CREDIT_TIME_INVALID"); return timestampFromDate(date); }
function canonicalTime(value: string): string { const date = new Date(value); if (!Number.isFinite(date.getTime()))
  throw new Error("ADMIN_CREDIT_TIME_INVALID"); return date.toISOString(); }
function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("ADMIN_CREDIT_QUERY_CONTEXT_REQUIRED"); return value;
}

const summaryFields = ["site_ref", "credit_account_count", "hold_count", "balance", "as_of"];
const accountFields = ["credit_account_ref", "billing_account_ref", "unit", "state", "balance", "as_of"];
const grantFields = ["credit_grant_id", "credit_account_ref", "source_type", "source_ref", "amount", "issued_at"];
const holdFields = ["credit_hold_ref", "credit_grant_id", "credit_account_ref", "execution_root_ref", "amount", "state", "updated_at"];
const holdAllocationFields = ["credit_hold_ref", "credit_grant_id", "allocated_amount", "allocation_ordinal"];
const journalTransactionFields = ["journal_transaction_ref", "credit_account_ref", "operation_kind", "occurred_at"];
const journalEntryFields = ["journal_transaction_ref", "entry_ordinal", "credit_grant_id", "credit_hold_ref", "source_ref"];
const ratedUsageFields = ["rated_usage_ref", "credit_grant_id", "authorization_segment_ref", "attempt_ref", "amount", "created_at"];
const ratedUsageAllocationFields = ["rated_usage_ref", "settlement_ref", "credit_grant_id", "direction", "amount", "allocation_ordinal"];
