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
  CreditHoldResolutionKind,
  CreditHoldState,
  CreditHoldSummarySchema,
  CreditJournalAccountType,
  CreditJournalEntrySide,
  CreditJournalEntrySummarySchema,
  CreditJournalOperationKind,
  CreditJournalTransactionSummarySchema,
  CreditReadFreshness,
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
  AdminCreditHoldRecord,
  AdminCreditJournalEntryRecord,
  AdminCreditJournalTransactionRecord,
  AdminCreditReader,
  AdminRatedUsageRecord,
  CreditBalanceRecord,
} from "../../application/contracts/admin-credit-reader.js";

export type AdminCreditConnectService = ServiceImpl<typeof AdminCreditService>;

export function createAdminCreditConnectService(input: Readonly<{
  resolver: AdminQueryResolver;
  reader: AdminCreditReader;
  cursors: AdminPageCursorCodec;
  clock?: () => Date;
}>): AdminCreditConnectService {
  const now = input.clock ?? (() => new Date());
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
        freshness: CreditReadFreshness.AUTHORITATIVE_TRANSACTION_SNAPSHOT,
        asOf: timestamp(summary.asOf) }) };
    },

    async listCreditAccounts(request, transport) {
      const page = await pageInput(input, required(request.context), transport, "credit.account.read",
        request.siteId, "credit-accounts", { billingAccountRef: request.billingAccountRef ?? null },
        request.pageToken, request.pageSize, accountFields, now);
      const rows = await input.reader.listCreditAccounts(page.permit, { siteId: request.siteId,
        billingAccountRef: request.billingAccountRef ?? null, afterRef: page.after,
        watermark: page.watermark, limit: page.limit + 1 });
      return listResult(rows, page, input.cursors, (row) => row.creditAccountRef, accountMessage,
        "accounts", true);
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
      const filters = { creditAccountRef: request.creditAccountRef ?? null,
        sourceRef: request.sourceRef ?? null, executionRootRef: request.executionRootRef ?? null };
      const page = await pageInput(input, required(request.context), transport, "credit.grant.read",
        request.siteId, "credit-grants", filters, request.pageToken, request.pageSize, grantFields, now);
      const rows = await input.reader.listCreditGrants(page.permit, { siteId: request.siteId, ...filters,
        afterRef: page.after, watermark: page.watermark, limit: page.limit + 1 });
      return listResult(rows, page, input.cursors, (row) => row.creditGrantId, grantMessage,
        "grants", true);
    },

    async listCreditHolds(request, transport) {
      const filters = { creditAccountRef: request.creditAccountRef ?? null,
        sourceRef: request.sourceRef ?? null, executionRootRef: request.executionRootRef ?? null };
      const page = await pageInput(input, required(request.context), transport, "credit.hold.read",
        request.siteId, "credit-holds", filters, request.pageToken, request.pageSize, holdFields, now);
      const rows = await input.reader.listCreditHolds(page.permit, { siteId: request.siteId, ...filters,
        afterRef: page.after, watermark: page.watermark, limit: page.limit + 1 });
      return listResult(rows, page, input.cursors, (row) => row.creditHoldRef, holdMessage,
        "holds", true);
    },

    async listCreditJournalTransactions(request, transport) {
      const filters = { creditAccountRef: request.creditAccountRef ?? null,
        creditGrantId: request.creditGrantId ?? null, creditHoldRef: request.creditHoldRef ?? null,
        sourceRef: request.sourceRef ?? null, executionRootRef: request.executionRootRef ?? null };
      const page = await pageInput(input, required(request.context), transport, "credit.journal.read",
        request.siteId, "credit-journal-transactions", filters, request.pageToken, request.pageSize,
        journalTransactionFields, now);
      const rows = await input.reader.listCreditJournalTransactions(page.permit, {
        siteId: request.siteId, ...filters, afterRef: page.after,
        watermark: page.watermark, limit: page.limit + 1,
      });
      return listResult(rows, page, input.cursors, (row) => row.journalTransactionRef,
        journalTransactionMessage, "transactions", true);
    },

    async listCreditJournalEntries(request, transport) {
      const context = required(request.context); const filters = {
        journalTransactionRef: request.journalTransactionRef };
      const page = await pageInput(input, context, transport, "credit.journal.read", request.siteId,
        "credit-journal-entries", filters, request.pageToken, request.pageSize, journalEntryFields, now);
      const afterOrdinal = page.after === null ? null : boundedOrdinal(page.after);
      const rows = await input.reader.listCreditJournalEntries(page.permit, { siteId: request.siteId,
        journalTransactionRef: request.journalTransactionRef, afterOrdinal, limit: page.limit + 1 });
      return listResult(rows, page, input.cursors, (row) => String(row.entryOrdinal),
        journalEntryMessage, "entries", false);
    },

    async listRatedUsage(request, transport) {
      const filters = { creditAccountRef: request.creditAccountRef ?? null,
        creditHoldRef: request.creditHoldRef ?? null, sourceRef: request.sourceRef ?? null,
        executionRootRef: request.executionRootRef ?? null, attemptRef: request.attemptRef ?? null };
      const page = await pageInput(input, required(request.context), transport, "credit.rated-usage.read",
        request.siteId, "credit-rated-usage", filters, request.pageToken, request.pageSize,
        ratedUsageFields, now);
      const rows = await input.reader.listRatedUsage(page.permit, { siteId: request.siteId, ...filters,
        afterRef: page.after, watermark: page.watermark, limit: page.limit + 1 });
      return listResult(rows, page, input.cursors, (row) => row.ratedUsageRef, ratedUsageMessage,
        "ratedUsage", true);
    },
  };
}

