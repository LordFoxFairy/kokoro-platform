import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { AttemptUsageEvidence, RatingPolicyRevision } from "../../domain/usage-rating.js";
import { PostgresCreditAuthorityRepository } from "./credit-authority-repository.js";
import type {
  StoredAttemptUsageEvidence,
  StoredUsageAttemptIntent,
  StoredUsageSettlementContext,
  UsageCommandIdentity,
  UsageCommandReceiptLookup,
  UsageAttemptReceipt,
  UsageEvidenceReceipt,
  UsageReconciliationRecord,
  UsageReferenceKind,
  UsageSettlementRecord,
  UsageSettlementRepository,
  UsageSettlementReceipt,
} from "../../application/contracts/usage-settlement-repository.js";

const ratingPolicySchema = z.object({
  ratingPolicyRevisionRef: z.string().min(1).max(256),
  customerUnit: z.string().min(1).max(64),
  chargeableAttemptOutcomes: z.array(z.enum([
    "succeeded", "failed_before_effect", "failed_after_effect",
    "canceled_before_effect", "canceled_after_effect",
  ])).min(1).max(16),
  minimumAmount: z.string().regex(/^[0-9]{1,38}$/u),
  rules: z.array(z.object({
    dimensionKey: z.string().min(1).max(256), sourceUnit: z.string().min(1).max(64),
    quantum: z.string().regex(/^[1-9][0-9]{0,37}$/u),
    amountPerQuantum: z.string().regex(/^[0-9]{1,38}$/u), required: z.boolean(),
  }).strict()).min(1).max(64),
}).strict();

interface ReceiptRow extends Record<string, unknown> {
  requestDigest: string;
  result: unknown;
  resultDigest: string;
}

interface PolicyRow extends Record<string, unknown> {
  policy: unknown;
  policyDigest: string;
  ratingSnapshotRef: string | null;
}

interface EvidenceRow extends Record<string, unknown> {
  siteId: string; attemptAuthorizationRef: string; executionBudgetRootRef: string; budgetAllocationRef: string;
  creditHoldRef: string; creditAccountId: string; unit: string; evidenceRef: string;
  businessOperationKey: string; requestDigest: string; evidence: unknown;
  evidenceDigest: string; observedAt: Date | string;
}

interface AttemptIntentRow extends Record<string, unknown> {
  siteId: string; executionBudgetRootRef: string; budgetAllocationRef: string;
  authorizationSegmentRef: string; creditHoldRef: string; creditAccountId: string; unit: string;
  executionManifestRef: string; attemptAuthorizationRef: string;
  producerKind: StoredUsageAttemptIntent["producerKind"]; producerContext: string;
  producerGeneration: bigint | string; attemptRef: string; logicalEffectRef: string;
  maximumDimensions: unknown; maximumDimensionsDigest: string; maximumAmount: string;
  provisionalCustomerAmount: string | null;
  state: StoredUsageAttemptIntent["state"]; fenceEpoch: bigint | string;
  ownerEvidenceRef: string | null;
}

interface SettlementRow extends Record<string, unknown> {
  settlementRef: string; closureRef: string; closureRevision: bigint | string;
  customerAmount: string; platformExposureAmount: string;
}

interface HoldAllocationRow extends Record<string, unknown> {
  creditGrantId: string; ordinal: number; allocatedAmount: string; netCustomerAmount: string;
}

export class PostgresUsageSettlementRepository implements UsageSettlementRepository {
  readonly #credit = new PostgresCreditAuthorityRepository();
  readonly #reference: (kind: UsageReferenceKind) => string;

  constructor(options: Readonly<{ reference?: (kind: UsageReferenceKind) => string }> = {}) {
    this.#reference = options.reference ?? (() => randomUUID());
  }

  async findCommandReceipt(
    transaction: PlatformTransaction,
    identity: UsageCommandIdentity,
  ): Promise<UsageCommandReceiptLookup> {
    const rows = await resolvePlatformTransaction(transaction).query<ReceiptRow>(
      `SELECT request_digest AS "requestDigest",result,result_digest AS "resultDigest"
         FROM platform.credit_usage_command_receipt
        WHERE site_ref=$1 AND operation_kind=$2 AND business_operation_key=$3
        LIMIT 1`,
      [identity.siteId, identity.operationKind, identity.businessOperationKey],
    );
    const row = only(rows, "CREDIT_USAGE_RECEIPT_AMBIGUOUS");
    if (row === undefined) return { kind: "none" };
    if (row.requestDigest !== identity.requestDigest) return { kind: "conflict", code: "REQUEST_DIGEST_CONFLICT" };
    if (digest(canonical(row.result)) !== row.resultDigest) throw new Error("CREDIT_USAGE_RECEIPT_CORRUPT");
    return { kind: "replayed", value: parseReceipt(row.result) };
  }

  async lockUsageContext(
    transaction: PlatformTransaction,
    input: Readonly<{ siteId: string; authorizationSegmentRef: string }>,
  ): Promise<StoredUsageSettlementContext | null> {
    const segment = await this.#credit.lockSegmentAllocation(transaction, input);
    if (segment === null) return null;
    const rows = await resolvePlatformTransaction(transaction).query<PolicyRow>(
      `SELECT policy.policy,policy.policy_digest AS "policyDigest",
              snapshot.rating_snapshot_ref AS "ratingSnapshotRef"
         FROM platform.credit_rating_policy_revision policy
         LEFT JOIN platform.credit_rating_snapshot snapshot
           ON snapshot.site_ref=policy.site_ref AND snapshot.authorization_segment_ref=$3::uuid
        WHERE policy.site_ref=$1 AND policy.rating_policy_revision_ref=$2 AND policy.unit=$4
          AND policy.state='published'
        LIMIT 2`,
      [input.siteId, segment.ratingPolicyRevisionRef, input.authorizationSegmentRef, segment.unit],
    );
    const row = only(rows, "CREDIT_RATING_POLICY_AMBIGUOUS");
    if (row === undefined || digest(canonical(row.policy)) !== row.policyDigest) {
      throw new Error("CREDIT_RATING_POLICY_NOT_AVAILABLE");
    }
    return Object.freeze({
      ...segment,
      ratingPolicy: parseRatingPolicy(row.policy),
      ratingSnapshotRef: row.ratingSnapshotRef,
    });
  }

