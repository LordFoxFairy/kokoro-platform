import type {
  AccountProduct,
  AccountProductsResponse,
  CreditBucketSummary,
  CreditGrantResponse,
  CreditSummaryResponse,
  CreditUnitSummary,
  ProjectionFreshness,
  UsageDetailResponse,
} from "../../../../interfaces/http/generated/platform-public/types.gen.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import type { AccountReadIdentity, AccountReadRepository } from
  "../../application/contracts/account-read-repository.js";

const ACCOUNT_CTE = `account AS (
  SELECT membership.billing_account_ref
  FROM platform.commerce_billing_account_membership membership
  JOIN platform.commerce_billing_account billing
    ON billing.billing_account_ref=membership.billing_account_ref AND billing.site_ref=membership.site_ref
  WHERE membership.site_ref=$1 AND membership.subject_ref=$2
    AND membership.subject_generation=$3::bigint AND membership.state='active'
    AND membership.is_default AND billing.state='active'
  LIMIT 1
)`;

type FreshRow = { asOf: Date | string; revision: string };
type GrantRow = FreshRow & Record<string, unknown> & {
  grantId: string; unit: string; bucketClass: "daily" | "period" | "permanent";
  creditProgramRevisionRef: string; originalAmount: string; available: string; held: string;
  consumed: string; expiredOrReversed: string; effectiveAt: Date | string; expiresAt: Date | string | null;
  issuedAt: Date | string; sourceType: "redemption" | "admin_grant" | "program_window"; sourceRef: string;
};
type ProductRow = Record<string, unknown> & FreshRow & {
  fulfillmentId: string; productRef: string; productVersionRef: string; safeLabel: string;
  kind: AccountProduct["kind"]; planRef: string | null; planVersionRef: string | null; planSafeLabel: string | null;
  sourceType: "redemption" | "admin_grant" | "program_window"; sourceId: string; acquiredAt: Date | string;
  effectiveAt: Date | string; expiresAt: Date | string | null; sourceState: string | null;
  creditGrantRefs: unknown; entitlements: unknown;
};

export class PostgresAccountReadRepository implements AccountReadRepository {
  async getCreditGrant(transaction: Parameters<AccountReadRepository["getCreditGrant"]>[0], input: Parameters<AccountReadRepository["getCreditGrant"]>[1]): Promise<CreditGrantResponse | null> {
    const rows = await resolvePlatformTransaction(transaction).query<GrantRow>(`${GRANT_READ_SQL} AND grant.credit_grant_id=$4::uuid`,
      [input.siteId, input.subjectId, input.subjectGeneration, input.grantId]);
    const row = rows[0];
    return row === undefined ? null : Object.freeze({ freshness: freshness(row), grant: grantDetail(row) });
  }

  async getCreditSummary(transaction: Parameters<AccountReadRepository["getCreditSummary"]>[0], input: AccountReadIdentity): Promise<CreditSummaryResponse> {
    const sql = resolvePlatformTransaction(transaction);
    const rows = await sql.query<GrantRow>(GRANT_READ_SQL, [input.siteId, input.subjectId, input.subjectGeneration]);
    const meta = await sql.query<FreshRow & Record<string, unknown> & { activeHoldCount: number }>(
      `WITH ${ACCOUNT_CTE}
       SELECT clock_timestamp() AS "asOf",txid_current()::text AS revision,
              count(*)::int AS "activeHoldCount"
       FROM platform.credit_hold hold
       JOIN platform.credit_account credit ON credit.credit_account_ref=hold.credit_account_ref AND credit.site_ref=hold.site_ref
       JOIN account ON account.billing_account_ref=credit.billing_account_ref
       WHERE hold.site_ref=$1 AND hold.state IN ('open','closing','reconciliation_required')`,
      [input.siteId, input.subjectId, input.subjectGeneration],
    );
    const metadata = required(meta[0], "CREDIT_SUMMARY_METADATA_MISSING");
    const units = new Map<string, Map<GrantRow["bucketClass"], CreditBucketSummary>>();
    for (const row of rows) {
      const normalized = presentedGrantAmounts(row);
      const buckets = units.get(row.unit) ?? new Map();
      const previous = buckets.get(row.bucketClass) ?? {
        bucketClass: row.bucketClass, available: "0", consumed: "0", expiredOrReversed: "0",
        grantCount: 0, held: "0", issued: "0",
      };
      buckets.set(row.bucketClass, Object.freeze({
        ...previous, available: add(previous.available, normalized.available), consumed: add(previous.consumed, row.consumed),
        expiredOrReversed: add(previous.expiredOrReversed, normalized.expiredOrReversed), held: add(previous.held, row.held),
        issued: add(previous.issued, row.originalAmount), grantCount: previous.grantCount + 1,
      }));
      units.set(row.unit, buckets);
    }
    const summaries: CreditUnitSummary[] = [...units].sort(([a], [b]) => a.localeCompare(b)).map(([unit, buckets]) => ({
      unit, buckets: [...buckets.values()].sort((a, b) => a.bucketClass.localeCompare(b.bucketClass)),
    }));
    return Object.freeze({ activeHoldCount: metadata.activeHoldCount, freshness: freshness(metadata), units: summaries });
  }