type CreditReadOperation = Extract<AdminQueryPermit["operation"], `credit.${string}`>;
interface ResolvedPage { readonly permit: AdminQueryPermit; readonly after: string | null;
  readonly watermark: string; readonly binding: string; readonly kind: string; readonly limit: number }

async function pageInput(input: Readonly<{ resolver: AdminQueryResolver; cursors: AdminPageCursorCodec }>,
  context: AuthenticatedOperatorQueryContext, transport: HandlerContext, operation: CreditReadOperation,
  siteId: string, kind: string, filters: Readonly<Record<string, string | null>>,
  token: string | undefined, requestedSize: number, fields: readonly string[], now: () => Date): Promise<ResolvedPage> {
  const limit = pageSize(requestedSize); const cursor = token === undefined ? null : input.cursors.decode(token);
  if (cursor !== null) requireCursor(cursor, ["after", "at", "binding", "kind"], kind);
  const resourceRefs = [siteId, ...Object.values(filters).filter((value): value is string => value !== null)];
  const permit = await resolve(input.resolver, context, transport, operation, siteId, resourceRefs, fields);
  const binding = filterBinding(scopedBinding(permit, siteId), kind, filters);
  if (cursor !== null && cursor.binding !== binding) throw new Error("ADMIN_CREDIT_PAGE_TOKEN_INVALID");
  const watermark = cursor?.at ?? now().toISOString();
  if (!Number.isFinite(Date.parse(watermark))) throw new Error("ADMIN_CREDIT_PAGE_TOKEN_INVALID");
  return Object.freeze({ permit, after: cursor?.after ?? null, watermark, binding, kind, limit });
}

function listResult<Row, Message>(rows: readonly Row[], page: ResolvedPage,
  cursors: AdminPageCursorCodec, reference: (row: Row) => string, message: (row: Row) => Message,
  field: string, includeAsOf: boolean): Record<string, unknown> {
  const visible = rows.slice(0, page.limit); const last = visible.at(-1);
  return { [field]: visible.map(message), ...(includeAsOf ? { asOf: timestamp(page.watermark) } : {}),
    ...(rows.length > page.limit && last !== undefined ? { nextPageToken: cursors.encode({
      kind: page.kind, after: reference(last), at: page.watermark, binding: page.binding,
    }) } : {}) };
}

function accountMessage(row: AdminCreditAccountRecord) {
  return create(CreditAccountSummarySchema, { siteId: row.siteId, creditAccountRef: row.creditAccountRef,
    billingAccountRef: row.billingAccountRef, unit: row.unit, state: accountState(row.state),
    aggregateVersion: row.aggregateVersion, balance: balanceMessage(row.balance), grantCount: row.grantCount,
    openHoldCount: row.openHoldCount, reconciliationRequiredHoldCount: row.reconciliationRequiredHoldCount,
    createdAt: timestamp(row.createdAt), updatedAt: timestamp(row.updatedAt),
    freshness: CreditReadFreshness.AUTHORITATIVE_TRANSACTION_SNAPSHOT, asOf: timestamp(row.asOf) });
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

function resolve(resolver: AdminQueryResolver, context: AuthenticatedOperatorQueryContext,
  transport: HandlerContext, operation: CreditReadOperation, siteRef: string,
  resourceRefs: readonly string[], fieldRefs: readonly string[]) {
  return resolver.resolve(context, transport, { operation, siteRef, resourceRefs, fieldRefs });
}
function filterBinding(scope: string, kind: string, filters: Readonly<Record<string, string | null>>): string {
  return createHash("sha256").update("kokoro.admin-credit-page.v1").update("\0").update(scope)
    .update("\0").update(kind).update("\0").update(JSON.stringify(Object.fromEntries(
      Object.entries(filters).sort(([left], [right]) => left.localeCompare(right))))).digest("hex");
}
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
function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("ADMIN_CREDIT_QUERY_CONTEXT_REQUIRED"); return value;
}

const summaryFields = ["site_ref", "credit_account_count", "hold_count", "balance", "as_of"];
const accountFields = ["credit_account_ref", "billing_account_ref", "unit", "state", "balance", "as_of"];
const grantFields = ["credit_grant_id", "credit_account_ref", "source_type", "source_ref", "amount", "issued_at"];
const holdFields = ["credit_hold_ref", "credit_account_ref", "execution_root_ref", "amount", "state", "updated_at"];
const journalTransactionFields = ["journal_transaction_ref", "credit_account_ref", "operation_kind", "occurred_at"];
const journalEntryFields = ["journal_transaction_ref", "entry_ordinal", "credit_grant_id", "credit_hold_ref", "source_ref"];
const ratedUsageFields = ["rated_usage_ref", "authorization_segment_ref", "attempt_ref", "amount", "created_at"];