  async loadCommittedAttemptMaximum(
    transaction: PlatformTransaction,
    input: Parameters<UsageSettlementRepository["loadCommittedAttemptMaximum"]>[1],
  ): Promise<bigint> {
    const rows = await resolvePlatformTransaction(transaction).query<{ maximumAmount: string }>(
      `SELECT COALESCE(sum(CASE WHEN state='finalized'
              THEN COALESCE(provisional_customer_amount,maximum_amount)
              ELSE maximum_amount END),0)::text AS "maximumAmount"
         FROM platform.credit_usage_attempt_intent
        WHERE site_ref=$1 AND authorization_segment_ref=$2::uuid`,
      [input.siteId, input.authorizationSegmentRef],
    );
    const row = only(rows, "CREDIT_USAGE_ATTEMPT_CAPACITY_AMBIGUOUS");
    return row === undefined ? 0n : BigInt(row.maximumAmount);
  }

  async persistAttemptIntent(
    transaction: PlatformTransaction,
    record: Parameters<UsageSettlementRepository["persistAttemptIntent"]>[1],
  ) {
    const sql = resolvePlatformTransaction(transaction);
    await one(sql.execute(
      `INSERT INTO platform.credit_usage_attempt_intent
       (attempt_authorization_ref,site_ref,execution_budget_root_ref,budget_allocation_ref,
        authorization_segment_ref,credit_hold_ref,credit_account_ref,unit,execution_manifest_ref,
        producer_kind,producer_context,producer_generation,attempt_ref,logical_effect_ref,maximum_dimensions,
        maximum_dimensions_digest,maximum_amount,provisional_customer_amount,state,fence_epoch,
        owner_evidence_ref,committed_at,updated_at)
       VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8,$9,$10,$11,$12::bigint,
               $13,$14,$15::jsonb,$16,$17::numeric,$18::numeric,$19,$20::bigint,$21,$22::timestamptz,$22::timestamptz)`,
      [record.attemptAuthorizationRef, record.siteId, record.executionBudgetRootRef, record.budgetAllocationRef,
        record.authorizationSegmentRef, record.creditHoldRef, record.creditAccountId, record.unit,
        record.executionManifestRef, record.producerKind, record.producerContext,
        record.producerGeneration.toString(), record.attemptRef, record.logicalEffectRef,
        canonical(record.maximumDimensions), record.maximumDimensionsDigest, record.maximumAmount.toString(),
        record.provisionalCustomerAmount?.toString() ?? null, record.state, record.fenceEpoch.toString(),
        record.ownerEvidenceRef,
        record.committedAt],
    ), "CREDIT_USAGE_ATTEMPT_INTENT_PERSIST_FAILED");
    await writeReceipt(sql, record.identity, record.receipt, record.receiptRef,
      record.committedAt, "accepted");
    return { kind: "accepted" as const, value: record.receipt };
  }

  async lockAttemptIntent(
    transaction: PlatformTransaction,
    input: Parameters<UsageSettlementRepository["lockAttemptIntent"]>[1],
  ): Promise<StoredUsageAttemptIntent | null> {
    const rows = await resolvePlatformTransaction(transaction).query<AttemptIntentRow>(
      `${ATTEMPT_INTENT_SELECT}
        WHERE site_ref=$1 AND attempt_authorization_ref=$2::uuid
        LIMIT 2 FOR UPDATE`,
      [input.siteId, input.attemptAuthorizationRef],
    );
    const row = only(rows, "CREDIT_USAGE_ATTEMPT_INTENT_AMBIGUOUS");
    return row === undefined ? null : mapAttemptIntent(row);
  }

  async updateAttemptIntent(
    transaction: PlatformTransaction,
    record: Parameters<UsageSettlementRepository["updateAttemptIntent"]>[1],
  ) {
    const sql = resolvePlatformTransaction(transaction);
    await one(sql.execute(
      `UPDATE platform.credit_usage_attempt_intent
          SET fence_epoch=$1::bigint,state=$2,owner_evidence_ref=$3,updated_at=$4::timestamptz
        WHERE site_ref=$5 AND attempt_authorization_ref=$6::uuid AND state=$7 AND fence_epoch=$8::bigint`,
      [record.fenceEpoch.toString(), record.state, record.ownerEvidenceRef, record.observedAt,
        record.siteId, record.attemptAuthorizationRef,
        record.state === "outcome_unknown" ? "effect_committed" : record.state,
        (record.fenceEpoch - 1n).toString()],
    ), "CREDIT_USAGE_ATTEMPT_FENCE_CAS_LOST");
    await writeReceipt(sql, record.identity, record.receipt, record.receiptRef,
      record.observedAt, "accepted");
    return { kind: "accepted" as const, value: record.receipt };
  }

  async lockLatestAttemptEvidence(
    transaction: PlatformTransaction,
    input: Parameters<UsageSettlementRepository["lockLatestAttemptEvidence"]>[1],
  ): Promise<StoredAttemptUsageEvidence | null> {
    const rows = await resolvePlatformTransaction(transaction).query<EvidenceRow>(
      `${EVIDENCE_SELECT}
        WHERE evidence.site_ref=$1 AND evidence.authorization_segment_ref=$2::uuid
          AND evidence.producer_kind=$3 AND evidence.producer_context=$4
          AND evidence.producer_generation=$5::bigint AND evidence.attempt_ref=$6
        ORDER BY evidence.revision DESC LIMIT 1 FOR UPDATE`,
      [input.siteId, input.authorizationSegmentRef, input.producerKind, input.producerContext,
        input.producerGeneration.toString(), input.attemptRef],
    );
    const row = only(rows, "CREDIT_USAGE_ATTEMPT_AMBIGUOUS");
    return row === undefined ? null : mapEvidence(row);
  }

