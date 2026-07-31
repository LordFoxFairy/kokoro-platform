import { createHash, randomUUID } from "node:crypto";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import type {
  CreditAuthorityRepository,
  CreditOperationValue,
  CreditOperationIdentity,
  CreditOperationReceiptLookup,
  CreditReferenceKind,
  CreditRepositoryWriteOutcome,
  MediaChildAllocationReservationRecord,
  MediaChildAllocationReturnRecord,
  RootBudgetReservationRecord,
  StoredSegmentAllocation,
} from "../../application/contracts/credit-authority-repository.js";
import type {
  DerivedMediaChildAllocation,
  ReservedRunBudget,
  ReturnedMediaChildAllocation,
  SegmentMutationResult,
} from "../../application/contracts/run-budget-authority.js";
import {
  rehydrateBudgetAllocationRevision,
  type BudgetAllocationRevision,
} from "../../domain/allocation.js";
import {
  parseDerivedMediaChildReceipt,
  parseReturnedMediaChildReceipt,
} from "../../application/media-child-receipt-codec.js";
import { lockCreditAccountAuthority } from "./credit-account-lock.js";
import { lockCreditFinancialAuthority } from "./credit-financial-lock.js";
import {
  mapMediaChildAllocationRow,
  mapParentAllocationRow,
} from "./media-child-allocation-row.js";
import {
  MEDIA_CHILD_ALLOCATION_FRESH_LOAD_SQL,
  PARENT_ALLOCATION_FRESH_LOAD_SQL,
} from "./media-child-allocation-sql.js";

type ReceiptRow = Record<string, unknown>;

type GrantRow = Record<string, unknown> & {
  creditGrantId: string;
  availableAmount: string;
  expiresAt: Date | string | null;
  burnPriority: number;
  issuedAt: Date | string;
};

type SegmentRow = Record<string, unknown> & {
  siteId: string;
  billingAccountId: string;
  creditAccountId: string;
  unit: string;
  liabilityMerchantAccountId: string;
  ratingPolicyRevisionRef: string;
  executionBudgetRootRef: string;
  executionBudgetRootState: StoredSegmentAllocation["executionBudgetRootState"];
  executionBudgetRootVersion: bigint | string;
  creditHoldRef: string;
  creditHoldState: StoredSegmentAllocation["creditHoldState"];
  creditHoldFenceEpoch: bigint | string;
  budgetAllocationRef: string;
  authorizationSegmentRef: string;
  executionManifestRef: string;
  surfaceRef: string;
  capabilityKey: string;
  agentRef: string | null;
  expiresAt: Date | string;
  revision: bigint | string;
  allocationEpoch: bigint | string;
  creditCeiling: string;
  unassignedStock: string;
  activeChildReservedStock: string;
  committedStock: string;
  capturedCumulative: string;
  returnedToParentCumulative: string;
  allocationState: StoredSegmentAllocation["allocation"]["state"];
  segmentState: StoredSegmentAllocation["segment"]["state"];
  maximumAmount: string;
  segmentAllocationEpoch: bigint | string;
  preparedAgainstAllocationRevision: bigint | string;
  committedFromAllocationRevision: bigint | string | null;
  committedToAllocationRevision: bigint | string | null;
  aggregateVersion: bigint | string;
  fenceEpoch: bigint | string;
  resolutionKind: StoredSegmentAllocation["segment"]["resolutionKind"];
  resolutionRef: string | null;
  committedAt: Date | string | null;
  settledAt: Date | string | null;
  releasedAt: Date | string | null;
};

type ParentAllocationRow = Record<string, unknown>;
type MediaChildAllocationRow = Record<string, unknown>;

export class PostgresCreditAuthorityRepository implements CreditAuthorityRepository {
  readonly #reference: (kind: CreditReferenceKind) => string;

  constructor(options: Readonly<{
    reference?: (kind: CreditReferenceKind) => string;
  }> = {}) {
    this.#reference = options.reference ?? (() => randomUUID());
  }

  async findOperationReceipt(
    transaction: Parameters<CreditAuthorityRepository["findOperationReceipt"]>[0],
    identity: CreditOperationIdentity,
  ): Promise<CreditOperationReceiptLookup> {
    const sql = resolvePlatformTransaction(transaction);
    await sql.query<Record<string, unknown>>(
      `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,0))`,
      [`credit-operation|${identity.siteId}|${identity.operationKind}|${identity.businessOperationKey}`],
    );
    const rows = await sql.query<ReceiptRow>(
      `SELECT request_digest AS "requestDigest",outcome_kind AS "outcomeKind",result,
              result_digest AS "resultDigest",execution_budget_root_ref AS "executionBudgetRootRef",
              authorization_segment_ref AS "authorizationSegmentRef",
              parent_allocation_ref AS "parentAllocationRef",child_allocation_ref AS "childAllocationRef",
              parent_before_revision::text AS "parentBeforeRevision",
              parent_after_revision::text AS "parentAfterRevision",
              child_before_revision::text AS "childBeforeRevision",
              child_after_revision::text AS "childAfterRevision",credit_amount::text AS "creditAmount",
              owner_closure_evidence_ref AS "ownerClosureEvidenceRef"
       FROM platform.credit_budget_operation_receipt
       WHERE site_ref=$1 AND operation_kind=$2 AND business_operation_key=$3
       FOR UPDATE`,
      [identity.siteId, identity.operationKind, identity.businessOperationKey],
    );
    const row = rows[0];
    if (row === undefined) return { kind: "none" };
    if (rows.length !== 1) throw new Error("CREDIT_OPERATION_RECEIPT_AMBIGUOUS");
    const requestDigest = stringField(row, "requestDigest", "CREDIT_OPERATION_RECEIPT_CORRUPT");
    const outcomeKind = stringField(row, "outcomeKind", "CREDIT_OPERATION_RECEIPT_CORRUPT");
    const result = ownField(row, "result", "CREDIT_OPERATION_RECEIPT_CORRUPT");
    const resultDigest = stringField(row, "resultDigest", "CREDIT_OPERATION_RECEIPT_CORRUPT");
    if (requestDigest !== identity.requestDigest) {
      return { kind: "conflict", code: "REQUEST_DIGEST_CONFLICT" };
    }
    if (!DIGEST.test(resultDigest) || digest(canonicalJson(result)) !== resultDigest) {
      throw new Error("CREDIT_OPERATION_RECEIPT_DIGEST_MISMATCH");
    }
    const value = parseOperationResult(result, identity);
    validateOperationReceiptScope(row, identity, value);
    if (outcomeKind !== "accepted" && outcomeKind !== "reconciliation_required") {
      throw new Error("CREDIT_OPERATION_RECEIPT_OUTCOME_MISMATCH");
    }
    if ((outcomeKind === "reconciliation_required") !== (value.state === "reconciliation_required")) {
      throw new Error("CREDIT_OPERATION_RECEIPT_OUTCOME_MISMATCH");
    }
    return { kind: "replayed", value };
  }

