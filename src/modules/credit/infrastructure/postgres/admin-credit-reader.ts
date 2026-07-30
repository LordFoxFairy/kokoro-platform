import type { AdminQueryPermit } from
  "../../../admin/interfaces/connect/admin-query-service.js";
import type {
  AdminCreditAccountRecord,
  AdminCreditGrantRecord,
  AdminCreditHoldRecord,
  AdminCreditJournalEntryRecord,
  AdminCreditJournalTransactionRecord,
  AdminCreditReader,
  AdminCreditSiteSummaryRecord,
  AdminRatedUsageRecord,
  AdminSiteQueryTransactionHost,
  CreditBalanceRecord,
} from "../../application/contracts/admin-credit-reader.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export class PostgresAdminCreditReader implements AdminCreditReader {
  constructor(private readonly host: AdminSiteQueryTransactionHost) {}

  getSiteCreditSummary(permit: AdminQueryPermit, siteId: string) {
    return this.host.adminSiteQueryTransaction(permit, siteId, async (transaction) => {
      const rows = await resolvePlatformTransaction(transaction).query<SummaryRow>(
        `WITH account_totals AS (
           SELECT count(*)::text AS account_count,
             count(*) FILTER (WHERE state='active')::text AS active_account_count
           FROM platform.credit_account WHERE site_ref=$1
         ), hold_totals AS (
           SELECT count(*) FILTER (WHERE state IN ('open','closing'))::text AS open_hold_count,
             count(*) FILTER (WHERE state='reconciliation_required')::text AS reconciliation_count
           FROM platform.credit_hold WHERE site_ref=$1
         ), ledger AS (
           SELECT unit,
             COALESCE(sum(CASE WHEN account_type='customer_available'
               THEN CASE entry_side WHEN 'credit' THEN amount ELSE -amount END ELSE 0 END),0)::text AS available,
             COALESCE(sum(CASE WHEN account_type='customer_reserved'
               THEN CASE entry_side WHEN 'credit' THEN amount ELSE -amount END ELSE 0 END),0)::text AS reserved,
             COALESCE(sum(CASE WHEN account_type='customer_consumed'
               THEN CASE entry_side WHEN 'credit' THEN amount ELSE -amount END ELSE 0 END),0)::text AS consumed,
             COALESCE(sum(CASE WHEN account_type='expired'
               THEN CASE entry_side WHEN 'credit' THEN amount ELSE -amount END ELSE 0 END),0)::text AS expired,
             COALESCE(sum(CASE WHEN account_type='revoked'
               THEN CASE entry_side WHEN 'credit' THEN amount ELSE -amount END ELSE 0 END),0)::text AS revoked,
             COALESCE(sum(CASE WHEN account_type='recovery_exposure'
               THEN CASE entry_side WHEN 'credit' THEN amount ELSE -amount END ELSE 0 END),0)::text AS recovery
           FROM platform.credit_journal_entry WHERE site_ref=$1 GROUP BY unit
         )
         SELECT $1::text AS "siteId",account_totals.account_count AS "creditAccountCount",
           account_totals.active_account_count AS "activeCreditAccountCount",
           hold_totals.open_hold_count AS "openHoldCount",
           hold_totals.reconciliation_count AS "reconciliationRequiredHoldCount",
           COALESCE((SELECT jsonb_agg(jsonb_build_object('unit',unit,'availableAmount',available,
             'reservedAmount',reserved,'consumedAmount',consumed,'expiredAmount',expired,
             'revokedAmount',revoked,'recoveryExposureAmount',recovery) ORDER BY unit) FROM ledger),'[]'::jsonb)
             AS balances,
           transaction_timestamp() AS "asOf"
         FROM account_totals CROSS JOIN hold_totals`,
        [siteId],
      );
      return siteSummary(requiredRow(rows));
    });
  }

  listCreditAccounts(permit: AdminQueryPermit, input: Parameters<AdminCreditReader["listCreditAccounts"]>[1]) {
    return this.host.adminSiteQueryTransaction(permit, input.siteId, async (transaction) => {
      const rows = await resolvePlatformTransaction(transaction).query<AccountRow>(
        `${accountProjection()}
         WHERE account.site_ref=$1 AND account.credit_account_ref>$2::uuid
           AND account.created_at<=$3::timestamptz
           AND ($4::text IS NULL OR account.billing_account_ref=$4)
         ORDER BY account.credit_account_ref ASC LIMIT $5`,
        [input.siteId, input.afterRef ?? NIL_UUID, input.watermark, input.billingAccountRef, input.limit],
      );
      return Object.freeze(rows.map(account));
    });
  }

  getCreditAccount(permit: AdminQueryPermit, siteId: string, creditAccountRef: string) {
    return this.host.adminSiteQueryTransaction(permit, siteId, async (transaction) => {
      const rows = await resolvePlatformTransaction(transaction).query<AccountRow>(
        `${accountProjection()} WHERE account.site_ref=$1 AND account.credit_account_ref=$2::uuid LIMIT 1`,
        [siteId, creditAccountRef],
      );
      return rows[0] === undefined ? null : account(rows[0]);
    });
  }

  listCreditGrants(permit: AdminQueryPermit, input: Parameters<AdminCreditReader["listCreditGrants"]>[1]) {
    return this.host.adminSiteQueryTransaction(permit, input.siteId, async (transaction) => {
      const rows = await resolvePlatformTransaction(transaction).query<GrantRow>(
        `SELECT grant_fact.site_ref AS "siteId",grant_fact.credit_grant_id AS "creditGrantId",
           grant_fact.credit_account_ref AS "creditAccountRef",grant_fact.billing_account_ref AS "billingAccountRef",
           grant_fact.credit_program_revision_ref AS "creditProgramRevisionRef",
           grant_fact.source_type AS "sourceType",grant_fact.source_ref AS "sourceRef",
           grant_fact.issuance_journal_transaction_ref AS "issuanceJournalTransactionRef",
           grant_fact.ux_bucket_class AS "uxBucketClass",grant_fact.unit,
           grant_fact.original_amount::text AS "originalAmount",grant_fact.burn_priority AS "burnPriority",
           grant_fact.effective_at AS "effectiveAt",grant_fact.expires_at AS "expiresAt",
           grant_fact.issued_at AS "issuedAt",
           (SELECT count(DISTINCT allocation.credit_hold_ref)::text
             FROM platform.credit_hold_allocation allocation
             WHERE allocation.site_ref=grant_fact.site_ref AND allocation.credit_grant_id=grant_fact.credit_grant_id)
             AS "relatedHoldCount",
           (SELECT count(DISTINCT hold.execution_root_ref)::text
             FROM platform.credit_hold_allocation allocation JOIN platform.credit_hold hold
               ON hold.site_ref=allocation.site_ref AND hold.credit_hold_ref=allocation.credit_hold_ref
             WHERE allocation.site_ref=grant_fact.site_ref AND allocation.credit_grant_id=grant_fact.credit_grant_id)
             AS "relatedExecutionCount"
         FROM platform.credit_grant grant_fact
         WHERE grant_fact.site_ref=$1 AND grant_fact.credit_grant_id>$2::uuid
           AND grant_fact.created_at<=$3::timestamptz
           AND ($4::uuid IS NULL OR grant_fact.credit_account_ref=$4::uuid)
           AND ($5::text IS NULL OR grant_fact.source_ref=$5)
           AND ($6::text IS NULL OR EXISTS (
             SELECT 1 FROM platform.credit_hold_allocation allocation JOIN platform.credit_hold hold
               ON hold.site_ref=allocation.site_ref AND hold.credit_hold_ref=allocation.credit_hold_ref
             WHERE allocation.site_ref=grant_fact.site_ref AND allocation.credit_grant_id=grant_fact.credit_grant_id
               AND hold.execution_root_ref=$6))
         ORDER BY grant_fact.credit_grant_id ASC LIMIT $7`,
        [input.siteId, input.afterRef ?? NIL_UUID, input.watermark, input.creditAccountRef,
          input.sourceRef, input.executionRootRef, input.limit],
      );
      return Object.freeze(rows.map(grant));
    });
  }

  listCreditHolds(permit: AdminQueryPermit, input: Parameters<AdminCreditReader["listCreditHolds"]>[1]) {
    return this.host.adminSiteQueryTransaction(permit, input.siteId, async (transaction) => {
      const rows = await resolvePlatformTransaction(transaction).query<HoldRow>(
        `SELECT hold.site_ref AS "siteId",hold.credit_hold_ref AS "creditHoldRef",
           hold.credit_account_ref AS "creditAccountRef",hold.execution_root_ref AS "executionRootRef",hold.unit,
           hold.requested_amount::text AS "requestedAmount",hold.reserved_amount::text AS "reservedAmount",
           hold.captured_amount::text AS "capturedAmount",hold.released_amount::text AS "releasedAmount",
           hold.state,hold.resolution_kind AS "resolutionKind",hold.resolution_ref AS "resolutionRef",
           hold.fence_epoch AS "fenceEpoch",hold.expires_at AS "expiresAt",hold.settled_at AS "settledAt",
           hold.released_at AS "releasedAt",hold.created_at AS "createdAt",hold.updated_at AS "updatedAt",
           count(DISTINCT allocation.credit_grant_id)::text AS "grantCount",
           count(DISTINCT (grant_fact.source_type,grant_fact.source_ref))::text AS "sourceCount"
         FROM platform.credit_hold hold
         LEFT JOIN platform.credit_hold_allocation allocation
           ON allocation.site_ref=hold.site_ref AND allocation.credit_hold_ref=hold.credit_hold_ref
         LEFT JOIN platform.credit_grant grant_fact
           ON grant_fact.site_ref=allocation.site_ref AND grant_fact.credit_grant_id=allocation.credit_grant_id
         WHERE hold.site_ref=$1 AND hold.credit_hold_ref>$2::uuid AND hold.created_at<=$3::timestamptz
           AND ($4::uuid IS NULL OR hold.credit_account_ref=$4::uuid)
           AND ($5::text IS NULL OR grant_fact.source_ref=$5)
           AND ($6::text IS NULL OR hold.execution_root_ref=$6)
         GROUP BY hold.credit_hold_ref
         ORDER BY hold.credit_hold_ref ASC LIMIT $7`,
        [input.siteId, input.afterRef ?? NIL_UUID, input.watermark, input.creditAccountRef,
          input.sourceRef, input.executionRootRef, input.limit],
      );
      return Object.freeze(rows.map(hold));
    });
  }

  listCreditJournalTransactions(permit: AdminQueryPermit,
    input: Parameters<AdminCreditReader["listCreditJournalTransactions"]>[1]) {
    return this.host.adminSiteQueryTransaction(permit, input.siteId, async (transaction) => {
      const rows = await resolvePlatformTransaction(transaction).query<JournalTransactionRow>(
        `SELECT journal.site_ref AS "siteId",journal.journal_transaction_ref AS "journalTransactionRef",
           journal.credit_account_ref AS "creditAccountRef",journal.unit,
           journal.business_operation_key AS "businessOperationKey",journal.operation_kind AS "operationKind",
           journal.expected_entry_count AS "entryCount",
           journal.reversal_of_transaction_ref AS "reversalOfTransactionRef",
           journal.occurred_at AS "occurredAt",journal.created_at AS "createdAt"
         FROM platform.credit_journal_transaction journal
         WHERE journal.site_ref=$1 AND journal.journal_transaction_ref>$2::uuid
           AND journal.created_at<=$3::timestamptz
           AND ($4::uuid IS NULL OR journal.credit_account_ref=$4::uuid)
           AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM platform.credit_journal_entry entry
             WHERE entry.site_ref=journal.site_ref AND entry.journal_transaction_ref=journal.journal_transaction_ref
               AND entry.credit_grant_id=$5::uuid))
           AND ($6::uuid IS NULL OR EXISTS (SELECT 1 FROM platform.credit_journal_entry entry
             WHERE entry.site_ref=journal.site_ref AND entry.journal_transaction_ref=journal.journal_transaction_ref
               AND entry.credit_hold_ref=$6::uuid))
           AND ($7::text IS NULL OR EXISTS (SELECT 1 FROM platform.credit_journal_entry entry
             JOIN platform.credit_grant grant_fact ON grant_fact.site_ref=entry.site_ref
               AND grant_fact.credit_grant_id=entry.credit_grant_id
             WHERE entry.site_ref=journal.site_ref AND entry.journal_transaction_ref=journal.journal_transaction_ref
               AND grant_fact.source_ref=$7))
           AND ($8::text IS NULL OR EXISTS (SELECT 1 FROM platform.credit_journal_entry entry
             JOIN platform.credit_hold hold ON hold.site_ref=entry.site_ref
               AND hold.credit_hold_ref=entry.credit_hold_ref
             WHERE entry.site_ref=journal.site_ref AND entry.journal_transaction_ref=journal.journal_transaction_ref
               AND hold.execution_root_ref=$8))
         ORDER BY journal.journal_transaction_ref ASC LIMIT $9`,
        [input.siteId, input.afterRef ?? NIL_UUID, input.watermark, input.creditAccountRef,
          input.creditGrantId, input.creditHoldRef, input.sourceRef, input.executionRootRef, input.limit],
      );
      return Object.freeze(rows.map(journalTransaction));
    });
  }

  listCreditJournalEntries(permit: AdminQueryPermit,
    input: Parameters<AdminCreditReader["listCreditJournalEntries"]>[1]) {
    return this.host.adminSiteQueryTransaction(permit, input.siteId, async (transaction) => {
      const rows = await resolvePlatformTransaction(transaction).query<JournalEntryRow>(
        `SELECT entry.site_ref AS "siteId",entry.journal_transaction_ref AS "journalTransactionRef",
           entry.entry_ordinal AS "entryOrdinal",entry.credit_account_ref AS "creditAccountRef",entry.unit,
           entry.entry_side AS "entrySide",entry.account_type AS "accountType",entry.amount::text AS amount,
           entry.credit_grant_id AS "creditGrantId",entry.credit_hold_ref AS "creditHoldRef",
           grant_fact.source_type AS "sourceType",grant_fact.source_ref AS "sourceRef",
           hold.execution_root_ref AS "executionRootRef",entry.created_at AS "createdAt"
         FROM platform.credit_journal_entry entry
         JOIN platform.credit_grant grant_fact
           ON grant_fact.site_ref=entry.site_ref AND grant_fact.credit_grant_id=entry.credit_grant_id
         LEFT JOIN platform.credit_hold hold
           ON hold.site_ref=entry.site_ref AND hold.credit_hold_ref=entry.credit_hold_ref
         WHERE entry.site_ref=$1 AND entry.journal_transaction_ref=$2::uuid
           AND entry.entry_ordinal>$3 ORDER BY entry.entry_ordinal ASC LIMIT $4`,
        [input.siteId, input.journalTransactionRef, input.afterOrdinal ?? -1, input.limit],
      );
      return Object.freeze(rows.map(journalEntry));
    });
  }

  listRatedUsage(permit: AdminQueryPermit, input: Parameters<AdminCreditReader["listRatedUsage"]>[1]) {
    return this.host.adminSiteQueryTransaction(permit, input.siteId, async (transaction) => {
      const rows = await resolvePlatformTransaction(transaction).query<RatedUsageRow>(
        `SELECT usage.site_ref AS "siteId",usage.rated_usage_ref AS "ratedUsageRef",
           usage.authorization_segment_ref AS "authorizationSegmentRef",usage.closure_ref AS "closureRef",
           usage.settlement_ref AS "settlementRef",usage.evidence_ref AS "evidenceRef",
           usage.attempt_ref AS "attemptRef",root.execution_root_ref AS "executionRootRef",
           settlement.credit_hold_ref AS "creditHoldRef",settlement.credit_account_ref AS "creditAccountRef",
           settlement.unit,usage.policy_rated_amount::text AS "policyRatedAmount",
           settlement.customer_amount::text AS "customerAmount",
           settlement.platform_exposure_amount::text AS "platformExposureAmount",
           jsonb_array_length(usage.line_items) AS "lineItemCount",
           usage.rated_usage_digest AS "ratedUsageDigest",
           (SELECT count(DISTINCT (grant_fact.source_type,grant_fact.source_ref))::text
             FROM platform.credit_usage_settlement_source source_fact
             JOIN platform.credit_grant grant_fact ON grant_fact.site_ref=source_fact.site_ref
               AND grant_fact.credit_grant_id=source_fact.credit_grant_id
             WHERE source_fact.site_ref=usage.site_ref AND source_fact.settlement_ref=usage.settlement_ref)
             AS "sourceCount",usage.created_at AS "createdAt"
         FROM platform.credit_rated_usage usage
         JOIN platform.credit_usage_settlement settlement
           ON settlement.site_ref=usage.site_ref AND settlement.settlement_ref=usage.settlement_ref
         JOIN platform.credit_execution_budget_root root
           ON root.site_ref=settlement.site_ref AND root.execution_budget_root_ref=settlement.execution_budget_root_ref
         WHERE usage.site_ref=$1 AND usage.rated_usage_ref>$2::uuid AND usage.created_at<=$3::timestamptz
           AND ($4::uuid IS NULL OR settlement.credit_account_ref=$4::uuid)
           AND ($5::uuid IS NULL OR settlement.credit_hold_ref=$5::uuid)
           AND ($6::text IS NULL OR EXISTS (SELECT 1 FROM platform.credit_usage_settlement_source source_fact
             JOIN platform.credit_grant grant_fact ON grant_fact.site_ref=source_fact.site_ref
               AND grant_fact.credit_grant_id=source_fact.credit_grant_id
             WHERE source_fact.site_ref=usage.site_ref AND source_fact.settlement_ref=usage.settlement_ref
               AND grant_fact.source_ref=$6))
           AND ($7::text IS NULL OR root.execution_root_ref=$7)
           AND ($8::text IS NULL OR usage.attempt_ref=$8)
         ORDER BY usage.rated_usage_ref ASC LIMIT $9`,
        [input.siteId, input.afterRef ?? NIL_UUID, input.watermark, input.creditAccountRef,
          input.creditHoldRef, input.sourceRef, input.executionRootRef, input.attemptRef, input.limit],
      );
      return Object.freeze(rows.map(ratedUsage));
    });
  }
}