  async persistAttemptUsage(
    transaction: PlatformTransaction,
    record: Parameters<UsageSettlementRepository["persistAttemptUsage"]>[1],
  ) {
    const sql = resolvePlatformTransaction(transaction);
    const evidenceJson = canonical(record.evidence);
    await one(sql.execute(
      `INSERT INTO platform.credit_attempt_usage_evidence
       (evidence_ref,attempt_authorization_ref,site_ref,execution_budget_root_ref,budget_allocation_ref,authorization_segment_ref,
        credit_hold_ref,credit_account_ref,unit,execution_manifest_ref,producer_kind,producer_context,
        producer_generation,attempt_ref,logical_effect_ref,revision,correction_of_evidence_ref,evidence_kind,
        attempt_outcome,source_digest,evidence,evidence_digest,occurred_at,observed_at)
       VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid,$9,$10,$11,$12,$13::bigint,$14,$15,
               $16::bigint,$17::uuid,$18,$19,$20,$21::jsonb,$22,$23::timestamptz,$24::timestamptz)`,
      [record.evidenceRef, record.attemptAuthorizationRef, record.siteId, record.executionBudgetRootRef, record.budgetAllocationRef,
        record.evidence.authorizationSegmentRef, record.creditHoldRef, record.creditAccountId, record.unit,
        record.evidence.executionManifestRef, record.evidence.producerKind, record.evidence.producerContext,
        record.evidence.producerGeneration.toString(), record.evidence.attemptRef, record.evidence.logicalEffectRef,
        record.evidence.revision.toString(), record.evidence.correctionOfEvidenceRef, record.evidence.evidenceKind,
        record.evidence.attemptOutcome, record.evidence.sourceDigest, evidenceJson, record.evidenceDigest,
        record.evidence.occurredAt, record.observedAt],
    ), "CREDIT_USAGE_EVIDENCE_PERSIST_FAILED");
    await one(sql.execute(
      `UPDATE platform.credit_usage_attempt_intent
          SET fence_epoch=$1::bigint,state='finalized',owner_evidence_ref=$2,
              provisional_customer_amount=$3::numeric,updated_at=$4::timestamptz
        WHERE site_ref=$5 AND attempt_authorization_ref=$6::uuid
          AND state=$7 AND fence_epoch=$8::bigint`,
      [record.nextFenceEpoch.toString(), record.evidenceRef,
        record.provisionalCustomerAmount?.toString() ?? null, record.observedAt, record.siteId,
        record.attemptAuthorizationRef, record.priorAttemptState, record.priorFenceEpoch.toString()],
    ), "CREDIT_USAGE_ATTEMPT_FENCE_CAS_LOST");
    const value: UsageEvidenceReceipt = Object.freeze({
      evidenceRef: record.evidenceRef,
      revision: record.evidence.revision,
    });
    await writeReceipt(sql, record.identity, value, record.receiptRef,
      record.observedAt, "accepted");
    return { kind: "accepted" as const, value };
  }

  async loadClosureEvidence(
    transaction: PlatformTransaction,
    input: Parameters<UsageSettlementRepository["loadClosureEvidence"]>[1],
  ): Promise<readonly StoredAttemptUsageEvidence[]> {
    if (input.evidenceRefs.length === 0) return [];
    const rows = await resolvePlatformTransaction(transaction).query<EvidenceRow>(
      `${EVIDENCE_SELECT}
        WHERE evidence.site_ref=$1 AND evidence.authorization_segment_ref=$2::uuid
          AND intent.owner_evidence_ref=evidence.evidence_ref::text
          AND NOT EXISTS (
            SELECT 1 FROM platform.credit_attempt_usage_evidence later
             WHERE later.site_ref=evidence.site_ref
               AND later.producer_kind=evidence.producer_kind
               AND later.producer_context=evidence.producer_context
               AND later.producer_generation=evidence.producer_generation
               AND later.attempt_ref=evidence.attempt_ref AND later.revision>evidence.revision
          )
        ORDER BY evidence.attempt_ref`,
      [input.siteId, input.authorizationSegmentRef],
    );
    return Object.freeze(rows.map(mapEvidence));
  }

  async loadOpenAttemptCount(
    transaction: PlatformTransaction,
    input: Parameters<UsageSettlementRepository["loadOpenAttemptCount"]>[1],
  ): Promise<bigint> {
    const rows = await resolvePlatformTransaction(transaction).query<{ openCount: string }>(
      `SELECT count(*)::text AS "openCount"
         FROM platform.credit_usage_attempt_intent
        WHERE site_ref=$1 AND authorization_segment_ref=$2::uuid AND state<>'finalized'`,
      [input.siteId, input.authorizationSegmentRef],
    );
    const row = only(rows, "CREDIT_USAGE_ATTEMPT_COUNT_AMBIGUOUS");
    return row === undefined ? 0n : BigInt(row.openCount);
  }

  async loadPriorSettlement(
    transaction: PlatformTransaction,
    input: Parameters<UsageSettlementRepository["loadPriorSettlement"]>[1],
  ) {
    const rows = await resolvePlatformTransaction(transaction).query<SettlementRow>(
      `SELECT settlement.settlement_ref AS "settlementRef",settlement.closure_ref AS "closureRef",
              settlement.closure_revision AS "closureRevision",settlement.customer_amount::text AS "customerAmount",
              settlement.platform_exposure_amount::text AS "platformExposureAmount"
         FROM platform.credit_usage_settlement settlement
        WHERE settlement.site_ref=$1 AND settlement.authorization_segment_ref=$2::uuid
        ORDER BY settlement.closure_revision DESC LIMIT 1`,
      [input.siteId, input.authorizationSegmentRef],
    );
    const row = only(rows, "CREDIT_USAGE_SETTLEMENT_AMBIGUOUS");
    return row === undefined ? null : Object.freeze({ settlementRef: row.settlementRef,
      closureRef: row.closureRef, closureRevision: BigInt(row.closureRevision),
      customerAmount: BigInt(row.customerAmount), platformExposureAmount: BigInt(row.platformExposureAmount) });
  }

  async loadPriorClosure(
    transaction: PlatformTransaction,
    input: Parameters<UsageSettlementRepository["loadPriorClosure"]>[1],
  ) {
    const rows = await resolvePlatformTransaction(transaction).query<{
      closureRef: string;
      closureRevision: string;
    }>(
      `SELECT closure_ref AS "closureRef",closure_revision AS "closureRevision"
         FROM platform.credit_usage_segment_closure
        WHERE site_ref=$1 AND authorization_segment_ref=$2::uuid
        ORDER BY closure_revision DESC LIMIT 1`,
      [input.siteId, input.authorizationSegmentRef],
    );
    const row = only(rows, "CREDIT_USAGE_CLOSURE_AMBIGUOUS");
    return row === undefined ? null : Object.freeze({
      closureRef: row.closureRef,
      closureRevision: BigInt(row.closureRevision),
    });
  }