  async lockGrantAvailability(
    transaction: Parameters<CreditAuthorityRepository["lockGrantAvailability"]>[0],
    input: Parameters<CreditAuthorityRepository["lockGrantAvailability"]>[1],
  ): ReturnType<CreditAuthorityRepository["lockGrantAvailability"]> {
    const sql = resolvePlatformTransaction(transaction);
    const account = await lockCreditAccountAuthority(transaction, input);
    if (account === null || account.state !== "active" || account.creditAccountId !== input.creditAccountId) return [];
    const rows = await sql.query<GrantRow>(
      `SELECT grant_fact.credit_grant_id AS "creditGrantId",
              balance.available_amount::text AS "availableAmount",
              grant_fact.expires_at AS "expiresAt",grant_fact.burn_priority AS "burnPriority",
              grant_fact.issued_at AS "issuedAt"
       FROM platform.credit_grant grant_fact
       CROSS JOIN LATERAL (
         SELECT COALESCE(sum(CASE entry.entry_side WHEN 'credit' THEN entry.amount ELSE -entry.amount END),0)
                  AS available_amount
         FROM platform.credit_journal_entry entry
         WHERE entry.credit_grant_id=grant_fact.credit_grant_id
           AND entry.account_type='customer_available'
       ) balance
       WHERE grant_fact.site_ref=$1 AND grant_fact.credit_account_ref=$2::uuid AND grant_fact.unit=$3
         AND grant_fact.effective_at<=$4::timestamptz
         AND (grant_fact.expires_at IS NULL OR grant_fact.expires_at>$4::timestamptz)
         AND platform.valid_credit_scope_policy(grant_fact.scope_policy)
         AND grant_fact.scope_policy->'surfaceRefs' ? $5
         AND grant_fact.scope_policy->'capabilityKeys' ? $6
         AND (($7::text IS NULL AND grant_fact.scope_policy->>'allowUnattributedAgent'='true')
           OR ($7::text IS NOT NULL AND grant_fact.scope_policy->'agentRefs' ? $7))
         AND balance.available_amount>0
       ORDER BY grant_fact.expires_at ASC NULLS LAST,grant_fact.burn_priority ASC,
                grant_fact.issued_at ASC,grant_fact.credit_grant_id ASC
       FOR UPDATE OF grant_fact`,
      [input.siteId, input.creditAccountId, input.unit, input.effectiveAt,
        input.consumptionScope.surfaceRef, input.consumptionScope.capabilityKey,
        input.consumptionScope.agentRef],
    );
    return Object.freeze(rows.map((row) => Object.freeze({
      creditGrantId: row.creditGrantId,
      availableAmount: BigInt(row.availableAmount),
      expiresAt: nullableInstant(row.expiresAt),
      burnPriority: row.burnPriority,
      issuedAt: instant(row.issuedAt),
    })));
  }