  async getUsageDetail(transaction: Parameters<AccountReadRepository["getUsageDetail"]>[0], input: Parameters<AccountReadRepository["getUsageDetail"]>[1]): Promise<UsageDetailResponse | null> {
    const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown> & FreshRow & {
      usageId: string; executionBudgetRootRef: string; runRef: string; unit: string; maximumAmount: string;
      capturedAmount: string; state: string; occurredAt: Date | string; settledAt: Date | string | null;
      allocations: unknown;
    }>(
      `WITH ${ACCOUNT_CTE}
       SELECT clock_timestamp() AS "asOf",txid_current()::text AS revision,
              segment.authorization_segment_ref::text AS "usageId",
              segment.execution_budget_root_ref::text AS "executionBudgetRootRef",
              root.execution_root_ref AS "runRef",segment.unit,segment.maximum_amount::text AS "maximumAmount",
              hold.captured_amount::text AS "capturedAmount",segment.state,segment.created_at AS "occurredAt",
              segment.settled_at AS "settledAt",
              COALESCE(jsonb_agg(jsonb_build_object('creditGrantId',allocation.credit_grant_id::text,
                'amount',allocation.allocated_amount::text,'journalReceiptRef',allocation.reserve_journal_transaction_ref::text)
                ORDER BY allocation.allocation_ordinal) FILTER (WHERE allocation.credit_grant_id IS NOT NULL),'[]'::jsonb) AS allocations
       FROM platform.credit_authorization_segment segment
       JOIN account ON account.billing_account_ref=segment.billing_account_ref
       JOIN platform.credit_execution_budget_root root
         ON root.execution_budget_root_ref=segment.execution_budget_root_ref AND root.site_ref=segment.site_ref
       JOIN platform.credit_hold hold ON hold.credit_hold_ref=segment.credit_hold_ref AND hold.site_ref=segment.site_ref
       LEFT JOIN platform.credit_hold_allocation allocation
         ON allocation.credit_hold_ref=hold.credit_hold_ref AND allocation.site_ref=hold.site_ref
       WHERE segment.site_ref=$1 AND segment.authorization_segment_ref=$4::uuid
       GROUP BY segment.authorization_segment_ref,root.execution_root_ref,hold.captured_amount`,
      [input.siteId, input.subjectId, input.subjectGeneration, input.usageId],
    );
    const row = rows[0];
    if (row === undefined) return null;
    const allocations = allocationList(row.allocations);
    const mappedState = usageState(row.state);
    return Object.freeze({ freshness: freshness(row), usage: Object.freeze({
      usageId: row.usageId, executionBudgetRootRef: row.executionBudgetRootRef, runRef: row.runRef,
      unit: row.unit, estimatedAmount: amount(row.maximumAmount),
      ratedAmount: row.state === "settled" ? amount(row.capturedAmount) : null,
      state: mappedState, occurredAt: instant(row.occurredAt), settledAt: nullableInstant(row.settledAt), allocations,
    }) });
  }