  async lockHoldAllocations(
    transaction: PlatformTransaction,
    input: Parameters<UsageSettlementRepository["lockHoldAllocations"]>[1],
  ) {
    const sql = resolvePlatformTransaction(transaction);
    await sql.query(
      `SELECT credit_grant_id
         FROM platform.credit_hold_allocation
        WHERE site_ref=$1 AND credit_hold_ref=$2::uuid
        ORDER BY allocation_ordinal FOR UPDATE`,
      [input.siteId, input.creditHoldRef],
    );
    const rows = await sql.query<HoldAllocationRow>(
      `SELECT allocation.credit_grant_id AS "creditGrantId",allocation.allocation_ordinal AS ordinal,
              allocation.allocated_amount::text AS "allocatedAmount",
              COALESCE(sum(CASE source.direction
                WHEN 'capture' THEN source.amount WHEN 'increase' THEN source.amount
                WHEN 'decrease' THEN -source.amount END),0)::text AS "netCustomerAmount"
         FROM platform.credit_hold_allocation allocation
         LEFT JOIN platform.credit_usage_settlement_source source
           ON source.site_ref=allocation.site_ref AND source.credit_hold_ref=allocation.credit_hold_ref
          AND source.credit_grant_id=allocation.credit_grant_id
        WHERE allocation.site_ref=$1 AND allocation.credit_hold_ref=$2::uuid
        GROUP BY allocation.credit_grant_id,allocation.allocation_ordinal,allocation.allocated_amount
        ORDER BY allocation.allocation_ordinal`,
      [input.siteId, input.creditHoldRef],
    );
    return Object.freeze(rows.map((row) => Object.freeze({ creditGrantId: row.creditGrantId,
      ordinal: row.ordinal, allocatedAmount: BigInt(row.allocatedAmount),
      netCustomerAmount: BigInt(row.netCustomerAmount) })));
  }