  async createRootBudgetReservation(
    transaction: Parameters<CreditAuthorityRepository["createRootBudgetReservation"]>[0],
    record: RootBudgetReservationRecord,
  ): Promise<CreditRepositoryWriteOutcome<ReservedRunBudget>> {
    const operation = operationIdentity("reserve_root", record);
    const prior = await this.findOperationReceipt(transaction, operation);
    if (prior.kind === "conflict") return prior;
    if (prior.kind === "replayed") {
      if (prior.value.state !== "reserved") throw new Error("CREDIT_OPERATION_RECEIPT_CORRUPT");
      return prior as Readonly<{ kind: "replayed"; value: ReservedRunBudget }>;
    }
    const sql = resolvePlatformTransaction(transaction);
    await exactlyOne(sql.execute(
      `INSERT INTO platform.credit_hold
       (credit_hold_ref,credit_account_ref,site_ref,execution_root_ref,unit,requested_amount,reserved_amount,
        state,expires_at,created_at,updated_at)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::numeric,$6::numeric,'open',$7::timestamptz,$8::timestamptz,$8::timestamptz)`,
      [record.creditHoldRef, record.creditAccountId, record.siteId, record.executionRootId, record.unit,
        record.rootCeiling.toString(), record.expiresAt, record.occurredAt],
    ), "CREDIT_HOLD_PERSIST_FAILED");
    const entries = reserveEntries(record);
    await exactlyOne(sql.execute(
      `INSERT INTO platform.credit_journal_transaction
       (journal_transaction_ref,credit_account_ref,site_ref,unit,business_operation_key,request_digest,
        operation_kind,expected_entry_count,entries_digest,occurred_at)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,'hold_reserve',$7,$8,$9::timestamptz)`,
      [record.reserveJournalTransactionRef, record.creditAccountId, record.siteId, record.unit,
        record.businessOperationKey, record.requestDigest, entries.length, journalEntriesDigest(record, entries), record.occurredAt],
    ), "CREDIT_RESERVE_JOURNAL_PERSIST_FAILED");
    for (const allocation of record.allocations) {
      await exactlyOne(sql.execute(
        `INSERT INTO platform.credit_hold_allocation
         (credit_hold_ref,credit_grant_id,site_ref,credit_account_ref,unit,reserve_journal_transaction_ref,
          allocated_amount,allocation_ordinal)
         VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5,$6::uuid,$7::numeric,$8)`,
        [record.creditHoldRef, allocation.creditGrantId, record.siteId, record.creditAccountId, record.unit,
          record.reserveJournalTransactionRef, allocation.amount.toString(), allocation.ordinal],
      ), "CREDIT_HOLD_ALLOCATION_PERSIST_FAILED");
    }
    for (const entry of entries) {
      await exactlyOne(sql.execute(
        `INSERT INTO platform.credit_journal_entry
         (journal_transaction_ref,entry_ordinal,site_ref,credit_account_ref,unit,entry_side,account_type,
          amount,credit_grant_id,credit_hold_ref)
         VALUES ($1::uuid,$2,$3,$4::uuid,$5,$6,$7,$8::numeric,$9::uuid,$10::uuid)`,
        [record.reserveJournalTransactionRef, entry.ordinal, record.siteId, record.creditAccountId, record.unit,
          entry.side, entry.accountType, entry.amount.toString(), entry.creditGrantId, record.creditHoldRef],
      ), "CREDIT_JOURNAL_ENTRY_PERSIST_FAILED");
    }
    await exactlyOne(sql.execute(
      `INSERT INTO platform.credit_execution_budget_root
       (execution_budget_root_ref,site_ref,execution_root_ref,billing_account_ref,credit_account_ref,unit,
        liability_merchant_account_ref,credit_hold_ref,root_allocation_ref,authorization_budget_ref,
        rating_policy_revision_ref,surface_ref,capability_key,agent_ref,reserved_ceiling,state,created_at,updated_at)
       VALUES ($1::uuid,$2,$3,$4,$5::uuid,$6,$7,$8::uuid,$9::uuid,$10,$11,$12,$13,$14,$15::numeric,'open',
               $16::timestamptz,$16::timestamptz)`,
      [record.executionBudgetRootRef, record.siteId, record.executionRootId, record.billingAccountId,
        record.creditAccountId, record.unit, record.liabilityMerchantAccountId, record.creditHoldRef,
        record.rootAllocationRef, record.authorizationBudgetRef, record.ratingPolicyRevisionRef,
        record.consumptionScope.surfaceRef, record.consumptionScope.capabilityKey,
        record.consumptionScope.agentRef, record.rootCeiling.toString(), record.occurredAt],
    ), "CREDIT_BUDGET_ROOT_PERSIST_FAILED");
    await exactlyOne(sql.execute(
      `INSERT INTO platform.credit_budget_allocation
       (budget_allocation_ref,execution_budget_root_ref,site_ref,billing_account_ref,credit_account_ref,unit,
        liability_merchant_account_ref,parent_allocation_ref,is_root,audience,purpose)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5::uuid,$6,$7,NULL,TRUE,'root','execution_root')`,
      [record.rootAllocationRef, record.executionBudgetRootRef, record.siteId, record.billingAccountId,
        record.creditAccountId, record.unit, record.liabilityMerchantAccountId],
    ), "CREDIT_ROOT_ALLOCATION_PERSIST_FAILED");
    await exactlyOne(sql.execute(
      `INSERT INTO platform.credit_budget_allocation_revision
       (allocation_revision_ref,budget_allocation_ref,execution_budget_root_ref,site_ref,billing_account_ref,
        credit_account_ref,unit,liability_merchant_account_ref,revision,allocation_epoch,credit_ceiling,
        unassigned_stock,active_child_reserved_stock,committed_stock,captured_cumulative,
        returned_to_parent_cumulative,state)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7,$8,1,1,$9::numeric,$9::numeric,0,0,0,0,'active')`,
      [record.initialAllocationRevisionRef, record.rootAllocationRef, record.executionBudgetRootRef,
        record.siteId, record.billingAccountId, record.creditAccountId, record.unit,
        record.liabilityMerchantAccountId, record.rootCeiling.toString()],
    ), "CREDIT_ROOT_ALLOCATION_REVISION_PERSIST_FAILED");
    await exactlyOne(sql.execute(
      `INSERT INTO platform.credit_authorization_segment
       (authorization_segment_ref,site_ref,execution_budget_root_ref,budget_allocation_ref,credit_hold_ref,
        billing_account_ref,credit_account_ref,unit,liability_merchant_account_ref,execution_manifest_ref,
        rating_policy_revision_ref,business_operation_key,request_digest,maximum_amount,allocation_epoch,
        prepared_against_allocation_revision,state,expires_at,created_at,updated_at)
       VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid,$6,$7::uuid,$8,$9,$10,$11,$12,$13,$14::numeric,
               1,1,'reserved',$15::timestamptz,$16::timestamptz,$16::timestamptz)`,
      [record.authorizationSegmentRef, record.siteId, record.executionBudgetRootRef, record.rootAllocationRef,
        record.creditHoldRef, record.billingAccountId, record.creditAccountId, record.unit,
        record.liabilityMerchantAccountId, record.executionManifestRef, record.ratingPolicyRevisionRef,
        record.businessOperationKey, record.requestDigest, record.segmentMaximum.toString(), record.expiresAt,
        record.occurredAt],
    ), "CREDIT_AUTHORIZATION_SEGMENT_PERSIST_FAILED");
    const value: ReservedRunBudget = Object.freeze({
      executionBudgetRootRef: record.executionBudgetRootRef,
      creditHoldRef: record.creditHoldRef,
      rootAllocationRef: record.rootAllocationRef,
      rootAllocationRevision: 1n,
      rootAllocationEpoch: 1n,
      authorizationSegmentRef: record.authorizationSegmentRef,
      segmentVersion: 1n,
      state: "reserved",
      expiresAt: record.expiresAt,
    });
    await this.#writeEvidence(transaction, record.operationReceiptRef, record.outboxEventRef, operation,
      value, "accepted", record.executionBudgetRootRef, record.authorizationSegmentRef, record.occurredAt);
    return { kind: "accepted", value };
  }

  async lockSegmentAllocation(
    transaction: Parameters<CreditAuthorityRepository["lockSegmentAllocation"]>[0],
    input: Parameters<CreditAuthorityRepository["lockSegmentAllocation"]>[1],
  ): ReturnType<CreditAuthorityRepository["lockSegmentAllocation"]> {
    const sql = resolvePlatformTransaction(transaction);
    const lineage = await sql.query<Record<string, unknown>>(SEGMENT_LINEAGE_SQL, [
      input.siteId, input.authorizationSegmentRef,
    ]);
    if (lineage.length === 0) return null;
    if (lineage.length !== 1) throw new Error("CREDIT_SEGMENT_AMBIGUOUS");
    const lineageRow = lineage[0];
    if (lineageRow === undefined) return null;
    const executionBudgetRootRef = stringField(lineageRow, "executionBudgetRootRef", "CREDIT_SEGMENT_LINEAGE_CORRUPT");
    const budgetAllocationRef = stringField(lineageRow, "budgetAllocationRef", "CREDIT_SEGMENT_LINEAGE_CORRUPT");
    const creditHoldRef = stringField(lineageRow, "creditHoldRef", "CREDIT_SEGMENT_LINEAGE_CORRUPT");
    if (await lockCreditFinancialAuthority(transaction, {
      siteId: input.siteId,
      executionBudgetRootRef,
      allocationRefs: [budgetAllocationRef],
      expectedCreditHoldRef: creditHoldRef,
    }) === null) return null;
    const rows = await sql.query<SegmentRow>(SEGMENT_FRESH_LOAD_SQL, [input.siteId, input.authorizationSegmentRef]);
    const row = rows[0];
    if (row === undefined) return null;
    if (rows.length !== 1) throw new Error("CREDIT_SEGMENT_AMBIGUOUS");
    return mapSegment(row);
  }

  async commitAuthorizationSegment(
    transaction: Parameters<CreditAuthorityRepository["commitAuthorizationSegment"]>[0],
    record: StoredSegmentAllocation,
    operation: CreditOperationIdentity,
    observedAt: string,
  ): Promise<CreditRepositoryWriteOutcome<SegmentMutationResult>> {
    const prior = await this.#mutationPrior(transaction, operation);
    if (prior !== null) return prior;
    const sql = resolvePlatformTransaction(transaction);
    await exactlyOne(sql.execute(
      `INSERT INTO platform.credit_budget_allocation_revision
       (allocation_revision_ref,budget_allocation_ref,execution_budget_root_ref,site_ref,billing_account_ref,
        credit_account_ref,unit,liability_merchant_account_ref,revision,allocation_epoch,credit_ceiling,
        unassigned_stock,active_child_reserved_stock,committed_stock,captured_cumulative,
        returned_to_parent_cumulative,state)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7,$8,$9::bigint,$10::bigint,$11::numeric,
               $12::numeric,$13::numeric,$14::numeric,$15::numeric,$16::numeric,$17)`,
      [this.#reference("allocation-revision"), record.budgetAllocationRef, record.executionBudgetRootRef,
        record.siteId, record.billingAccountId, record.creditAccountId, record.unit,
        record.liabilityMerchantAccountId, record.allocation.revision.toString(),
        record.allocation.allocationEpoch.toString(), record.allocation.creditCeiling.toString(),
        record.allocation.unassignedStock.toString(), record.allocation.activeChildReservedStock.toString(),
        record.allocation.committedStock.toString(), record.allocation.capturedCumulative.toString(),
        record.allocation.returnedToParentCumulative.toString(), record.allocation.state],
    ), "CREDIT_ALLOCATION_COMMIT_PERSIST_FAILED");
    await this.#updateSegment(transaction, record, observedAt);
    const value = segmentResult(record, observedAt);
    await this.#writeEvidence(transaction, this.#reference("operation-receipt"), this.#reference("outbox-event"),
      operation, value, "accepted", record.executionBudgetRootRef, record.authorizationSegmentRef, observedAt);
    return { kind: "accepted", value };
  }

  async releaseAuthorizationSegment(
    transaction: Parameters<CreditAuthorityRepository["releaseAuthorizationSegment"]>[0],
    record: StoredSegmentAllocation,
    operation: CreditOperationIdentity,
    observedAt: string,
  ): Promise<CreditRepositoryWriteOutcome<SegmentMutationResult>> {
    const prior = await this.#mutationPrior(transaction, operation);
    if (prior !== null) return prior;
    await this.#updateSegment(transaction, record, observedAt);
    const value = segmentResult(record, observedAt);
    await this.#writeEvidence(transaction, this.#reference("operation-receipt"), this.#reference("outbox-event"),
      operation, value, "accepted", record.executionBudgetRootRef, record.authorizationSegmentRef, observedAt);
    return { kind: "accepted", value };
  }

  async markAuthorizationSegmentReconciliationRequired(
    transaction: Parameters<CreditAuthorityRepository["markAuthorizationSegmentReconciliationRequired"]>[0],
    record: StoredSegmentAllocation,
    operation: CreditOperationIdentity,
    observedAt: string,
  ): ReturnType<CreditAuthorityRepository["markAuthorizationSegmentReconciliationRequired"]> {
    const prior = await this.#mutationPrior(transaction, operation);
    if (prior !== null) return prior;
    await this.#updateSegment(transaction, record, observedAt);
    const sql = resolvePlatformTransaction(transaction);
    if (record.executionBudgetRootState !== "reconciliation_required") await exactlyOne(sql.execute(
      `UPDATE platform.credit_execution_budget_root
       SET state='reconciliation_required',aggregate_version=aggregate_version+1,updated_at=$3::timestamptz
       WHERE execution_budget_root_ref=$1::uuid AND site_ref=$2 AND state=$4
         AND aggregate_version=$5::bigint`,
      [record.executionBudgetRootRef, record.siteId, observedAt, record.executionBudgetRootState,
        record.executionBudgetRootVersion.toString()],
    ), "CREDIT_ROOT_RECONCILIATION_CAS_LOST");
    if (record.creditHoldState !== "reconciliation_required") await exactlyOne(sql.execute(
      `UPDATE platform.credit_hold
       SET state='reconciliation_required',fence_epoch=fence_epoch+1,updated_at=$3::timestamptz
       WHERE credit_hold_ref=$1::uuid AND site_ref=$2 AND state=$4 AND fence_epoch=$5::bigint`,
      [record.creditHoldRef, record.siteId, observedAt, record.creditHoldState,
        record.creditHoldFenceEpoch.toString()],
    ), "CREDIT_HOLD_RECONCILIATION_CAS_LOST");
    const value = segmentResult(record, observedAt);
    await this.#writeEvidence(transaction, this.#reference("operation-receipt"), this.#reference("outbox-event"),
      operation, value, "reconciliation_required", record.executionBudgetRootRef,
      record.authorizationSegmentRef, observedAt);
    return { kind: "reconciliation_required", value };
  }

  async lockParentAllocation(
    transaction: Parameters<CreditAuthorityRepository["lockParentAllocation"]>[0],
    input: Parameters<CreditAuthorityRepository["lockParentAllocation"]>[1],
  ): ReturnType<CreditAuthorityRepository["lockParentAllocation"]> {
    const sql = resolvePlatformTransaction(transaction);
    if (await lockCreditFinancialAuthority(transaction, {
      siteId: input.siteId,
      executionBudgetRootRef: input.executionBudgetRootRef,
      allocationRefs: [input.parentAllocationRef],
    }) === null) return null;
    const rows = await sql.query<ParentAllocationRow>(PARENT_ALLOCATION_FRESH_LOAD_SQL, [
      input.siteId, input.executionBudgetRootRef, input.parentAllocationRef,
    ]);
    const row = rows[0];
    if (row === undefined) return null;
    if (rows.length !== 1) throw new Error("CREDIT_PARENT_ALLOCATION_AMBIGUOUS");
    return mapParentAllocationRow(row);
  }

  async createMediaChildAllocation(
    transaction: Parameters<CreditAuthorityRepository["createMediaChildAllocation"]>[0],
    record: MediaChildAllocationReservationRecord,
  ): Promise<CreditRepositoryWriteOutcome<DerivedMediaChildAllocation>> {
    const prior = await this.findOperationReceipt(transaction, record.operation);
    if (prior.kind === "conflict") return prior;
    if (prior.kind === "replayed") {
      if (prior.value.state !== "active") throw new Error("CREDIT_OPERATION_RECEIPT_CORRUPT");
      return { kind: "replayed", value: prior.value };
    }
    const sql = resolvePlatformTransaction(transaction);
    await this.#insertAllocationRevision(transaction, {
      allocationRevisionRef: record.parentAllocationRevisionRef,
      budgetAllocationRef: record.parentAllocationRef,
      executionBudgetRootRef: record.executionBudgetRootRef,
      siteId: record.siteId,
      billingAccountId: record.parent.billingAccountId,
      creditAccountId: record.parent.creditAccountId,
      unit: record.parent.unit,
      liabilityMerchantAccountId: record.parent.liabilityMerchantAccountId,
    }, record.parentAllocation, null, null);
    await exactlyOne(sql.execute(
      `INSERT INTO platform.credit_budget_allocation
       (budget_allocation_ref,execution_budget_root_ref,site_ref,billing_account_ref,credit_account_ref,unit,
        liability_merchant_account_ref,parent_allocation_ref,is_root,audience,purpose,surface_ref,
        capability_key,operation_ref,agent_ref,expires_at)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5::uuid,$6,$7,$8::uuid,FALSE,'media','media_operation',
               $9,$10,$11,$12,$13::timestamptz)`,
      [record.childAllocationRef, record.executionBudgetRootRef, record.siteId,
        record.parent.billingAccountId, record.parent.creditAccountId, record.parent.unit,
        record.parent.liabilityMerchantAccountId, record.parentAllocationRef,
        record.consumptionScope.surfaceRef, record.consumptionScope.capabilityKey,
        record.mediaOperationRef, record.consumptionScope.agentRef, record.expiresAt],
    ), "CREDIT_MEDIA_CHILD_ALLOCATION_PERSIST_FAILED");
    await this.#insertAllocationRevision(transaction, {
      allocationRevisionRef: record.childAllocationRevisionRef,
      budgetAllocationRef: record.childAllocationRef,
      executionBudgetRootRef: record.executionBudgetRootRef,
      siteId: record.siteId,
      billingAccountId: record.parent.billingAccountId,
      creditAccountId: record.parent.creditAccountId,
      unit: record.parent.unit,
      liabilityMerchantAccountId: record.parent.liabilityMerchantAccountId,
    }, record.childAllocation, record.childAllocation.terminalReceiptDigest,
    record.childAllocation.parentAppliedRevision);
    await exactlyOne(sql.execute(
      `INSERT INTO platform.credit_allocation_reservation_receipt
       (allocation_reservation_receipt_ref,site_ref,execution_budget_root_ref,parent_allocation_ref,
        child_allocation_ref,business_operation_key,request_digest,reserved_ceiling,
        parent_expected_revision,parent_resulting_revision,child_initial_revision,receipt_digest,
        parent_expected_epoch,child_initial_epoch,media_operation_ref,audience,purpose,surface_ref,
        capability_key,agent_ref,expires_at,created_at)
       VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8::numeric,$9::bigint,$10::bigint,
               $11::bigint,$12,$13::bigint,$14::bigint,$15,'media','media_operation',$16,$17,$18,
               $19::timestamptz,$20::timestamptz)`,
      [record.receipt.allocationReservationReceiptRef, record.siteId,
        record.executionBudgetRootRef, record.parentAllocationRef, record.childAllocationRef,
        record.operation.businessOperationKey, record.operation.requestDigest,
        record.receipt.reservedCeiling.toString(), record.receipt.parentRevisionBefore.toString(),
        record.receipt.parentRevisionAfter.toString(), record.receipt.childRevisionAfter.toString(),
        record.receipt.receiptDigest, record.receipt.parentAllocationEpoch.toString(),
        record.receipt.childAllocationEpoch.toString(), record.mediaOperationRef,
        record.consumptionScope.surfaceRef, record.consumptionScope.capabilityKey,
        record.consumptionScope.agentRef, record.expiresAt, record.occurredAt],
    ), "CREDIT_MEDIA_CHILD_RESERVATION_RECEIPT_PERSIST_FAILED");
    await this.#writeChildEvidence(transaction, record.operationReceiptRef,
      record.operation, record.receipt, null, record.occurredAt);
    return { kind: "accepted", value: record.receipt };
  }

  async lockMediaChildAllocation(
    transaction: Parameters<CreditAuthorityRepository["lockMediaChildAllocation"]>[0],
    input: Parameters<CreditAuthorityRepository["lockMediaChildAllocation"]>[1],
  ): ReturnType<CreditAuthorityRepository["lockMediaChildAllocation"]> {
    const sql = resolvePlatformTransaction(transaction);
    if (await lockCreditFinancialAuthority(transaction, {
      siteId: input.siteId,
      executionBudgetRootRef: input.executionBudgetRootRef,
      allocationRefs: [input.parentAllocationRef, input.childAllocationRef],
    }) === null) return null;
    const rows = await sql.query<MediaChildAllocationRow>(MEDIA_CHILD_ALLOCATION_FRESH_LOAD_SQL, [
      input.siteId, input.executionBudgetRootRef, input.parentAllocationRef, input.childAllocationRef,
    ]);
    const row = rows[0];
    if (row === undefined) return null;
    if (rows.length !== 1) throw new Error("CREDIT_MEDIA_CHILD_ALLOCATION_AMBIGUOUS");
    return mapMediaChildAllocationRow(row);
  }

  async closeMediaChildAllocation(
    transaction: Parameters<CreditAuthorityRepository["closeMediaChildAllocation"]>[0],
    record: MediaChildAllocationReturnRecord,
  ): Promise<CreditRepositoryWriteOutcome<ReturnedMediaChildAllocation>> {
    const prior = await this.findOperationReceipt(transaction, record.operation);
    if (prior.kind === "conflict") return prior;
    if (prior.kind === "replayed") {
      if (prior.value.state !== "terminal") throw new Error("CREDIT_OPERATION_RECEIPT_CORRUPT");
      return { kind: "replayed", value: prior.value };
    }
    const current = record.current;
    const sql = resolvePlatformTransaction(transaction);
    await this.#insertAllocationRevision(transaction, {
      allocationRevisionRef: record.childAllocationRevisionRef,
      budgetAllocationRef: current.childAllocationRef,
      executionBudgetRootRef: current.executionBudgetRootRef,
      siteId: current.siteId,
      billingAccountId: current.billingAccountId,
      creditAccountId: current.creditAccountId,
      unit: current.unit,
      liabilityMerchantAccountId: current.liabilityMerchantAccountId,
    }, record.childAllocation, record.childAllocation.terminalReceiptDigest,
    record.childAllocation.parentAppliedRevision);
    await this.#insertAllocationRevision(transaction, {
      allocationRevisionRef: record.parentAllocationRevisionRef,
      budgetAllocationRef: current.parentAllocationRef,
      executionBudgetRootRef: current.executionBudgetRootRef,
      siteId: current.siteId,
      billingAccountId: current.billingAccountId,
      creditAccountId: current.creditAccountId,
      unit: current.unit,
      liabilityMerchantAccountId: current.liabilityMerchantAccountId,
    }, record.parentAllocation, null, null);
    await exactlyOne(sql.execute(
       `INSERT INTO platform.credit_allocation_return_receipt
       (allocation_return_receipt_ref,site_ref,execution_budget_root_ref,parent_allocation_ref,
        child_allocation_ref,business_operation_key,request_digest,returned_amount,
        child_terminal_revision,parent_resulting_revision,fence_epoch,reason,receipt_digest,
        parent_expected_revision,parent_expected_epoch,child_expected_revision,child_expected_epoch,
        media_operation_ref,owner_closure_evidence_ref,audience,captured_amount,
        owner_closure_outcome,root_state_at_return,created_at)
       VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8::numeric,$9::bigint,$10::bigint,
               $11::bigint,$12,$13,$14::bigint,$15::bigint,$16::bigint,$17::bigint,$18,$19,
               'media',$20::numeric,$21,$22,$23::timestamptz)`,
      [record.receipt.allocationReturnReceiptRef, current.siteId, current.executionBudgetRootRef,
        current.parentAllocationRef, current.childAllocationRef, record.operation.businessOperationKey,
        record.operation.requestDigest, record.receipt.returnedAmount.toString(),
        record.receipt.childRevisionAfter.toString(), record.receipt.parentRevisionAfter.toString(),
        record.receipt.childAllocationEpochAfter.toString(), record.receipt.reason,
        record.receipt.receiptDigest, record.receipt.parentRevisionBefore.toString(),
        record.receipt.parentAllocationEpoch.toString(), record.receipt.childRevisionBefore.toString(),
        record.receipt.childAllocationEpochBefore.toString(), record.receipt.mediaOperationRef,
        record.receipt.ownerClosureEvidence.terminalReceiptRef, record.receipt.capturedAmount.toString(),
        record.receipt.ownerClosureEvidence.outcome, record.receipt.rootStateAtReturn, record.occurredAt],
    ), "CREDIT_MEDIA_CHILD_RETURN_RECEIPT_PERSIST_FAILED");
    await this.#writeChildEvidence(transaction, record.operationReceiptRef,
      record.operation, record.receipt, record.receipt.ownerClosureEvidence.terminalReceiptRef,
      record.occurredAt);
    return { kind: "accepted", value: record.receipt };
  }

  async #insertAllocationRevision(
    transaction: Parameters<CreditAuthorityRepository["findOperationReceipt"]>[0],
    identity: Readonly<{
      allocationRevisionRef: string;
      budgetAllocationRef: string;
      executionBudgetRootRef: string;
      siteId: string;
      billingAccountId: string;
      creditAccountId: string;
      unit: string;
      liabilityMerchantAccountId: string;
    }>,
    revision: BudgetAllocationRevision,
    terminalReceiptDigest: string | null,
    parentAppliedRevision: bigint | null,
  ): Promise<void> {
    await exactlyOne(resolvePlatformTransaction(transaction).execute(
      `INSERT INTO platform.credit_budget_allocation_revision
       (allocation_revision_ref,budget_allocation_ref,execution_budget_root_ref,site_ref,billing_account_ref,
        credit_account_ref,unit,liability_merchant_account_ref,revision,allocation_epoch,credit_ceiling,
        unassigned_stock,active_child_reserved_stock,committed_stock,captured_cumulative,
        returned_to_parent_cumulative,state,terminal_receipt_digest,parent_applied_revision)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7,$8,$9::bigint,$10::bigint,$11::numeric,
               $12::numeric,$13::numeric,$14::numeric,$15::numeric,$16::numeric,$17,$18,$19::bigint)`,
      [identity.allocationRevisionRef, identity.budgetAllocationRef, identity.executionBudgetRootRef,
        identity.siteId, identity.billingAccountId, identity.creditAccountId, identity.unit,
        identity.liabilityMerchantAccountId, revision.revision.toString(), revision.allocationEpoch.toString(),
        revision.creditCeiling.toString(), revision.unassignedStock.toString(),
        revision.activeChildReservedStock.toString(), revision.committedStock.toString(),
        revision.capturedCumulative.toString(), revision.returnedToParentCumulative.toString(),
        revision.state, terminalReceiptDigest, nullableBigint(parentAppliedRevision)],
    ), "CREDIT_ALLOCATION_REVISION_PERSIST_FAILED");
  }

  async #writeChildEvidence(
    transaction: Parameters<CreditAuthorityRepository["findOperationReceipt"]>[0],
    operationReceiptRef: string,
    operation: CreditOperationIdentity,
    value: DerivedMediaChildAllocation | ReturnedMediaChildAllocation,
    ownerClosureEvidenceRef: string | null,
    completedAt: string,
  ): Promise<void> {
    const sql = resolvePlatformTransaction(transaction);
    const resultJson = operationResultJson(value);
    const parentBefore = value.parentRevisionBefore;
    const parentAfter = value.parentRevisionAfter;
    const childBefore = value.childRevisionBefore;
    const childAfter = value.childRevisionAfter;
    const creditAmount = value.state === "active" ? value.reservedCeiling : value.returnedAmount;
    await exactlyOne(sql.execute(
      `INSERT INTO platform.credit_budget_operation_receipt
       (operation_receipt_ref,site_ref,operation_kind,business_operation_key,request_digest,
        execution_budget_root_ref,authorization_segment_ref,outcome_kind,result,result_digest,
        outbox_event_ref,completed_at,parent_allocation_ref,child_allocation_ref,
        parent_before_revision,parent_after_revision,child_before_revision,child_after_revision,
        credit_amount,owner_closure_evidence_ref)
       VALUES ($1::uuid,$2,$3,$4,$5,$6::uuid,NULL,'accepted',$7::jsonb,$8,NULL,$9::timestamptz,
               $10::uuid,$11::uuid,$12::bigint,$13::bigint,$14::bigint,$15::bigint,$16::numeric,$17)`,
      [operationReceiptRef, operation.siteId, operation.operationKind, operation.businessOperationKey,
        operation.requestDigest, value.executionBudgetRootRef, resultJson, digest(resultJson),
        completedAt, value.parentAllocationRef, value.childAllocationRef, parentBefore.toString(),
        parentAfter.toString(), childBefore.toString(), childAfter.toString(), creditAmount.toString(),
        ownerClosureEvidenceRef],
    ), "CREDIT_OPERATION_RECEIPT_PERSIST_FAILED");
  }

  async #mutationPrior(
    transaction: Parameters<CreditAuthorityRepository["findOperationReceipt"]>[0],
    operation: CreditOperationIdentity,
  ): Promise<CreditRepositoryWriteOutcome<SegmentMutationResult> | null> {
    const prior = await this.findOperationReceipt(transaction, operation);
    if (prior.kind === "none") return null;
    if (prior.kind === "conflict") return prior;
    if (prior.value.state !== "committed" && prior.value.state !== "released" &&
        prior.value.state !== "reconciliation_required") {
      throw new Error("CREDIT_OPERATION_RECEIPT_CORRUPT");
    }
    return { kind: "replayed", value: prior.value };
  }

  async #updateSegment(
    transaction: Parameters<CreditAuthorityRepository["commitAuthorizationSegment"]>[0],
    record: StoredSegmentAllocation,
    observedAt: string,
  ): Promise<void> {
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.credit_authorization_segment
       SET state=$1,resolution_kind=$2,resolution_ref=$3,committed_from_allocation_revision=$4::bigint,
           committed_to_allocation_revision=$5::bigint,aggregate_version=$6::bigint,fence_epoch=$7::bigint,
           committed_at=$8::timestamptz,settled_at=$9::timestamptz,released_at=$10::timestamptz,
           updated_at=$11::timestamptz
       WHERE authorization_segment_ref=$12::uuid AND site_ref=$13 AND aggregate_version=$14::bigint`,
      [record.segment.state, record.segment.resolutionKind, record.segment.resolutionRef,
        nullableBigint(record.segment.committedFromAllocationRevision),
        nullableBigint(record.segment.committedToAllocationRevision), record.segment.aggregateVersion.toString(),
        record.segment.fenceEpoch.toString(), record.segment.committedAt, record.segment.settledAt,
        record.segment.releasedAt, observedAt,
        record.authorizationSegmentRef, record.siteId, (record.segment.aggregateVersion - 1n).toString()],
    );
    if (changed !== 1) throw new Error("CREDIT_SEGMENT_CAS_LOST");
  }

  async #writeEvidence(
    transaction: Parameters<CreditAuthorityRepository["findOperationReceipt"]>[0],
    receiptRef: string,
    outboxEventRef: string,
    operation: CreditOperationIdentity,
    value: ReservedRunBudget | SegmentMutationResult,
    outcomeKind: "accepted" | "reconciliation_required",
    executionBudgetRootRef: string,
    authorizationSegmentRef: string,
    completedAt: string,
  ): Promise<void> {
    const sql = resolvePlatformTransaction(transaction);
    const resultJson = operationResultJson(value);
    const resultDigest = digest(resultJson);
    const eventPayload = canonicalJson({
      operationKind: operation.operationKind,
      siteId: operation.siteId,
      result: JSON.parse(resultJson) as unknown,
    });
    await exactlyOne(sql.execute(
      `INSERT INTO platform.outbox_event
       (event_id,owner,event_type,aggregate_id,payload,payload_digest,correlation_id,causation_id)
       VALUES ($1::uuid,'credit',$2,$3,$4::jsonb,$5,$6,NULL)`,
      [outboxEventRef, `credit.${operation.operationKind}.v1`, authorizationSegmentRef, eventPayload,
        digest(eventPayload), operation.businessOperationKey],
    ), "CREDIT_OUTBOX_PERSIST_FAILED");
    await exactlyOne(sql.execute(
      `INSERT INTO platform.credit_budget_operation_receipt
       (operation_receipt_ref,site_ref,operation_kind,business_operation_key,request_digest,
        execution_budget_root_ref,authorization_segment_ref,outcome_kind,result,result_digest,
        outbox_event_ref,completed_at)
       VALUES ($1::uuid,$2,$3,$4,$5,$6::uuid,$7::uuid,$8,$9::jsonb,$10,$11::uuid,$12::timestamptz)`,
      [receiptRef, operation.siteId, operation.operationKind, operation.businessOperationKey,
        operation.requestDigest, executionBudgetRootRef, authorizationSegmentRef, outcomeKind,
        resultJson, resultDigest, outboxEventRef, completedAt],
    ), "CREDIT_OPERATION_RECEIPT_PERSIST_FAILED");
  }
}

const SEGMENT_LINEAGE_SQL = `/* credit-segment-lineage-read */
SELECT segment.execution_budget_root_ref::text AS "executionBudgetRootRef",
       segment.budget_allocation_ref::text AS "budgetAllocationRef",
       segment.credit_hold_ref::text AS "creditHoldRef"
FROM platform.credit_authorization_segment AS segment
WHERE segment.site_ref=$1 AND segment.authorization_segment_ref=$2::uuid`;

const SEGMENT_FRESH_LOAD_SQL = `/* credit-segment-fresh-load */
SELECT segment.site_ref AS "siteId",segment.billing_account_ref AS "billingAccountId",
       segment.credit_account_ref AS "creditAccountId",segment.unit,
       segment.liability_merchant_account_ref AS "liabilityMerchantAccountId",
       segment.rating_policy_revision_ref AS "ratingPolicyRevisionRef",
       segment.execution_budget_root_ref AS "executionBudgetRootRef",root.state AS "executionBudgetRootState",
       root.aggregate_version AS "executionBudgetRootVersion",segment.credit_hold_ref AS "creditHoldRef",
       hold.state AS "creditHoldState",hold.fence_epoch AS "creditHoldFenceEpoch",
       segment.budget_allocation_ref AS "budgetAllocationRef",
       segment.authorization_segment_ref AS "authorizationSegmentRef",
       segment.execution_manifest_ref AS "executionManifestRef",segment.expires_at AS "expiresAt",revision.revision,
       root.surface_ref AS "surfaceRef",root.capability_key AS "capabilityKey",root.agent_ref AS "agentRef",
       revision.allocation_epoch AS "allocationEpoch",revision.credit_ceiling::text AS "creditCeiling",
       revision.unassigned_stock::text AS "unassignedStock",
       revision.active_child_reserved_stock::text AS "activeChildReservedStock",
       revision.committed_stock::text AS "committedStock",
       revision.captured_cumulative::text AS "capturedCumulative",
       revision.returned_to_parent_cumulative::text AS "returnedToParentCumulative",
       revision.state AS "allocationState",segment.state AS "segmentState",
       segment.maximum_amount::text AS "maximumAmount",
       segment.allocation_epoch AS "segmentAllocationEpoch",
       segment.prepared_against_allocation_revision AS "preparedAgainstAllocationRevision",
       segment.committed_from_allocation_revision AS "committedFromAllocationRevision",
       segment.committed_to_allocation_revision AS "committedToAllocationRevision",
       segment.aggregate_version AS "aggregateVersion",segment.fence_epoch AS "fenceEpoch",
       segment.resolution_kind AS "resolutionKind",segment.resolution_ref AS "resolutionRef",
       segment.committed_at AS "committedAt",segment.settled_at AS "settledAt",
       segment.released_at AS "releasedAt"
FROM platform.credit_authorization_segment segment
JOIN platform.credit_budget_allocation allocation
  ON allocation.budget_allocation_ref=segment.budget_allocation_ref AND allocation.site_ref=segment.site_ref
JOIN platform.credit_budget_allocation_revision revision
  ON revision.budget_allocation_ref=allocation.budget_allocation_ref
 AND revision.revision=allocation.current_revision
JOIN platform.credit_execution_budget_root root
  ON root.execution_budget_root_ref=segment.execution_budget_root_ref AND root.site_ref=segment.site_ref
JOIN platform.credit_hold hold
  ON hold.credit_hold_ref=segment.credit_hold_ref AND hold.site_ref=segment.site_ref
WHERE segment.site_ref=$1 AND segment.authorization_segment_ref=$2::uuid
FOR UPDATE OF segment`;

type JournalEntry = Readonly<{
  ordinal: number;
  side: "debit" | "credit";
  accountType: "customer_available" | "customer_reserved";
  amount: bigint;
  creditGrantId: string;
}>;

function reserveEntries(record: RootBudgetReservationRecord): readonly JournalEntry[] {
  return Object.freeze(record.allocations.flatMap((allocation) => [
    Object.freeze({ ordinal: allocation.ordinal * 2, side: "debit" as const,
      accountType: "customer_available" as const, amount: allocation.amount,
      creditGrantId: allocation.creditGrantId }),
    Object.freeze({ ordinal: allocation.ordinal * 2 + 1, side: "credit" as const,
      accountType: "customer_reserved" as const, amount: allocation.amount,
      creditGrantId: allocation.creditGrantId }),
  ]));
}

function journalEntriesDigest(record: RootBudgetReservationRecord, entries: readonly JournalEntry[]): string {
  return digest(entries.map((entry) => [entry.ordinal, record.siteId, record.creditAccountId.toLowerCase(), record.unit,
    entry.side, entry.accountType, entry.amount.toString(), entry.creditGrantId.toLowerCase(),
    record.creditHoldRef.toLowerCase()].join("|")).join("\n"));
}

function mapSegment(row: SegmentRow): StoredSegmentAllocation {
  return Object.freeze({
    siteId: row.siteId,
    billingAccountId: row.billingAccountId,
    creditAccountId: row.creditAccountId,
    unit: row.unit,
    liabilityMerchantAccountId: row.liabilityMerchantAccountId,
    ratingPolicyRevisionRef: row.ratingPolicyRevisionRef,
    executionBudgetRootRef: row.executionBudgetRootRef,
    executionBudgetRootState: row.executionBudgetRootState,
    executionBudgetRootVersion: BigInt(row.executionBudgetRootVersion),
    creditHoldRef: row.creditHoldRef,
    creditHoldState: row.creditHoldState,
    creditHoldFenceEpoch: BigInt(row.creditHoldFenceEpoch),
    budgetAllocationRef: row.budgetAllocationRef,
    authorizationSegmentRef: row.authorizationSegmentRef,
    executionManifestRef: row.executionManifestRef,
    consumptionScope: Object.freeze({
      surfaceRef: row.surfaceRef,
      capabilityKey: row.capabilityKey,
      agentRef: row.agentRef,
    }),
    expiresAt: instant(row.expiresAt),
    allocation: rehydrateBudgetAllocationRevision({
      revision: BigInt(row.revision), allocationEpoch: BigInt(row.allocationEpoch),
      creditCeiling: BigInt(row.creditCeiling), unassignedStock: BigInt(row.unassignedStock),
      activeChildReservedStock: BigInt(row.activeChildReservedStock), committedStock: BigInt(row.committedStock),
      capturedCumulative: BigInt(row.capturedCumulative),
      returnedToParentCumulative: BigInt(row.returnedToParentCumulative), state: row.allocationState,
    }),
    segment: Object.freeze({
      state: row.segmentState, maximumAmount: BigInt(row.maximumAmount),
      allocationEpoch: BigInt(row.segmentAllocationEpoch),
      preparedAgainstAllocationRevision: BigInt(row.preparedAgainstAllocationRevision),
      committedFromAllocationRevision: optionalBigint(row.committedFromAllocationRevision),
      committedToAllocationRevision: optionalBigint(row.committedToAllocationRevision),
      aggregateVersion: BigInt(row.aggregateVersion), fenceEpoch: BigInt(row.fenceEpoch),
      resolutionKind: row.resolutionKind, resolutionRef: row.resolutionRef,
      committedAt: nullableInstant(row.committedAt), settledAt: nullableInstant(row.settledAt),
      releasedAt: nullableInstant(row.releasedAt),
    }),
  });
}

function segmentResult(record: StoredSegmentAllocation, observedAt: string): SegmentMutationResult {
  if (record.segment.state !== "committed" && record.segment.state !== "released" &&
      record.segment.state !== "reconciliation_required") throw new Error("CREDIT_SEGMENT_RESULT_STATE_INVALID");
  return Object.freeze({ authorizationSegmentRef: record.authorizationSegmentRef,
    segmentVersion: record.segment.aggregateVersion, state: record.segment.state, observedAt });
}

function operationIdentity(
  operationKind: CreditOperationIdentity["operationKind"],
  record: Pick<RootBudgetReservationRecord, "siteId" | "businessOperationKey" | "requestDigest">,
): CreditOperationIdentity {
  return { operationKind, siteId: record.siteId, businessOperationKey: record.businessOperationKey,
    requestDigest: record.requestDigest };
}

function operationResultJson(value: CreditOperationValue): string {
  return canonicalJson(jsonReady(value));
}

function parseOperationResult(value: unknown, identity: CreditOperationIdentity): CreditOperationValue {
  if (!isObject(value)) throw new Error("CREDIT_OPERATION_RECEIPT_CORRUPT");
  const state = ownField(value, "state", "CREDIT_OPERATION_RECEIPT_CORRUPT");
  if (state === "reserved") return parseReservedRunBudget(value);
  if (state === "committed" || state === "released" || state === "reconciliation_required") {
    return parseSegmentMutationResult(value, state);
  }
  if (state === "active") return parseDerivedMediaChildReceipt(value, identity);
  if (state === "terminal") return parseReturnedMediaChildReceipt(value, identity);
  throw new Error("CREDIT_OPERATION_RECEIPT_CORRUPT");
}

function validateOperationReceiptScope(
  row: ReceiptRow,
  identity: CreditOperationIdentity,
  value: CreditOperationValue,
): void {
  const executionBudgetRootRef = stringField(row, "executionBudgetRootRef", "CREDIT_OPERATION_RECEIPT_CORRUPT");
  const authorizationSegmentRef = nullableStringField(row, "authorizationSegmentRef",
    "CREDIT_OPERATION_RECEIPT_CORRUPT");
  const parentAllocationRef = nullableStringField(row, "parentAllocationRef", "CREDIT_OPERATION_RECEIPT_CORRUPT");
  const childAllocationRef = nullableStringField(row, "childAllocationRef", "CREDIT_OPERATION_RECEIPT_CORRUPT");
  const parentBeforeRevision = nullableNonnegativeBigintField(row, "parentBeforeRevision",
    "CREDIT_OPERATION_RECEIPT_CORRUPT");
  const parentAfterRevision = nullableNonnegativeBigintField(row, "parentAfterRevision",
    "CREDIT_OPERATION_RECEIPT_CORRUPT");
  const childBeforeRevision = nullableNonnegativeBigintField(row, "childBeforeRevision",
    "CREDIT_OPERATION_RECEIPT_CORRUPT");
  const childAfterRevision = nullableNonnegativeBigintField(row, "childAfterRevision",
    "CREDIT_OPERATION_RECEIPT_CORRUPT");
  const creditAmount = nullableNonnegativeBigintField(row, "creditAmount", "CREDIT_OPERATION_RECEIPT_CORRUPT");
  const ownerClosureEvidenceRef = nullableStringField(row, "ownerClosureEvidenceRef",
    "CREDIT_OPERATION_RECEIPT_CORRUPT");
  if (identity.operationKind === "derive_media_child") {
    if (value.state !== "active" || executionBudgetRootRef !== value.executionBudgetRootRef ||
        authorizationSegmentRef !== null || parentAllocationRef !== value.parentAllocationRef ||
        childAllocationRef !== value.childAllocationRef || parentBeforeRevision !== value.parentRevisionBefore ||
        parentAfterRevision !== value.parentRevisionAfter || childBeforeRevision !== value.childRevisionBefore ||
        childAfterRevision !== value.childRevisionAfter || creditAmount !== value.reservedCeiling ||
        ownerClosureEvidenceRef !== null) throw new Error("CREDIT_OPERATION_RECEIPT_SCOPE_MISMATCH");
    return;
  }
  if (identity.operationKind === "return_media_child") {
    if (value.state !== "terminal" || executionBudgetRootRef !== value.executionBudgetRootRef ||
        authorizationSegmentRef !== null || parentAllocationRef !== value.parentAllocationRef ||
        childAllocationRef !== value.childAllocationRef || parentBeforeRevision !== value.parentRevisionBefore ||
        parentAfterRevision !== value.parentRevisionAfter || childBeforeRevision !== value.childRevisionBefore ||
        childAfterRevision !== value.childRevisionAfter || creditAmount !== value.returnedAmount ||
        ownerClosureEvidenceRef !== value.ownerClosureEvidence.terminalReceiptRef) {
      throw new Error("CREDIT_OPERATION_RECEIPT_SCOPE_MISMATCH");
    }
    return;
  }
  const expectedState = identity.operationKind === "reserve_root" ? "reserved"
    : identity.operationKind === "finalize_segment" ? "committed"
      : identity.operationKind === "release_segment" ? "released" : "reconciliation_required";
  const resultSegmentRef = value.state === "reserved" || value.state === "committed" ||
      value.state === "released" || value.state === "reconciliation_required"
    ? value.authorizationSegmentRef : null;
  if (value.state !== expectedState || authorizationSegmentRef === null ||
      authorizationSegmentRef !== resultSegmentRef ||
      parentAllocationRef !== null || childAllocationRef !== null || parentBeforeRevision !== null ||
      parentAfterRevision !== null || childBeforeRevision !== null || childAfterRevision !== null ||
      creditAmount !== null || ownerClosureEvidenceRef !== null) {
    throw new Error("CREDIT_OPERATION_RECEIPT_SCOPE_MISMATCH");
  }
}

function parseReservedRunBudget(value: Record<string, unknown>): ReservedRunBudget {
  strictKeys(value, ["authorizationSegmentRef", "creditHoldRef", "executionBudgetRootRef",
    "expiresAt", "rootAllocationEpoch", "rootAllocationRef", "rootAllocationRevision",
    "segmentVersion", "state"]);
  const rootAllocationRevision = positiveBigintField(value, "rootAllocationRevision");
  const rootAllocationEpoch = positiveBigintField(value, "rootAllocationEpoch");
  if (rootAllocationRevision !== 1n || rootAllocationEpoch !== 1n) {
    throw new Error("CREDIT_OPERATION_RECEIPT_CORRUPT");
  }
  return Object.freeze({
    executionBudgetRootRef: referenceField(value, "executionBudgetRootRef"),
    creditHoldRef: referenceField(value, "creditHoldRef"),
    rootAllocationRef: referenceField(value, "rootAllocationRef"),
    rootAllocationRevision: 1n,
    rootAllocationEpoch: 1n,
    authorizationSegmentRef: referenceField(value, "authorizationSegmentRef"),
    segmentVersion: positiveBigintField(value, "segmentVersion"),
    state: "reserved",
    expiresAt: strictInstantField(value, "expiresAt", "CREDIT_OPERATION_RECEIPT_CORRUPT"),
  });
}

function parseSegmentMutationResult(
  value: Record<string, unknown>,
  state: SegmentMutationResult["state"],
): SegmentMutationResult {
  strictKeys(value, ["authorizationSegmentRef", "observedAt", "segmentVersion", "state"]);
  return Object.freeze({
    authorizationSegmentRef: referenceField(value, "authorizationSegmentRef"),
    segmentVersion: positiveBigintField(value, "segmentVersion"),
    state,
    observedAt: strictInstantField(value, "observedAt", "CREDIT_OPERATION_RECEIPT_CORRUPT"),
  });
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function jsonReady(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonReady);
  if (isObject(value)) return Object.fromEntries(Object.entries(value)
    .map(([key, entry]) => [key, jsonReady(entry)]));
  return value;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isObject(value)) return Object.fromEntries(Object.keys(value)
    .sort(compareCodeUnits).map((key) => [key, sortJson(value[key])]));
  return value;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function exactlyOne(change: Promise<number>, code: string): Promise<void> {
  if (await change !== 1) throw new Error(code);
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) &&
    !Object.keys(value).some((key) => FORBIDDEN_KEYS.has(key));
}

function instant(value: Date | string): string {
  const result = value instanceof Date ? value.toISOString() : value;
  const parsed = new Date(result);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    throw new Error("CREDIT_INSTANT_INVALID");
  }
  return result;
}

function nullableInstant(value: Date | string | null): string | null {
  return value === null ? null : instant(value);
}

function optionalBigint(value: bigint | string | null): bigint | null {
  return value === null ? null : BigInt(value);
}

function nullableBigint(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

function ownField(row: Record<string, unknown>, key: string, code: string): unknown {
  if (!Object.hasOwn(row, key)) throw new Error(code);
  return row[key];
}

function stringField(row: Record<string, unknown>, key: string, code: string): string {
  const value = ownField(row, key, code);
  if (typeof value !== "string") throw new Error(code);
  return value;
}

function referenceField(row: Record<string, unknown>, key: string): string {
  const value = stringField(row, key, "CREDIT_OPERATION_RECEIPT_CORRUPT");
  if (value.length < 1 || value.length > 256 || hasControlCharacter(value)) {
    throw new Error("CREDIT_OPERATION_RECEIPT_CORRUPT");
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });
}

function nullableStringField(row: Record<string, unknown>, key: string, code: string): string | null {
  const value = ownField(row, key, code);
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(code);
  return value;
}

function bigintField(row: Record<string, unknown>, key: string, code: string): bigint {
  const value = ownField(row, key, code);
  if (typeof value === "bigint") return value;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error(code);
  return BigInt(value);
}

function positiveBigintField(row: Record<string, unknown>, key: string): bigint {
  const value = bigintField(row, key, "CREDIT_OPERATION_RECEIPT_CORRUPT");
  if (value <= 0n) throw new Error("CREDIT_OPERATION_RECEIPT_CORRUPT");
  return value;
}

function nullableNonnegativeBigintField(
  row: Record<string, unknown>,
  key: string,
  code: string,
): bigint | null {
  const value = ownField(row, key, code);
  if (value === null) return null;
  if (typeof value === "bigint") return value >= 0n ? value : failBigint(code);
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error(code);
  return BigInt(value);
}

function failBigint(code: string): never {
  throw new Error(code);
}

function strictInstantField(row: Record<string, unknown>, key: string, code: string): string {
  const value = ownField(row, key, code);
  if (value instanceof Date || typeof value === "string") {
    try { return instant(value); } catch { throw new Error(code); }
  }
  throw new Error(code);
}

function strictKeys(row: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(row).sort(compareCodeUnits);
  const exact = [...expected].sort(compareCodeUnits);
  if (actual.length !== exact.length || actual.some((key, index) => key !== exact[index])) {
    throw new Error("CREDIT_OPERATION_RECEIPT_CORRUPT");
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const DIGEST = /^[a-f0-9]{64}$/u;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