  async listAccountProducts(transaction: Parameters<AccountReadRepository["listAccountProducts"]>[0], input: AccountReadIdentity): Promise<AccountProductsResponse> {
    const rows = await resolvePlatformTransaction(transaction).query<ProductRow>(
      `WITH ${ACCOUNT_CTE}
       SELECT clock_timestamp() AS "asOf",txid_current()::text AS revision,fulfillment.fulfillment_id::text AS "fulfillmentId",
              version.product_ref AS "productRef",version.product_version_ref AS "productVersionRef",version.safe_label AS "safeLabel",
              product.kind,version.plan_version_ref AS "planVersionRef",plan.plan_ref AS "planRef",plan.safe_label AS "planSafeLabel",
              fulfillment.source_type AS "sourceType",fulfillment.source_id AS "sourceId",fulfillment.completed_at AS "acquiredAt",
              fulfillment.completed_at AS "effectiveAt",
              CASE WHEN product.kind='subscription' THEN max(term.ends_at)
                   WHEN bool_or(grant.expires_at IS NULL) THEN NULL ELSE max(grant.expires_at) END AS "expiresAt",
              redemption.state AS "sourceState",
              COALESCE(jsonb_agg(DISTINCT grant.credit_grant_id::text) FILTER (WHERE grant.credit_grant_id IS NOT NULL),'[]'::jsonb) AS "creditGrantRefs",
              COALESCE(jsonb_agg(DISTINCT jsonb_build_object('entitlementGrantRef',entitlement.entitlement_grant_ref::text,
                'capabilityKey',entitlement.capability_key,'safeLabel',entitlement.safe_label,
                'expiresAt',entitlement.expires_at,'state',CASE WHEN revocation.entitlement_grant_ref IS NOT NULL THEN 'revoked'
                  WHEN entitlement.expires_at IS NOT NULL AND entitlement.expires_at<=clock_timestamp() THEN 'expired' ELSE 'active' END))
                FILTER (WHERE entitlement.entitlement_grant_ref IS NOT NULL),'[]'::jsonb) AS entitlements
       FROM platform.commerce_fulfillment_transaction fulfillment JOIN account ON account.billing_account_ref=fulfillment.billing_account_ref
       JOIN platform.commerce_catalog_product_version version ON version.product_version_ref=fulfillment.product_version_ref AND version.site_ref=fulfillment.site_ref
       JOIN platform.commerce_catalog_product product ON product.product_ref=version.product_ref AND product.site_ref=version.site_ref
       LEFT JOIN platform.commerce_catalog_plan_version plan ON plan.plan_version_ref=version.plan_version_ref AND plan.site_ref=version.site_ref
       LEFT JOIN platform.credit_grant grant ON grant.site_ref=fulfillment.site_ref AND grant.source_type=fulfillment.source_type AND grant.source_ref=fulfillment.source_id
       LEFT JOIN platform.commerce_entitlement_grant entitlement ON entitlement.site_ref=fulfillment.site_ref AND entitlement.source_type=fulfillment.source_type AND entitlement.source_ref=fulfillment.source_id
       LEFT JOIN platform.commerce_entitlement_revocation revocation ON revocation.site_ref=entitlement.site_ref AND revocation.entitlement_grant_ref=entitlement.entitlement_grant_ref
       LEFT JOIN platform.commerce_subscription_term term ON term.site_ref=fulfillment.site_ref AND term.source_type=fulfillment.source_type AND term.source_ref=fulfillment.source_id
       LEFT JOIN platform.commerce_redemption redemption ON fulfillment.source_type='redemption' AND redemption.site_ref=fulfillment.site_ref AND redemption.redemption_id::text=fulfillment.source_id
       WHERE fulfillment.site_ref=$1 AND fulfillment.status='succeeded'
       GROUP BY fulfillment.fulfillment_id,version.product_ref,version.product_version_ref,version.safe_label,product.kind,
                version.plan_version_ref,plan.plan_ref,plan.safe_label,redemption.state
       ORDER BY fulfillment.completed_at DESC,fulfillment.fulfillment_id`,
      [input.siteId, input.subjectId, input.subjectGeneration],
    );
    const first = rows[0];
    const fallback = first ?? required((await resolvePlatformTransaction(transaction).query<FreshRow & Record<string, unknown>>(
      "SELECT clock_timestamp() AS \"asOf\",txid_current()::text AS revision",
    ))[0], "ACCOUNT_PRODUCTS_METADATA_MISSING");
    return Object.freeze({ freshness: freshness(fallback), products: rows.map(product) });
  }
}

