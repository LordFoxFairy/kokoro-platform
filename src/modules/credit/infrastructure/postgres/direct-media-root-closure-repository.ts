import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import { rehydrateBudgetAllocationRevision } from "../../domain/allocation.js";
import type {
  DirectMediaRootClosureIdentity,
  DirectMediaRootClosureLookup,
  DirectMediaRootClosureReceipt,
  DirectMediaRootClosureRecord,
  DirectMediaRootClosureRepository,
  StoredDirectMediaRootClosure,
} from "../../application/contracts/direct-media-root-closure-repository.js";

interface ResultRow extends Record<string, unknown> { result: unknown }

/** Exact Media-worker-to-Credit bridge. It never grants the worker direct Credit table access. */
export class PostgresDirectMediaRootClosureRepository implements DirectMediaRootClosureRepository {
  async findClosure(transaction: PlatformTransaction,
    identity: DirectMediaRootClosureIdentity): Promise<DirectMediaRootClosureLookup> {
    const result = await call(transaction,
      "SELECT platform.find_direct_media_root_closure($1,$2,$3,$4) AS result",
      [identity.siteId, identity.operationRef, identity.businessOperationKey, identity.requestDigest]);
    const row = object(result, "CREDIT_DIRECT_ROOT_LOOKUP_INVALID");
    const kind = text(row.kind, "CREDIT_DIRECT_ROOT_LOOKUP_INVALID");
    if (kind === "none") return Object.freeze({ kind });
    if (kind === "conflict") return Object.freeze({ kind, code: "REQUEST_DIGEST_CONFLICT" as const });
    if (kind !== "replayed") throw new Error("CREDIT_DIRECT_ROOT_LOOKUP_INVALID");
    return Object.freeze({ kind, value: receipt(row.value) });
  }

  async lockRootClosure(transaction: PlatformTransaction,
    input: Parameters<DirectMediaRootClosureRepository["lockRootClosure"]>[1]):
    Promise<StoredDirectMediaRootClosure | null> {
    const result = await call(transaction,
      `SELECT platform.lock_direct_media_root_closure(
         $1,$2,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid) AS result`,
      [input.siteId, input.operationRef, input.executionBudgetRootRef, input.rootAllocationRef,
        input.rootHoldRef, input.authorizationSegmentRef, input.settlementRef]);
    if (result === null) return null;
    const row = object(result, "CREDIT_DIRECT_ROOT_CONTEXT_INVALID");
    const settlement = object(row.settlement, "CREDIT_DIRECT_ROOT_CONTEXT_INVALID");
    const allocation = object(row.allocation, "CREDIT_DIRECT_ROOT_CONTEXT_INVALID");
    const sources = array(row.holdAllocations, "CREDIT_DIRECT_ROOT_CONTEXT_INVALID");
    return Object.freeze({
      siteId: text(row.siteId), operationRef: text(row.operationRef),
      executionBudgetRootRef: text(row.executionBudgetRootRef),
      rootState: rootState(row.rootState), rootVersion: integer(row.rootVersion),
      billingAccountId: text(row.billingAccountId), creditAccountId: text(row.creditAccountId),
      liabilityMerchantAccountId: text(row.liabilityMerchantAccountId),
      creditHoldRef: text(row.creditHoldRef), holdState: holdState(row.holdState),
      holdFenceEpoch: integer(row.holdFenceEpoch), holdReservedAmount: amount(row.holdReservedAmount),
      holdCapturedAmount: amount(row.holdCapturedAmount), holdReleasedAmount: amount(row.holdReleasedAmount),
      rootAllocationRef: text(row.rootAllocationRef),
      allocation: rehydrateBudgetAllocationRevision({
        revision: integer(allocation.revision), allocationEpoch: integer(allocation.allocationEpoch),
        creditCeiling: amount(allocation.creditCeiling), unassignedStock: amount(allocation.unassignedStock),
        activeChildReservedStock: amount(allocation.activeChildReservedStock),
        committedStock: amount(allocation.committedStock),
        capturedCumulative: amount(allocation.capturedCumulative),
        returnedToParentCumulative: amount(allocation.returnedToParentCumulative),
        state: allocationState(allocation.state),
      }),
      openChildCount: integer(row.openChildCount), openSegmentCount: integer(row.openSegmentCount),
      openAttemptCount: integer(row.openAttemptCount),
      settlement: Object.freeze({ settlementRef: text(settlement.settlementRef),
        authorizationSegmentRef: text(settlement.authorizationSegmentRef),
        executionBudgetRootRef: text(settlement.executionBudgetRootRef),
        budgetAllocationRef: text(settlement.budgetAllocationRef), creditHoldRef: text(settlement.creditHoldRef),
        unit: text(settlement.unit), customerAmount: amount(settlement.customerAmount),
        ratingSnapshotRef: text(settlement.ratingSnapshotRef) }),
      holdAllocations: Object.freeze(sources.map((value) => {
        const source = object(value, "CREDIT_DIRECT_ROOT_CONTEXT_INVALID");
        return Object.freeze({ creditGrantId: text(source.creditGrantId),
          ordinal: safeNumber(source.ordinal), allocatedAmount: amount(source.allocatedAmount),
          netCustomerAmount: amount(source.netCustomerAmount) });
      })),
    });
  }