function accountProjection(): string {
  return `SELECT account.site_ref AS "siteId",account.credit_account_ref AS "creditAccountRef",
    account.billing_account_ref AS "billingAccountRef",account.unit,account.state,
    account.aggregate_version AS "aggregateVersion",account.created_at AS "createdAt",
    account.updated_at AS "updatedAt",transaction_timestamp() AS "asOf",
    COALESCE(balance.available,0)::text AS "availableAmount",
    COALESCE(balance.reserved,0)::text AS "reservedAmount",
    COALESCE(balance.consumed,0)::text AS "consumedAmount",
    COALESCE(balance.expired,0)::text AS "expiredAmount",
    COALESCE(balance.revoked,0)::text AS "revokedAmount",
    COALESCE(balance.recovery,0)::text AS "recoveryExposureAmount",
    (SELECT count(*)::text FROM platform.credit_grant grant_fact
      WHERE grant_fact.site_ref=account.site_ref AND grant_fact.credit_account_ref=account.credit_account_ref)
      AS "grantCount",
    (SELECT count(*)::text FROM platform.credit_hold hold
      WHERE hold.site_ref=account.site_ref AND hold.credit_account_ref=account.credit_account_ref
        AND hold.state IN ('open','closing')) AS "openHoldCount",
    (SELECT count(*)::text FROM platform.credit_hold hold
      WHERE hold.site_ref=account.site_ref AND hold.credit_account_ref=account.credit_account_ref
        AND hold.state='reconciliation_required') AS "reconciliationRequiredHoldCount"
    FROM platform.credit_account account
    LEFT JOIN LATERAL (SELECT
      sum(CASE WHEN entry.account_type='customer_available'
        THEN CASE entry.entry_side WHEN 'credit' THEN entry.amount ELSE -entry.amount END ELSE 0 END) AS available,
      sum(CASE WHEN entry.account_type='customer_reserved'
        THEN CASE entry.entry_side WHEN 'credit' THEN entry.amount ELSE -entry.amount END ELSE 0 END) AS reserved,
      sum(CASE WHEN entry.account_type='customer_consumed'
        THEN CASE entry.entry_side WHEN 'credit' THEN entry.amount ELSE -entry.amount END ELSE 0 END) AS consumed,
      sum(CASE WHEN entry.account_type='expired'
        THEN CASE entry.entry_side WHEN 'credit' THEN entry.amount ELSE -entry.amount END ELSE 0 END) AS expired,
      sum(CASE WHEN entry.account_type='revoked'
        THEN CASE entry.entry_side WHEN 'credit' THEN entry.amount ELSE -entry.amount END ELSE 0 END) AS revoked,
      sum(CASE WHEN entry.account_type='recovery_exposure'
        THEN CASE entry.entry_side WHEN 'credit' THEN entry.amount ELSE -entry.amount END ELSE 0 END) AS recovery
      FROM platform.credit_journal_entry entry WHERE entry.site_ref=account.site_ref
        AND entry.credit_account_ref=account.credit_account_ref) balance ON true`;
}