  async persistSettlement(
    transaction: PlatformTransaction,
    record: UsageSettlementRecord,
  ) {
    const sql = resolvePlatformTransaction(transaction);
    if (record.context.ratingSnapshotRef === null) await one(sql.execute(
      `INSERT INTO platform.credit_rating_snapshot
       (rating_snapshot_ref,site_ref,authorization_segment_ref,rating_policy_revision_ref,unit,snapshot,
        snapshot_digest,created_at)
       VALUES ($1::uuid,$2,$3::uuid,$4,$5,$6::jsonb,$7,$8::timestamptz)`,
      [record.ratingSnapshotRef, record.context.siteId, record.context.authorizationSegmentRef,
        record.context.ratingPolicyRevisionRef, record.context.unit, canonical(record.context.ratingPolicy),
        record.ratingSnapshotDigest, record.settledAt],
    ), "CREDIT_RATING_SNAPSHOT_PERSIST_FAILED");
    await insertClosure(sql, record);
    if (record.ratingPendingSegment !== undefined) {
      await updateSegment(sql, record.context, record.ratingPendingSegment, record.settledAt);
    }
    if (record.allocation !== undefined) {
      await insertAllocationRevision(sql, record, this.#reference("allocation-revision"));
    }
    if (record.segment !== undefined) await updateSegment(sql, record.context, record.segment, record.settledAt);
    if (record.journalTransactionRef !== undefined) await insertJournal(sql, record);
    await one(sql.execute(
      `INSERT INTO platform.credit_usage_settlement
       (settlement_ref,site_ref,execution_budget_root_ref,budget_allocation_ref,authorization_segment_ref,
        credit_hold_ref,credit_account_ref,unit,closure_ref,closure_revision,prior_settlement_ref,
        rating_snapshot_ref,policy_rated_amount,segment_maximum_amount,customer_amount,
        platform_exposure_amount,journal_transaction_ref,settled_at)
       VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8,$9::uuid,$10::bigint,$11::uuid,
               $12::uuid,$13::numeric,$14::numeric,$15::numeric,$16::numeric,$17::uuid,$18::timestamptz)`,
      [record.receipt.settlementRef, record.context.siteId, record.context.executionBudgetRootRef,
        record.context.budgetAllocationRef, record.context.authorizationSegmentRef, record.context.creditHoldRef,
        record.context.creditAccountId, record.context.unit, record.receipt.closureRef,
        record.receipt.closureRevision.toString(), record.priorSettlementRef ?? null, record.ratingSnapshotRef,
        record.policyRatedAmount.toString(), record.context.segment.maximumAmount.toString(),
        record.customerAmount.toString(), record.platformExposureAmount.toString(),
        record.journalTransactionRef ?? null, record.settledAt],
    ), "CREDIT_USAGE_SETTLEMENT_PERSIST_FAILED");
    for (const [index, source] of record.sourceMutations.entries()) await one(sql.execute(
      `INSERT INTO platform.credit_usage_settlement_source
       (settlement_ref,source_ordinal,site_ref,authorization_segment_ref,credit_hold_ref,credit_grant_id,
        credit_account_ref,unit,allocation_ordinal,direction,amount)
       VALUES ($1::uuid,$2,$3,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8,$9,$10,$11::numeric)`,
      [record.receipt.settlementRef, index, record.context.siteId, record.context.authorizationSegmentRef,
        record.context.creditHoldRef, source.creditGrantId, record.context.creditAccountId, record.context.unit,
        source.ordinal, source.direction, source.amount.toString()],
    ), "CREDIT_USAGE_SETTLEMENT_SOURCE_PERSIST_FAILED");
    for (const attempt of record.attemptRatings) {
      const evidence = record.evidenceSet.find((item) => item.evidence.attemptRef === attempt.attemptRef &&
        item.evidence.producerKind === attempt.producerKind &&
        item.evidence.producerContext === attempt.producerContext &&
        item.evidence.producerGeneration === attempt.producerGeneration);
      if (evidence === undefined) throw new Error("CREDIT_RATED_USAGE_EVIDENCE_MISSING");
      const ratedJson = canonical(attempt.lineItems);
      await one(sql.execute(
        `INSERT INTO platform.credit_rated_usage
         (rated_usage_ref,site_ref,authorization_segment_ref,closure_ref,settlement_ref,rating_snapshot_ref,
          evidence_ref,attempt_ref,policy_rated_amount,line_items,rated_usage_digest)
         VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8,$9::numeric,$10::jsonb,$11)`,
        [this.#reference("rated-usage"), record.context.siteId, record.context.authorizationSegmentRef,
          record.receipt.closureRef, record.receipt.settlementRef, record.ratingSnapshotRef, evidence.evidenceRef,
          attempt.attemptRef, attempt.policyRatedAmount.toString(), ratedJson, digest(ratedJson)],
      ), "CREDIT_RATED_USAGE_PERSIST_FAILED");
    }
    if (record.varianceRef !== undefined) await one(sql.execute(
      `INSERT INTO platform.credit_usage_variance
       (variance_ref,site_ref,authorization_segment_ref,settlement_ref,policy_rated_amount,
        customer_amount,platform_exposure_amount)
       VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5::numeric,$6::numeric,$7::numeric)`,
      [record.varianceRef, record.context.siteId, record.context.authorizationSegmentRef,
        record.receipt.settlementRef, record.policyRatedAmount.toString(), record.customerAmount.toString(),
        record.platformExposureAmount.toString()],
    ), "CREDIT_USAGE_VARIANCE_PERSIST_FAILED");
    await writeReceipt(sql, record.identity, record.receipt, record.receiptRef,
      record.settledAt, "accepted");
    return { kind: "accepted" as const, value: record.receipt };
  }

  async persistReconciliationRequired(transaction: PlatformTransaction, record: UsageReconciliationRecord) {
    const sql = resolvePlatformTransaction(transaction);
    if (record.segment !== undefined) {
      await updateSegment(sql, record.context, record.segment, record.observedAt);
      if (record.context.executionBudgetRootState !== "reconciliation_required") await one(sql.execute(
        `UPDATE platform.credit_execution_budget_root
            SET state='reconciliation_required',aggregate_version=aggregate_version+1,updated_at=$3::timestamptz
          WHERE execution_budget_root_ref=$1::uuid AND site_ref=$2 AND state=$4
            AND aggregate_version=$5::bigint`,
        [record.context.executionBudgetRootRef, record.context.siteId, record.observedAt,
          record.context.executionBudgetRootState, record.context.executionBudgetRootVersion.toString()],
      ), "CREDIT_USAGE_ROOT_RECONCILIATION_CAS_LOST");
      if (record.context.creditHoldState !== "reconciliation_required") await one(sql.execute(
        `UPDATE platform.credit_hold
            SET state='reconciliation_required',fence_epoch=fence_epoch+1,updated_at=$3::timestamptz
          WHERE credit_hold_ref=$1::uuid AND site_ref=$2 AND state=$4 AND fence_epoch=$5::bigint`,
        [record.context.creditHoldRef, record.context.siteId, record.observedAt,
          record.context.creditHoldState, record.context.creditHoldFenceEpoch.toString()],
      ), "CREDIT_USAGE_HOLD_RECONCILIATION_CAS_LOST");
    }
    await insertClosure(sql, record);
    const reconciliationRef = this.#reference("usage-settlement");
    await one(sql.execute(
      `INSERT INTO platform.credit_usage_reconciliation
       (reconciliation_ref,site_ref,authorization_segment_ref,closure_ref,reason,observed_at)
       VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5,$6::timestamptz)`,
      [reconciliationRef, record.context.siteId, record.context.authorizationSegmentRef, record.closureRef,
        record.code === "CREDIT_USAGE_UNAVAILABLE" ? "usage_unavailable" : "required_dimension_missing",
        record.observedAt],
    ), "CREDIT_USAGE_RECONCILIATION_PERSIST_FAILED");
    const value = Object.freeze({ authorizationSegmentRef: record.context.authorizationSegmentRef, code: record.code });
    await writeReceipt(sql, record.identity, value, record.receiptRef,
      record.observedAt, "reconciliation_required");
    return { kind: "reconciliation_required" as const, value };
  }
}

const EVIDENCE_SELECT = `SELECT evidence.site_ref AS "siteId",
  evidence.attempt_authorization_ref AS "attemptAuthorizationRef",
  evidence.execution_budget_root_ref AS "executionBudgetRootRef",
  evidence.budget_allocation_ref AS "budgetAllocationRef",evidence.credit_hold_ref AS "creditHoldRef",
  evidence.credit_account_ref AS "creditAccountId",evidence.unit,evidence.evidence_ref AS "evidenceRef",
  receipt.business_operation_key AS "businessOperationKey",receipt.request_digest AS "requestDigest",
  evidence.evidence,evidence.evidence_digest AS "evidenceDigest",evidence.observed_at AS "observedAt"
 FROM platform.credit_attempt_usage_evidence evidence
 JOIN platform.credit_usage_attempt_intent intent
   ON intent.site_ref=evidence.site_ref
  AND intent.attempt_authorization_ref=evidence.attempt_authorization_ref
 JOIN platform.credit_usage_command_receipt receipt
   ON receipt.site_ref=evidence.site_ref AND receipt.operation_kind='finalize_attempt'
  AND receipt.result->>'evidenceRef'=evidence.evidence_ref::text`;

const ATTEMPT_INTENT_SELECT = `SELECT site_ref AS "siteId",
  execution_budget_root_ref AS "executionBudgetRootRef",budget_allocation_ref AS "budgetAllocationRef",
  authorization_segment_ref AS "authorizationSegmentRef",credit_hold_ref AS "creditHoldRef",
  credit_account_ref AS "creditAccountId",unit,execution_manifest_ref AS "executionManifestRef",
  attempt_authorization_ref AS "attemptAuthorizationRef",producer_kind AS "producerKind",
  producer_context AS "producerContext",producer_generation AS "producerGeneration",attempt_ref AS "attemptRef",
  logical_effect_ref AS "logicalEffectRef",maximum_dimensions AS "maximumDimensions",
  maximum_dimensions_digest AS "maximumDimensionsDigest",maximum_amount::text AS "maximumAmount",state,
  provisional_customer_amount::text AS "provisionalCustomerAmount",
  fence_epoch AS "fenceEpoch",owner_evidence_ref AS "ownerEvidenceRef"
 FROM platform.credit_usage_attempt_intent`;

async function insertClosure(
  sql: ReturnType<typeof resolvePlatformTransaction>,
  record: UsageSettlementRecord | UsageReconciliationRecord,
): Promise<void> {
  const closureRef = "receipt" in record ? record.receipt.closureRef : record.closureRef;
  const closureRevision = "receipt" in record ? record.receipt.closureRevision : record.closureRevision;
  await one(sql.execute(
    `INSERT INTO platform.credit_usage_segment_closure
     (closure_ref,site_ref,execution_budget_root_ref,budget_allocation_ref,authorization_segment_ref,
      credit_hold_ref,execution_manifest_ref,closure_revision,correction_of_closure_ref,
      expected_evidence_count,evidence_set_digest,closure_digest,closed_at)
     VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8::bigint,$9::uuid,$10,$11,$12,$13::timestamptz)`,
    [closureRef, record.context.siteId, record.context.executionBudgetRootRef, record.context.budgetAllocationRef,
      record.context.authorizationSegmentRef, record.context.creditHoldRef, record.context.executionManifestRef,
      closureRevision.toString(), record.correctionOfClosureRef, record.evidenceSet.length,
      digest(record.evidenceSet.map((item) => item.evidenceRef).sort().join("\n")), record.closureDigest,
      record.closedAt],
  ), "CREDIT_USAGE_CLOSURE_PERSIST_FAILED");
  for (const [index, evidence] of [...record.evidenceSet]
    .sort((left, right) => left.evidenceRef.localeCompare(right.evidenceRef)).entries()) await one(sql.execute(
    `INSERT INTO platform.credit_usage_closure_evidence
     (closure_ref,site_ref,authorization_segment_ref,evidence_ref,evidence_ordinal)
     VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5)`,
    [closureRef, record.context.siteId, record.context.authorizationSegmentRef, evidence.evidenceRef, index],
  ), "CREDIT_USAGE_CLOSURE_EVIDENCE_PERSIST_FAILED");
}

async function updateSegment(
  sql: ReturnType<typeof resolvePlatformTransaction>,
  context: StoredUsageSettlementContext,
  segment: StoredUsageSettlementContext["segment"],
  observedAt: string,
): Promise<void> {
  await one(sql.execute(
    `UPDATE platform.credit_authorization_segment
        SET state=$1,resolution_kind=$2,resolution_ref=$3,aggregate_version=$4::bigint,
            fence_epoch=$5::bigint,settled_at=$6::timestamptz,updated_at=$7::timestamptz
      WHERE authorization_segment_ref=$8::uuid AND site_ref=$9 AND aggregate_version=$10::bigint`,
    [segment.state, segment.resolutionKind, segment.resolutionRef, segment.aggregateVersion.toString(),
      segment.fenceEpoch.toString(), segment.settledAt, observedAt, context.authorizationSegmentRef,
      context.siteId, (segment.aggregateVersion - 1n).toString()],
  ), "CREDIT_USAGE_SEGMENT_CAS_LOST");
}

async function insertAllocationRevision(
  sql: ReturnType<typeof resolvePlatformTransaction>,
  record: UsageSettlementRecord,
  allocationRevisionRef: string,
): Promise<void> {
  const allocation = record.allocation;
  if (allocation === undefined) return;
  await one(sql.execute(
    `INSERT INTO platform.credit_budget_allocation_revision
     (allocation_revision_ref,budget_allocation_ref,execution_budget_root_ref,site_ref,billing_account_ref,
      credit_account_ref,unit,liability_merchant_account_ref,revision,allocation_epoch,credit_ceiling,
      unassigned_stock,active_child_reserved_stock,committed_stock,captured_cumulative,
      returned_to_parent_cumulative,state)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7,$8,$9::bigint,$10::bigint,$11::numeric,
             $12::numeric,$13::numeric,$14::numeric,$15::numeric,$16::numeric,$17)`,
    [allocationRevisionRef, record.context.budgetAllocationRef, record.context.executionBudgetRootRef,
      record.context.siteId, record.context.billingAccountId, record.context.creditAccountId, record.context.unit,
      record.context.liabilityMerchantAccountId, allocation.revision.toString(), allocation.allocationEpoch.toString(),
      allocation.creditCeiling.toString(), allocation.unassignedStock.toString(),
      allocation.activeChildReservedStock.toString(), allocation.committedStock.toString(),
      allocation.capturedCumulative.toString(), allocation.returnedToParentCumulative.toString(), allocation.state],
  ), "CREDIT_USAGE_ALLOCATION_PERSIST_FAILED");
}

type Posting = Readonly<{ ordinal: number; side: "debit" | "credit"; accountType:
  "customer_reserved" | "customer_consumed" | "adjustment"; amount: bigint; creditGrantId: string }>;

async function insertJournal(
  sql: ReturnType<typeof resolvePlatformTransaction>,
  record: UsageSettlementRecord,
): Promise<void> {
  if (record.journalTransactionRef === undefined) return;
  const correction = record.priorSettlementRef !== undefined;
  const postings: Posting[] = [];
  for (const source of record.sourceMutations) {
    if (source.direction === "capture") {
      postings.push({ ordinal: postings.length, side: "debit", accountType: "customer_reserved",
        amount: source.amount, creditGrantId: source.creditGrantId });
      postings.push({ ordinal: postings.length, side: "credit", accountType: "customer_consumed",
        amount: source.amount, creditGrantId: source.creditGrantId });
    } else {
      const from = source.direction === "increase" ? "customer_reserved" as const : "customer_consumed" as const;
      const to = source.direction === "increase" ? "customer_consumed" as const : "customer_reserved" as const;
      postings.push({ ordinal: postings.length, side: "debit", accountType: from,
        amount: source.amount, creditGrantId: source.creditGrantId });
      postings.push({ ordinal: postings.length, side: "credit", accountType: "adjustment",
        amount: source.amount, creditGrantId: source.creditGrantId });
      postings.push({ ordinal: postings.length, side: "debit", accountType: "adjustment",
        amount: source.amount, creditGrantId: source.creditGrantId });
      postings.push({ ordinal: postings.length, side: "credit", accountType: to,
        amount: source.amount, creditGrantId: source.creditGrantId });
    }
  }
  const entriesDigest = digest(postings.map((entry) => [entry.ordinal, record.context.siteId,
    record.context.creditAccountId.toLowerCase(), record.context.unit, entry.side, entry.accountType,
    entry.amount.toString(), entry.creditGrantId.toLowerCase(), record.context.creditHoldRef.toLowerCase()]
    .join("|")).join("\n"));
  await one(sql.execute(
    `INSERT INTO platform.credit_journal_transaction
     (journal_transaction_ref,credit_account_ref,site_ref,unit,business_operation_key,request_digest,
      operation_kind,expected_entry_count,entries_digest,occurred_at)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,${correction ? "'correction'" : "'hold_capture'"},$7,$8,$9::timestamptz)`,
    [record.journalTransactionRef, record.context.creditAccountId, record.context.siteId, record.context.unit,
      record.identity.businessOperationKey, record.identity.requestDigest, postings.length, entriesDigest,
      record.settledAt],
  ), "CREDIT_USAGE_JOURNAL_PERSIST_FAILED");
  for (const posting of postings) await one(sql.execute(
    `INSERT INTO platform.credit_journal_entry
     (journal_transaction_ref,entry_ordinal,site_ref,credit_account_ref,unit,entry_side,account_type,
      amount,credit_grant_id,credit_hold_ref)
     VALUES ($1::uuid,$2,$3,$4::uuid,$5,$6,$7,$8::numeric,$9::uuid,$10::uuid)`,
    [record.journalTransactionRef, posting.ordinal, record.context.siteId, record.context.creditAccountId,
      record.context.unit, posting.side, posting.accountType, posting.amount.toString(), posting.creditGrantId,
      record.context.creditHoldRef],
  ), "CREDIT_USAGE_JOURNAL_ENTRY_PERSIST_FAILED");
  const holdDelta = record.sourceMutations.reduce((total, source) => total +
    (source.direction === "decrease" ? -source.amount : source.amount), 0n);
  if (holdDelta !== 0n) await one(sql.execute(
    `UPDATE platform.credit_hold
        SET captured_amount=captured_amount+$1::numeric,updated_at=$2::timestamptz
      WHERE credit_hold_ref=$3::uuid AND site_ref=$4 AND state IN ('open','closing','reconciliation_required')
        AND captured_amount+$1::numeric>=0
        AND captured_amount+released_amount+$1::numeric<=reserved_amount`,
    [holdDelta.toString(), record.settledAt, record.context.creditHoldRef, record.context.siteId],
  ), "CREDIT_USAGE_HOLD_CAPTURE_CAS_LOST");
}

async function writeReceipt(
  sql: ReturnType<typeof resolvePlatformTransaction>,
  identity: UsageCommandIdentity,
  value: UsageAttemptReceipt | UsageEvidenceReceipt | UsageSettlementReceipt |
    Readonly<{ authorizationSegmentRef: string; code: string }>,
  receiptRef: string,
  completedAt: string,
  outcomeKind: "accepted" | "reconciliation_required",
): Promise<void> {
  const result = canonical(value);
  await one(sql.execute(
    `INSERT INTO platform.credit_usage_command_receipt
     (receipt_ref,site_ref,operation_kind,business_operation_key,request_digest,outcome_kind,result,
      result_digest,completed_at)
     VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::timestamptz)`,
    [receiptRef, identity.siteId, identity.operationKind, identity.businessOperationKey,
      identity.requestDigest, outcomeKind, result, digest(result), completedAt],
  ), "CREDIT_USAGE_RECEIPT_PERSIST_FAILED");
}

function mapEvidence(row: EvidenceRow): StoredAttemptUsageEvidence {
  if (digest(canonical(row.evidence)) !== row.evidenceDigest) throw new Error("CREDIT_USAGE_EVIDENCE_CORRUPT");
  return Object.freeze({ siteId: row.siteId, attemptAuthorizationRef: row.attemptAuthorizationRef,
    executionBudgetRootRef: row.executionBudgetRootRef,
    budgetAllocationRef: row.budgetAllocationRef, creditHoldRef: row.creditHoldRef,
    creditAccountId: row.creditAccountId, unit: row.unit, evidenceRef: row.evidenceRef,
    businessOperationKey: row.businessOperationKey, requestDigest: row.requestDigest,
    evidence: parseEvidence(row.evidence), evidenceDigest: row.evidenceDigest,
    observedAt: instant(row.observedAt) });
}

function mapAttemptIntent(row: AttemptIntentRow): StoredUsageAttemptIntent {
  if (digest(canonical(row.maximumDimensions)) !== row.maximumDimensionsDigest) {
    throw new Error("CREDIT_USAGE_ATTEMPT_MAXIMUM_CORRUPT");
  }
  return Object.freeze({ siteId: row.siteId, executionBudgetRootRef: row.executionBudgetRootRef,
    budgetAllocationRef: row.budgetAllocationRef, authorizationSegmentRef: row.authorizationSegmentRef,
    creditHoldRef: row.creditHoldRef, creditAccountId: row.creditAccountId, unit: row.unit,
    executionManifestRef: row.executionManifestRef, attemptAuthorizationRef: row.attemptAuthorizationRef,
    producerKind: enumValue(row.producerKind, ["model_gateway", "capability_runtime", "media"] as const),
    producerContext: row.producerContext, producerGeneration: BigInt(row.producerGeneration),
    attemptRef: row.attemptRef, logicalEffectRef: row.logicalEffectRef,
    maximumDimensions: parseUsageDimensions(row.maximumDimensions),
    maximumDimensionsDigest: row.maximumDimensionsDigest, maximumAmount: BigInt(row.maximumAmount),
    provisionalCustomerAmount: row.provisionalCustomerAmount === null ? null : BigInt(row.provisionalCustomerAmount),
    state: enumValue(row.state, ["effect_committed", "outcome_unknown", "finalized"] as const),
    fenceEpoch: BigInt(row.fenceEpoch), ownerEvidenceRef: row.ownerEvidenceRef });
}

function parseUsageDimensions(value: unknown): StoredUsageAttemptIntent["maximumDimensions"] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw new Error("CREDIT_USAGE_ATTEMPT_MAXIMUM_CORRUPT");
  }
  return Object.freeze(value.map((dimension) => {
    if (!isObject(dimension)) throw new Error("CREDIT_USAGE_ATTEMPT_MAXIMUM_CORRUPT");
    return Object.freeze({ dimensionKey: stringValue(dimension.dimensionKey),
      sourceUnit: stringValue(dimension.sourceUnit), quantity: BigInt(stringValue(dimension.quantity)) });
  }));
}