const GRANT_READ_SQL = `WITH ${ACCOUNT_CTE},ledger AS (
  SELECT entry.credit_grant_id,
    COALESCE(sum(CASE WHEN entry.account_type='customer_available' THEN CASE entry.entry_side WHEN 'credit' THEN entry.amount ELSE -entry.amount END ELSE 0 END),0)::text AS available,
    COALESCE(sum(CASE WHEN entry.account_type='customer_reserved' THEN CASE entry.entry_side WHEN 'credit' THEN entry.amount ELSE -entry.amount END ELSE 0 END),0)::text AS held,
    COALESCE(sum(CASE WHEN entry.account_type='customer_consumed' THEN CASE entry.entry_side WHEN 'credit' THEN entry.amount ELSE -entry.amount END ELSE 0 END),0)::text AS consumed,
    COALESCE(sum(CASE WHEN entry.account_type IN ('expired','revoked') THEN CASE entry.entry_side WHEN 'credit' THEN entry.amount ELSE -entry.amount END ELSE 0 END),0)::text AS "expiredOrReversed"
  FROM platform.credit_journal_entry entry WHERE entry.site_ref=$1 GROUP BY entry.credit_grant_id
)
SELECT clock_timestamp() AS "asOf",txid_current()::text AS revision,grant.credit_grant_id::text AS "grantId",grant.unit,
       grant.ux_bucket_class AS "bucketClass",grant.credit_program_revision_ref AS "creditProgramRevisionRef",
       grant.original_amount::text AS "originalAmount",COALESCE(ledger.available,'0') AS available,
       COALESCE(ledger.held,'0') AS held,COALESCE(ledger.consumed,'0') AS consumed,
       COALESCE(ledger."expiredOrReversed",'0') AS "expiredOrReversed",grant.effective_at AS "effectiveAt",
       grant.expires_at AS "expiresAt",grant.issued_at AS "issuedAt",grant.source_type AS "sourceType",grant.source_ref AS "sourceRef"
FROM platform.credit_grant grant JOIN account ON account.billing_account_ref=grant.billing_account_ref
LEFT JOIN ledger ON ledger.credit_grant_id=grant.credit_grant_id WHERE grant.site_ref=$1`;

function grantDetail(row: GrantRow) {
  const { available, expiredOrReversed } = presentedGrantAmounts(row); const held = amount(row.held);
  const expired = row.expiresAt !== null && Date.parse(instant(row.expiresAt)) <= Date.parse(instant(row.asOf));
  const state = expired ? "expired" : BigInt(expiredOrReversed) > 0n ? "reversed" :
    BigInt(available) === 0n && BigInt(held) === 0n ? "exhausted" : "active";
  return Object.freeze({
    grantId: row.grantId, unit: row.unit, bucketClass: row.bucketClass,
    creditProgramRevisionRef: row.creditProgramRevisionRef, issued: amount(row.originalAmount),
    available, held, consumed: amount(row.consumed), effectiveAt: instant(row.effectiveAt),
    expiresAt: nullableInstant(row.expiresAt), state, source: Object.freeze({
      kind: row.sourceType, sourceRef: row.sourceRef, acquiredAt: instant(row.issuedAt),
    }),
  });
}

function presentedGrantAmounts(row: GrantRow): { available: string; expiredOrReversed: string } {
  const effective = Date.parse(instant(row.effectiveAt)) <= Date.parse(instant(row.asOf));
  const expired = row.expiresAt !== null && Date.parse(instant(row.expiresAt)) <= Date.parse(instant(row.asOf));
  if (!effective) return { available: "0", expiredOrReversed: amount(row.expiredOrReversed) };
  if (!expired) return { available: amount(row.available), expiredOrReversed: amount(row.expiredOrReversed) };
  const residual = BigInt(amount(row.originalAmount)) - BigInt(amount(row.consumed)) - BigInt(amount(row.held));
  const recorded = BigInt(amount(row.expiredOrReversed));
  return { available: "0", expiredOrReversed: (recorded > residual ? recorded : residual).toString() };
}