interface SummaryRow extends Record<string, unknown> { siteId: unknown; creditAccountCount: unknown;
  activeCreditAccountCount: unknown; openHoldCount: unknown; reconciliationRequiredHoldCount: unknown;
  balances: unknown; asOf: unknown }
interface AccountRow extends Record<string, unknown> { siteId: unknown; creditAccountRef: unknown;
  billingAccountRef: unknown; unit: unknown; state: unknown; aggregateVersion: unknown;
  availableAmount: unknown; reservedAmount: unknown; consumedAmount: unknown; expiredAmount: unknown;
  revokedAmount: unknown; recoveryExposureAmount: unknown; grantCount: unknown; openHoldCount: unknown;
  reconciliationRequiredHoldCount: unknown; createdAt: unknown; updatedAt: unknown; asOf: unknown }
interface GrantRow extends Record<string, unknown> { siteId: unknown; creditGrantId: unknown;
  creditAccountRef: unknown; billingAccountRef: unknown; creditProgramRevisionRef: unknown;
  sourceType: unknown; sourceRef: unknown; issuanceJournalTransactionRef: unknown;
  uxBucketClass: unknown; unit: unknown; originalAmount: unknown; burnPriority: unknown;
  effectiveAt: unknown; expiresAt: unknown; issuedAt: unknown; relatedHoldCount: unknown;
  relatedExecutionCount: unknown }