function parseRatingPolicy(value: unknown): RatingPolicyRevision {
  const parsed = ratingPolicySchema.parse(value);
  return Object.freeze({ ...parsed, minimumAmount: BigInt(parsed.minimumAmount),
    chargeableAttemptOutcomes: Object.freeze(parsed.chargeableAttemptOutcomes),
    rules: Object.freeze(parsed.rules.map((rule) => Object.freeze({ ...rule,
      quantum: BigInt(rule.quantum), amountPerQuantum: BigInt(rule.amountPerQuantum) }))) });
}

function parseEvidence(value: unknown): AttemptUsageEvidence {
  if (!isObject(value)) throw new Error("CREDIT_USAGE_EVIDENCE_CORRUPT");
  const base = {
    producerKind: enumValue(value.producerKind, ["model_gateway", "capability_runtime", "media"] as const),
    producerContext: stringValue(value.producerContext), producerGeneration: BigInt(stringValue(value.producerGeneration)),
    attemptRef: stringValue(value.attemptRef), logicalEffectRef: stringValue(value.logicalEffectRef),
    authorizationSegmentRef: stringValue(value.authorizationSegmentRef),
    executionManifestRef: stringValue(value.executionManifestRef), revision: BigInt(stringValue(value.revision)),
    correctionOfEvidenceRef: value.correctionOfEvidenceRef === null ? null : stringValue(value.correctionOfEvidenceRef),
    attemptOutcome: enumValue(value.attemptOutcome, ["succeeded", "failed_before_effect", "failed_after_effect",
      "canceled_before_effect", "canceled_after_effect"] as const),
    occurredAt: stringValue(value.occurredAt), sourceDigest: stringValue(value.sourceDigest),
  };
  if (value.evidenceKind === "measured" && Array.isArray(value.dimensions)) return Object.freeze({ ...base,
    evidenceKind: "measured", dimensions: Object.freeze(value.dimensions.map((dimension) => {
      if (!isObject(dimension)) throw new Error("CREDIT_USAGE_EVIDENCE_CORRUPT");
      return Object.freeze({ dimensionKey: stringValue(dimension.dimensionKey),
        sourceUnit: stringValue(dimension.sourceUnit), quantity: BigInt(stringValue(dimension.quantity)) });
    })) });
  if (value.evidenceKind === "zero" && Array.isArray(value.dimensions) && value.dimensions.length === 0) return Object.freeze({
    ...base, evidenceKind: "zero", zeroReason: enumValue(value.zeroReason,
      ["definitely_not_submitted", "provider_reported_zero"] as const),
    dimensions: Object.freeze([]) as readonly [] });
  if (value.evidenceKind === "unavailable" && Array.isArray(value.dimensions) && value.dimensions.length === 0) return Object.freeze({
    ...base, evidenceKind: "unavailable", unavailableReason: enumValue(value.unavailableReason,
      ["provider_usage_missing", "provider_usage_ambiguous", "producer_integrity_failure"] as const),
    dimensions: Object.freeze([]) as readonly [] });
  throw new Error("CREDIT_USAGE_EVIDENCE_CORRUPT");
}