function product(row: ProductRow): AccountProduct {
  const expiresAt = nullableInstant(row.expiresAt);
  const state = row.sourceState === "reversed" ? "revoked" : expiresAt !== null && Date.parse(expiresAt) <= Date.parse(instant(row.asOf)) ? "expired" : "active";
  return Object.freeze({
    productRef: row.productRef, productVersionRef: row.productVersionRef, safeLabel: row.safeLabel, kind: row.kind,
    plan: row.planRef === null || row.planVersionRef === null || row.planSafeLabel === null ? null : Object.freeze({
      planRef: row.planRef, planVersionRef: row.planVersionRef, safeLabel: row.planSafeLabel, automaticRenewal: false as const,
    }),
    source: Object.freeze({ kind: row.sourceType, sourceRef: row.sourceId, acquiredAt: instant(row.acquiredAt) }),
    effectiveAt: instant(row.effectiveAt), expiresAt, state,
    creditGrantRefs: stringList(row.creditGrantRefs), entitlements: entitlementList(row.entitlements),
  });
}

function freshness(row: FreshRow): ProjectionFreshness { return Object.freeze({ asOf: instant(row.asOf), lagSeconds: 0, revision: row.revision, state: "current" }); }
function amount(value: string): string { if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error("ACCOUNT_READ_AMOUNT_INVALID"); return value; }
function add(left: string, right: string): string { return (BigInt(left) + BigInt(right)).toString(); }
function instant(value: Date | string): string { const result = new Date(value); if (!Number.isFinite(result.getTime())) throw new Error("ACCOUNT_READ_TIME_INVALID"); return result.toISOString(); }
function nullableInstant(value: Date | string | null): string | null { return value === null ? null : instant(value); }
function required<Value>(value: Value | undefined, code: string): Value { if (value === undefined) throw new Error(code); return value; }
function usageState(value: string): "reserved" | "rated" | "settled" | "reversed" | "reconciliation_required" {
  if (value === "reserved") return value;
  if (value === "committed" || value === "rating_pending") return "rated";
  if (value === "settled" || value === "reconciliation_required") return value;
  if (value === "released" || value === "expired") return "reversed";
  throw new Error("USAGE_STATE_INVALID");
}
function allocationList(value: unknown) {
  if (!Array.isArray(value)) throw new Error("USAGE_ALLOCATIONS_INVALID");
  return value.map((item) => { const row = record(item, "USAGE_ALLOCATIONS_INVALID"); return Object.freeze({
    creditGrantId: text(row.creditGrantId, "USAGE_ALLOCATIONS_INVALID"), amount: amount(text(row.amount, "USAGE_ALLOCATIONS_INVALID")),
    journalReceiptRef: text(row.journalReceiptRef, "USAGE_ALLOCATIONS_INVALID"),
  }); });
}
function entitlementList(value: unknown) {
  if (!Array.isArray(value)) throw new Error("ACCOUNT_ENTITLEMENTS_INVALID");
  return value.map((item) => { const row = record(item, "ACCOUNT_ENTITLEMENTS_INVALID"); return Object.freeze({
    entitlementGrantRef: text(row.entitlementGrantRef, "ACCOUNT_ENTITLEMENTS_INVALID"),
    capabilityKey: text(row.capabilityKey, "ACCOUNT_ENTITLEMENTS_INVALID"), safeLabel: text(row.safeLabel, "ACCOUNT_ENTITLEMENTS_INVALID"),
    expiresAt: row.expiresAt === null ? null : instant(text(row.expiresAt, "ACCOUNT_ENTITLEMENTS_INVALID")),
    state: enumValue(row.state, ["active", "expired", "revoked"] as const, "ACCOUNT_ENTITLEMENTS_INVALID"),
  }); });
}
function stringList(value: unknown): string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("ACCOUNT_REFS_INVALID"); return [...new Set(value)].sort(); }
function record(value: unknown, code: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(code); return value as Record<string, unknown>; }
function text(value: unknown, code: string): string { if (typeof value !== "string" || value.length < 1 || value.length > 256) throw new Error(code); return value; }
function enumValue<const Values extends readonly string[]>(value: unknown, values: Values, code: string): Values[number] { if (typeof value !== "string" || !values.includes(value)) throw new Error(code); return value; }