interface HoldRow extends Record<string, unknown> { siteId: unknown; creditHoldRef: unknown;
  creditAccountRef: unknown; executionRootRef: unknown; unit: unknown; requestedAmount: unknown;
  reservedAmount: unknown; capturedAmount: unknown; releasedAmount: unknown; state: unknown;
  resolutionKind: unknown; resolutionRef: unknown; fenceEpoch: unknown; expiresAt: unknown;
  settledAt: unknown; releasedAt: unknown; createdAt: unknown; updatedAt: unknown;
  grantCount: unknown; sourceCount: unknown }
interface JournalTransactionRow extends Record<string, unknown> { siteId: unknown;
  journalTransactionRef: unknown; creditAccountRef: unknown; unit: unknown;
  businessOperationKey: unknown; operationKind: unknown; entryCount: unknown;
  reversalOfTransactionRef: unknown; occurredAt: unknown; createdAt: unknown }
interface JournalEntryRow extends Record<string, unknown> { siteId: unknown;
  journalTransactionRef: unknown; entryOrdinal: unknown; creditAccountRef: unknown; unit: unknown;
  entrySide: unknown; accountType: unknown; amount: unknown; creditGrantId: unknown;
  creditHoldRef: unknown; sourceType: unknown; sourceRef: unknown; executionRootRef: unknown;
  createdAt: unknown }