function parseReceipt(value: unknown): UsageAttemptReceipt | UsageEvidenceReceipt | UsageSettlementReceipt {
  if (!isObject(value)) throw new Error("CREDIT_USAGE_RECEIPT_CORRUPT");
  if (typeof value.attemptAuthorizationRef === "string" &&
      (value.state === "effect_committed" || value.state === "outcome_unknown") &&
      typeof value.fenceEpoch === "string") {
    return Object.freeze({ attemptAuthorizationRef: value.attemptAuthorizationRef,
      state: value.state, fenceEpoch: BigInt(value.fenceEpoch) });
  }
  if (typeof value.evidenceRef === "string" && typeof value.revision === "string") {
    return Object.freeze({ evidenceRef: value.evidenceRef, revision: BigInt(value.revision) });
  }
  if (typeof value.settlementRef === "string" && typeof value.authorizationSegmentRef === "string" &&
      typeof value.closureRef === "string" && typeof value.closureRevision === "string" && value.state === "settled" &&
      typeof value.customerAmount === "string" && typeof value.platformExposureAmount === "string") {
    return Object.freeze({ settlementRef: value.settlementRef, authorizationSegmentRef: value.authorizationSegmentRef,
      closureRef: value.closureRef, closureRevision: BigInt(value.closureRevision), state: "settled",
      customerAmount: BigInt(value.customerAmount), platformExposureAmount: BigInt(value.platformExposureAmount) });
  }
  throw new Error("CREDIT_USAGE_RECEIPT_CORRUPT");
}

function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
async function one(change: Promise<number>, code: string): Promise<void> { if (await change !== 1) throw new Error(code); }
function only<Row>(rows: readonly Row[], code: string): Row | undefined { if (rows.length > 1) throw new Error(code); return rows[0]; }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function stringValue(value: unknown): string { if (typeof value !== "string") throw new Error("CREDIT_USAGE_VALUE_INVALID"); return value; }
function enumValue<const Values extends readonly string[]>(value: unknown, values: Values): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new Error("CREDIT_USAGE_VALUE_INVALID");
  return value as Values[number];
}
function instant(value: Date | string): string {
  const result = value instanceof Date ? value.toISOString() : value;
  if (!Number.isFinite(Date.parse(result))) throw new Error("CREDIT_USAGE_INSTANT_INVALID");
  return result;
}