  async persistClosure(transaction: PlatformTransaction, record: DirectMediaRootClosureRecord) {
    const row = object(await call(transaction,
      "SELECT platform.commit_direct_media_root_closure($1::jsonb) AS result",
      [canonical(record)]), "CREDIT_DIRECT_ROOT_COMMIT_INVALID");
    const kind = text(row.kind, "CREDIT_DIRECT_ROOT_COMMIT_INVALID");
    if (kind === "conflict") return Object.freeze({ kind, code: "REQUEST_DIGEST_CONFLICT" as const });
    if (kind !== "accepted" && kind !== "replayed") throw new Error("CREDIT_DIRECT_ROOT_COMMIT_INVALID");
    return Object.freeze({ kind, value: receipt(row.value) });
  }

  async markReconciliationRequired(transaction: PlatformTransaction,
    input: Parameters<DirectMediaRootClosureRepository["markReconciliationRequired"]>[1]): Promise<void> {
    const result = object(await call(transaction,
      "SELECT platform.mark_direct_media_root_reconciliation($1::jsonb) AS result",
      [canonical(input)]), "CREDIT_DIRECT_ROOT_RECONCILIATION_INVALID");
    if (result.kind !== "accepted" && result.kind !== "replayed") {
      throw new Error("CREDIT_DIRECT_ROOT_RECONCILIATION_INVALID");
    }
  }
}

async function call(transaction: PlatformTransaction, statement: string,
  values: readonly unknown[]): Promise<unknown> {
  const rows = await resolvePlatformTransaction(transaction).query<ResultRow>(statement, values);
  if (rows.length !== 1) throw new Error("CREDIT_DIRECT_ROOT_ROUTINE_RESULT_INVALID");
  return rows[0]!.result;
}

function receipt(value: unknown): DirectMediaRootClosureReceipt {
  const row = object(value, "CREDIT_DIRECT_ROOT_RECEIPT_INVALID");
  return Object.freeze({ allocationClosureReceiptRef: text(row.allocationClosureReceiptRef),
    siteId: text(row.siteId), operationRef: text(row.operationRef),
    businessOperationKey: text(row.businessOperationKey), requestDigest: text(row.requestDigest),
    effectClosureReceiptRef: text(row.effectClosureReceiptRef), settlementRef: text(row.settlementRef),
    executionBudgetRootRef: text(row.executionBudgetRootRef), rootAllocationRef: text(row.rootAllocationRef),
    rootHoldRef: text(row.rootHoldRef), capturedAmount: amount(row.capturedAmount),
    releasedAmount: amount(row.releasedAmount), unit: text(row.unit),
    receiptDigest: text(row.receiptDigest), recordedAt: text(row.recordedAt) });
}

function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function object(value: unknown, code = "CREDIT_DIRECT_ROOT_VALUE_INVALID"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}
function array(value: unknown, code: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(code);
  return value;
}
function text(value: unknown, code = "CREDIT_DIRECT_ROOT_VALUE_INVALID"): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(code);
  return value;
}
function integer(value: unknown): bigint {
  try { return BigInt(text(value)); } catch { throw new Error("CREDIT_DIRECT_ROOT_INTEGER_INVALID"); }
}
function amount(value: unknown): bigint {
  const parsed = integer(value);
  if (parsed < 0n) throw new Error("CREDIT_DIRECT_ROOT_AMOUNT_INVALID");
  return parsed;
}
function safeNumber(value: unknown): number {
  const parsed = Number(integer(value));
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("CREDIT_DIRECT_ROOT_ORDINAL_INVALID");
  return parsed;
}
function rootState(value: unknown): StoredDirectMediaRootClosure["rootState"] {
  const parsed = text(value);
  if (!["open", "closing", "settled", "reconciliation_required"].includes(parsed)) {
    throw new Error("CREDIT_DIRECT_ROOT_STATE_INVALID");
  }
  return parsed as StoredDirectMediaRootClosure["rootState"];
}
function holdState(value: unknown): StoredDirectMediaRootClosure["holdState"] {
  const parsed = text(value);
  if (!["open", "closing", "settled", "released", "expired", "reconciliation_required"].includes(parsed)) {
    throw new Error("CREDIT_DIRECT_ROOT_HOLD_STATE_INVALID");
  }
  return parsed as StoredDirectMediaRootClosure["holdState"];
}
function allocationState(value: unknown): StoredDirectMediaRootClosure["allocation"]["state"] {
  const parsed = text(value);
  if (!["active", "returning", "terminal", "reconciliation_required"].includes(parsed)) {
    throw new Error("CREDIT_DIRECT_ROOT_ALLOCATION_STATE_INVALID");
  }
  return parsed as StoredDirectMediaRootClosure["allocation"]["state"];
}