interface RatedUsageRow extends Record<string, unknown> { siteId: unknown; ratedUsageRef: unknown;
  authorizationSegmentRef: unknown; closureRef: unknown; settlementRef: unknown; evidenceRef: unknown;
  attemptRef: unknown; executionRootRef: unknown; creditHoldRef: unknown; creditAccountRef: unknown;
  unit: unknown; policyRatedAmount: unknown; customerAmount: unknown; platformExposureAmount: unknown;
  lineItemCount: unknown; ratedUsageDigest: unknown; sourceCount: unknown; createdAt: unknown }

function siteSummary(row: SummaryRow): AdminCreditSiteSummaryRecord {
  return Object.freeze({ siteId: text(row.siteId), creditAccountCount: count(row.creditAccountCount),
    activeCreditAccountCount: count(row.activeCreditAccountCount), openHoldCount: count(row.openHoldCount),
    reconciliationRequiredHoldCount: count(row.reconciliationRequiredHoldCount),
    balances: balances(row.balances), asOf: instant(row.asOf) });
}
function account(row: AccountRow): AdminCreditAccountRecord {
  const unit = text(row.unit); return Object.freeze({ siteId: text(row.siteId),
    creditAccountRef: uuid(row.creditAccountRef), billingAccountRef: text(row.billingAccountRef), unit,
    state: one(row.state, ["active", "suspended", "closed"]), aggregateVersion: positive(row.aggregateVersion),
    balance: balance(unit, row), grantCount: count(row.grantCount), openHoldCount: count(row.openHoldCount),
    reconciliationRequiredHoldCount: count(row.reconciliationRequiredHoldCount),
    createdAt: instant(row.createdAt), updatedAt: instant(row.updatedAt), asOf: instant(row.asOf) });
}
function grant(row: GrantRow): AdminCreditGrantRecord {
  return Object.freeze({ siteId: text(row.siteId), creditGrantId: uuid(row.creditGrantId),
    creditAccountRef: uuid(row.creditAccountRef), billingAccountRef: text(row.billingAccountRef),
    creditProgramRevisionRef: text(row.creditProgramRevisionRef),
    sourceType: one(row.sourceType, ["redemption", "payment", "admin_grant", "program_window"]),
    sourceRef: text(row.sourceRef), issuanceJournalTransactionRef: uuid(row.issuanceJournalTransactionRef),
    uxBucketClass: one(row.uxBucketClass, ["daily", "period", "permanent"]), unit: text(row.unit),
    originalAmount: positiveDecimal(row.originalAmount), burnPriority: integer(row.burnPriority),
    effectiveAt: instant(row.effectiveAt), expiresAt: nullableInstant(row.expiresAt),
    issuedAt: instant(row.issuedAt), relatedHoldCount: count(row.relatedHoldCount),
    relatedExecutionCount: count(row.relatedExecutionCount) });
}
function hold(row: HoldRow): AdminCreditHoldRecord {
  const resolutionKind = nullableOne(row.resolutionKind,
    ["reservation_expiry", "known_outcome", "reconciled"] as const);
  const resolutionRef = nullableText(row.resolutionRef);
  if ((resolutionKind === null) !== (resolutionRef === null)) corrupt();
  return Object.freeze({ siteId: text(row.siteId), creditHoldRef: uuid(row.creditHoldRef),
    creditAccountRef: uuid(row.creditAccountRef), executionRootRef: text(row.executionRootRef),
    unit: text(row.unit), requestedAmount: positiveDecimal(row.requestedAmount),
    reservedAmount: positiveDecimal(row.reservedAmount), capturedAmount: nonNegativeDecimal(row.capturedAmount),
    releasedAmount: nonNegativeDecimal(row.releasedAmount), state: one(row.state,
      ["open", "closing", "settled", "released", "expired", "reconciliation_required"]),
    resolutionKind, resolutionRef, fenceEpoch: positive(row.fenceEpoch), expiresAt: instant(row.expiresAt),
    settledAt: nullableInstant(row.settledAt), releasedAt: nullableInstant(row.releasedAt),
    createdAt: instant(row.createdAt), updatedAt: instant(row.updatedAt), grantCount: count(row.grantCount),
    sourceCount: count(row.sourceCount) });
}
function journalTransaction(row: JournalTransactionRow): AdminCreditJournalTransactionRecord {
  const entryCount = integer(row.entryCount); if (entryCount < 2 || entryCount > 512) corrupt();
  return Object.freeze({ siteId: text(row.siteId), journalTransactionRef: uuid(row.journalTransactionRef),
    creditAccountRef: uuid(row.creditAccountRef), unit: text(row.unit),
    businessOperationKey: text(row.businessOperationKey), operationKind: one(row.operationKind,
      ["grant_issue", "hold_reserve", "hold_capture", "hold_release", "grant_expire", "grant_revoke",
        "correction", "reversal"]), entryCount,
    reversalOfTransactionRef: nullableUuid(row.reversalOfTransactionRef),
    occurredAt: instant(row.occurredAt), createdAt: instant(row.createdAt) });
}
function journalEntry(row: JournalEntryRow): AdminCreditJournalEntryRecord {
  return Object.freeze({ siteId: text(row.siteId), journalTransactionRef: uuid(row.journalTransactionRef),
    entryOrdinal: nonNegativeInteger(row.entryOrdinal), creditAccountRef: uuid(row.creditAccountRef),
    unit: text(row.unit), entrySide: one(row.entrySide, ["debit", "credit"]), accountType: one(row.accountType,
      ["grant_issuance_source", "customer_available", "customer_reserved", "customer_consumed",
        "expired", "revoked", "adjustment", "recovery_exposure"]),
    amount: positiveDecimal(row.amount), creditGrantId: uuid(row.creditGrantId),
    creditHoldRef: nullableUuid(row.creditHoldRef), sourceType: one(row.sourceType,
      ["redemption", "payment", "admin_grant", "program_window"]), sourceRef: text(row.sourceRef),
    executionRootRef: nullableText(row.executionRootRef), createdAt: instant(row.createdAt) });
}
function ratedUsage(row: RatedUsageRow): AdminRatedUsageRecord {
  return Object.freeze({ siteId: text(row.siteId), ratedUsageRef: uuid(row.ratedUsageRef),
    authorizationSegmentRef: uuid(row.authorizationSegmentRef), closureRef: uuid(row.closureRef),
    settlementRef: uuid(row.settlementRef), evidenceRef: uuid(row.evidenceRef), attemptRef: text(row.attemptRef),
    executionRootRef: text(row.executionRootRef), creditHoldRef: uuid(row.creditHoldRef),
    creditAccountRef: uuid(row.creditAccountRef), unit: text(row.unit),
    policyRatedAmount: nonNegativeDecimal(row.policyRatedAmount),
    customerAmount: nonNegativeDecimal(row.customerAmount),
    platformExposureAmount: nonNegativeDecimal(row.platformExposureAmount),
    lineItemCount: nonNegativeInteger(row.lineItemCount),
    ratedUsageDigest: digest(row.ratedUsageDigest), sourceCount: count(row.sourceCount),
    createdAt: instant(row.createdAt) });
}
function balances(value: unknown): readonly CreditBalanceRecord[] {
  let parsed = value; if (typeof value === "string") try { parsed = JSON.parse(value) as unknown; } catch { corrupt(); }
  if (!Array.isArray(parsed) || parsed.length > 64) corrupt();
  return Object.freeze(parsed.map((item) => { const row = record(item); return balance(text(row.unit), row); }));
}
function balance(unit: string, row: Record<string, unknown>): CreditBalanceRecord {
  return Object.freeze({ unit, availableAmount: signedDecimal(row.availableAmount),
    reservedAmount: signedDecimal(row.reservedAmount), consumedAmount: signedDecimal(row.consumedAmount),
    expiredAmount: signedDecimal(row.expiredAmount), revokedAmount: signedDecimal(row.revokedAmount),
    recoveryExposureAmount: signedDecimal(row.recoveryExposureAmount) });
}
function requiredRow<Row>(rows: readonly Row[]): Row { if (rows.length !== 1) corrupt(); return rows[0]!; }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) corrupt();
  return value as Record<string, unknown>;
}
function text(value: unknown): string { if (typeof value !== "string" || value.length < 1 || value.length > 256) corrupt(); return value; }
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function uuid(value: unknown): string { const result = text(value); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(result)) corrupt(); return result; }
function nullableUuid(value: unknown): string | null { return value === null ? null : uuid(value); }
function positiveDecimal(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,37}$/u.test(value)) corrupt(); return value;
}
function nonNegativeDecimal(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9]{1,38}$/u.test(value)) corrupt(); return value;
}
function signedDecimal(value: unknown): string {
  if (typeof value !== "string" || !/^-?[0-9]{1,38}$/u.test(value)) corrupt(); return value;
}
function positive(value: unknown): bigint { const result = bigint(value); if (result < 1n) corrupt(); return result; }
function count(value: unknown): bigint { const result = bigint(value); if (result < 0n) corrupt(); return result; }
function bigint(value: unknown): bigint {
  try { if (typeof value === "bigint") return value; if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
    if (typeof value === "string" && /^-?[0-9]+$/u.test(value)) return BigInt(value); } catch { corrupt(); }
  return corrupt();
}
function integer(value: unknown): number { if (typeof value !== "number" || !Number.isInteger(value)) corrupt(); return value; }
function nonNegativeInteger(value: unknown): number { const result = integer(value); if (result < 0) corrupt(); return result; }
function instant(value: unknown): string { const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (date === null || !Number.isFinite(date.getTime())) corrupt(); return date.toISOString(); }
function nullableInstant(value: unknown): string | null { return value === null ? null : instant(value); }
function digest(value: unknown): string { const result = text(value); if (!/^[a-f0-9]{64}$/u.test(result)) corrupt(); return result; }
function one<const Value extends string>(value: unknown, allowed: readonly Value[]): Value {
  if (typeof value !== "string" || !allowed.includes(value as Value)) return corrupt(); return value as Value;
}
function nullableOne<const Value extends string>(value: unknown, allowed: readonly Value[]): Value | null {
  return value === null ? null : one(value, allowed);
}
function corrupt(): never { throw new Error("ADMIN_CREDIT_ROW_CORRUPT"); }
