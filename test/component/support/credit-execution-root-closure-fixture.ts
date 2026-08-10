import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { creditJournalEntriesDigest } from
  "../../../src/modules/credit/domain/journal-digest.js";
import {
  deriveExecutionRootClosureRequestDigest,
  ExecutionRootClosureService,
  type ExecutionRootClosureRequest,
} from "../../../src/modules/credit/application/execution-root-closure-service.js";
import { verifyAdmissionExecutionRootOwnerProof } from
  "../../../src/modules/credit/application/contracts/execution-root-closure-repository.js";
import { PostgresExecutionRootClosureRepository } from
  "../../../src/modules/credit/infrastructure/postgres/execution-root-closure-repository.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
  type PlatformSqlTransaction,
} from "../../../src/shared/unit-of-work/platform-transaction.js";

export type CreditRootClosureFixture = Readonly<{
  siteId: string;
  billingAccountId: string;
  creditAccountRef: string;
  creditProgramRevisionRef: string;
  creditGrantRef: string;
  issuanceJournalRef: string;
  reserveJournalRef: string;
  captureJournalRef: string | null;
  ratingPolicyRevisionRef: string;
  holdRef: string;
  rootRef: string;
  allocationRef: string;
  authorizationSegmentRef: string;
  manifestRef: string;
  attemptAuthorizationRef: string;
  attemptRef: string;
  evidenceRef: string;
  closureRef: string;
  ratingSnapshotRef: string;
  settlementRef: string;
  runRef: string;
  sessionRef: string;
  launchRef: string;
  terminalEvidenceRef: string;
  terminalEvidenceDigest: string;
  businessOperationKey: string;
  capturedAmount: bigint;
  allocationCapturedAmount: bigint;
}>;

export type CreditRootClosureInventory = Readonly<{
  allocationRevision: string;
  allocationEpoch: string;
  allocationState: string;
  rootState: string;
  rootVersion: string;
  holdState: string;
  holdFence: string;
  capturedAmount: string;
  releasedAmount: string;
  closureCount: string;
  reconciliationCount: string;
  outcomeCount: string;
  releaseJournalCount: string;
}>;

export function creditRootClosureFixture(input: Readonly<{
  capturedAmount: bigint;
  allocationCapturedAmount?: bigint;
}>): CreditRootClosureFixture {
  const suffix = randomUUID();
  return Object.freeze({
    siteId: `credit-root-close-${suffix}`,
    billingAccountId: `billing-root-close-${suffix}`,
    creditAccountRef: randomUUID(),
    creditProgramRevisionRef: `program-root-close-${suffix}`,
    creditGrantRef: randomUUID(),
    issuanceJournalRef: randomUUID(),
    reserveJournalRef: randomUUID(),
    captureJournalRef: input.capturedAmount === 0n ? null : randomUUID(),
    ratingPolicyRevisionRef: `rating-root-close-${suffix}`,
    holdRef: randomUUID(),
    rootRef: randomUUID(),
    allocationRef: randomUUID(),
    authorizationSegmentRef: randomUUID(),
    manifestRef: `manifest-root-close-${suffix}`,
    attemptAuthorizationRef: randomUUID(),
    attemptRef: `attempt-root-close-${suffix}`,
    evidenceRef: randomUUID(),
    closureRef: randomUUID(),
    ratingSnapshotRef: randomUUID(),
    settlementRef: randomUUID(),
    runRef: `run-root-close-${suffix}`,
    sessionRef: `session-root-close-${suffix}`,
    launchRef: `launch-root-close-${suffix}`,
    terminalEvidenceRef: `terminal-root-close-${suffix}`,
    terminalEvidenceDigest: createHash("sha256").update(`terminal:${suffix}`).digest("hex"),
    businessOperationKey: `close-root-${suffix}`,
    capturedAmount: input.capturedAmount,
    allocationCapturedAmount: input.allocationCapturedAmount ?? input.capturedAmount,
  });
}

export function creditRootClosureRequest(
  fixture: CreditRootClosureFixture,
  overrides: Readonly<{ rootAllocationRevision?: bigint }> = {},
): ExecutionRootClosureRequest {
  const ownerProof = verifyAdmissionExecutionRootOwnerProof({
    sourceRef: fixture.runRef,
    terminalEvidenceRef: fixture.terminalEvidenceRef,
    terminalEvidenceDigest: fixture.terminalEvidenceDigest,
    outcome: "completed",
    manifestRef: fixture.manifestRef,
    sessionId: fixture.sessionRef,
    launchId: fixture.launchRef,
  });
  const input = Object.freeze({
    siteId: fixture.siteId,
    ownerProof,
    budget: Object.freeze({
      kind: "direct_root" as const,
      executionBudgetRootRef: fixture.rootRef,
      executionManifestRef: fixture.manifestRef,
      rootHoldRef: fixture.holdRef,
      rootAllocationRef: fixture.allocationRef,
      rootAllocationRevision: overrides.rootAllocationRevision ?? 1n,
      rootAllocationEpoch: 1n,
      authorizationSegmentRef: fixture.authorizationSegmentRef,
      authorizationSegmentVersion: 4n,
      reservedCeiling: 100n,
      unit: "credit_micros",
    }),
    settlement: Object.freeze({
      settlementRef: fixture.settlementRef,
      authorizationSegmentRef: fixture.authorizationSegmentRef,
      closureRef: fixture.closureRef,
      closureRevision: 1n,
      state: "settled" as const,
      customerAmount: fixture.capturedAmount,
      platformExposureAmount: 0n,
    }),
    businessOperationKey: fixture.businessOperationKey,
  });
  return Object.freeze({ ...input, requestDigest: deriveExecutionRootClosureRequestDigest(input) });
}

export async function executeCreditRootClosure(
  admission: Client,
  fixture: CreditRootClosureFixture,
  request: ExecutionRootClosureRequest = creditRootClosureRequest(fixture),
) {
  await admission.query("BEGIN");
  let lease: ReturnType<typeof issuePlatformTransaction> | null = null;
  try {
    await admission.query("SELECT platform.begin_admission_transaction('admission.command')");
    await admission.query("SELECT set_config('app.site_id',$1,true)", [fixture.siteId]);
    await admission.query(
      `SELECT platform.record_admission_verified_terminal_evidence(
         $1,$2,$3,$4,$5,$6,'completed',$7)`,
      [fixture.siteId, fixture.runRef, fixture.manifestRef, fixture.sessionRef, fixture.launchRef,
        fixture.terminalEvidenceRef, fixture.terminalEvidenceDigest],
    );
    lease = issuePlatformTransaction(pgTransaction(admission));
    const result = await new ExecutionRootClosureService({
      repository: new PostgresExecutionRootClosureRepository(),
      clock: () => new Date("2026-08-27T12:00:00.000Z"),
    }).close(lease.transaction, request);
    revokePlatformTransaction(lease);
    lease = null;
    await admission.query("COMMIT");
    return result;
  } catch (error) {
    if (lease !== null) revokePlatformTransaction(lease);
    await admission.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export async function seedCreditRootClosure(
  client: Client,
  fixture: CreditRootClosureFixture,
): Promise<void> {
  const scopePolicy = Object.freeze({
    version: 1,
    surfaceRefs: ["chat"],
    capabilityKeys: ["chat.main"],
    agentRefs: [],
    allowUnattributedAgent: true,
  });
  const issuanceEntries = rootClosureJournalEntries(fixture, [
    [0, "debit", "grant_issuance_source", 100n, null],
    [1, "credit", "customer_available", 100n, null],
  ]);
  const reserveEntries = rootClosureJournalEntries(fixture, [
    [0, "debit", "customer_available", 100n, fixture.holdRef],
    [1, "credit", "customer_reserved", 100n, fixture.holdRef],
  ]);
  const captureEntries = rootClosureJournalEntries(fixture, fixture.capturedAmount === 0n ? [] : [
    [0, "debit", "customer_reserved", fixture.capturedAmount, fixture.holdRef],
    [1, "credit", "customer_consumed", fixture.capturedAmount, fixture.holdRef],
  ]);
  const now = "2026-08-27T11:59:00.000Z";
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.site_id',$1,true)", [fixture.siteId]);
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(
      `INSERT INTO platform.authorization_site
       (site_ref,state,security_epoch,policy_epoch,revocation_epoch)
       VALUES ($1,'active',1,1,1)`,
      [fixture.siteId],
    );
    await client.query(
      `INSERT INTO platform.commerce_billing_account(billing_account_ref,site_ref,state)
       VALUES ($1,$2,'active')`,
      [fixture.billingAccountId, fixture.siteId],
    );
    await client.query(
      `INSERT INTO platform.credit_account
       (credit_account_ref,site_ref,billing_account_ref,unit,liability_merchant_account_ref,state)
       VALUES ($1::uuid,$2,$3,'credit_micros','merchant-component','active')`,
      [fixture.creditAccountRef, fixture.siteId, fixture.billingAccountId],
    );
    await client.query(
      `INSERT INTO platform.commerce_credit_program_revision
       (credit_program_revision_ref,site_ref,program_ref,revision,ux_bucket_class,unit,amount,
        burn_priority,scope_policy,liability_merchant_account_ref,window_kind,rollover_policy,
        revision_digest,catalog_epoch,published_at)
       VALUES ($1,$2,$1,1,'permanent','credit_micros',100,1000,$3::jsonb,
               'merchant-component','none','none',$4,1,$5::timestamptz)`,
      [fixture.creditProgramRevisionRef, fixture.siteId, JSON.stringify(scopePolicy),
        createHash("sha256").update(`program:${fixture.siteId}`).digest("hex"), now],
    );
    await client.query(
      `INSERT INTO platform.credit_rating_policy_revision
       (rating_policy_revision_ref,site_ref,unit,policy,policy_digest,state,published_at)
       VALUES ($1,$2,'credit_micros','{}'::jsonb,$3,'published',$4::timestamptz)`,
      [fixture.ratingPolicyRevisionRef, fixture.siteId,
        createHash("sha256").update(`rating:${fixture.siteId}`).digest("hex"), now],
    );
    await insertRootClosureJournal(client, fixture, {
      journalRef: fixture.issuanceJournalRef,
      businessOperationKey: `issue-${fixture.creditGrantRef}`,
      operationKind: "grant_issue",
      entries: issuanceEntries,
    });
    await client.query(
      `INSERT INTO platform.credit_grant
       (credit_grant_id,credit_account_ref,site_ref,billing_account_ref,credit_program_revision_ref,
        credit_program_revision,credit_program_revision_digest,source_type,source_ref,
        source_window_key,issuance_journal_transaction_ref,ux_bucket_class,unit,
        liability_merchant_account_ref,original_amount,burn_priority,scope_policy,
        effective_at,acquired_at,issued_at)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5,1,$9,'admin_grant',$8,'',$6::uuid,'permanent',
               'credit_micros','merchant-component',100,1000,$7::jsonb,
               $10::timestamptz,$10::timestamptz,$10::timestamptz)`,
      [fixture.creditGrantRef, fixture.creditAccountRef, fixture.siteId, fixture.billingAccountId,
        fixture.creditProgramRevisionRef, fixture.issuanceJournalRef, JSON.stringify(scopePolicy),
        `admin-${fixture.creditGrantRef}`,
        createHash("sha256").update(`program:${fixture.siteId}`).digest("hex"), now],
    );
    await insertRootClosureJournalEntries(client, fixture.issuanceJournalRef, issuanceEntries);
    await client.query(
      `INSERT INTO platform.credit_hold
       (credit_hold_ref,credit_account_ref,site_ref,execution_root_ref,unit,requested_amount,
        reserved_amount,captured_amount,state,fence_epoch,expires_at,created_at,updated_at)
       VALUES ($1::uuid,$2::uuid,$3,$4,'credit_micros',100,100,$5::numeric,'open',$6::bigint,
               '2026-08-27T13:00:00.000Z',$7::timestamptz,$7::timestamptz)`,
      [fixture.holdRef, fixture.creditAccountRef, fixture.siteId, fixture.runRef,
        fixture.capturedAmount.toString(), fixture.capturedAmount === 0n ? "1" : "2", now],
    );
    await insertRootClosureJournal(client, fixture, {
      journalRef: fixture.reserveJournalRef,
      businessOperationKey: `reserve-${fixture.holdRef}`,
      operationKind: "hold_reserve",
      entries: reserveEntries,
    });
    await client.query(
      `INSERT INTO platform.credit_hold_allocation
       (credit_hold_ref,credit_grant_id,site_ref,credit_account_ref,unit,
        reserve_journal_transaction_ref,allocated_amount,allocation_ordinal)
       VALUES ($1::uuid,$2::uuid,$3,$4::uuid,'credit_micros',$5::uuid,100,0)`,
      [fixture.holdRef, fixture.creditGrantRef, fixture.siteId, fixture.creditAccountRef,
        fixture.reserveJournalRef],
    );
    await insertRootClosureJournalEntries(client, fixture.reserveJournalRef, reserveEntries);
    await client.query(
      `INSERT INTO platform.credit_execution_budget_root
       (execution_budget_root_ref,site_ref,execution_root_ref,billing_account_ref,credit_account_ref,
        unit,liability_merchant_account_ref,credit_hold_ref,root_allocation_ref,
        authorization_budget_ref,rating_policy_revision_ref,surface_ref,capability_key,reserved_ceiling,
        state,aggregate_version,created_at,updated_at)
       VALUES ($1::uuid,$2,$3,$4,$5::uuid,'credit_micros','merchant-component',$6::uuid,$7::uuid,
               'budget-component',$8,'chat','chat.main',100,'open',1,$9::timestamptz,$9::timestamptz)`,
      [fixture.rootRef, fixture.siteId, fixture.runRef, fixture.billingAccountId,
        fixture.creditAccountRef, fixture.holdRef, fixture.allocationRef,
        fixture.ratingPolicyRevisionRef, now],
    );
    await client.query(
      `INSERT INTO platform.credit_budget_allocation
       (budget_allocation_ref,execution_budget_root_ref,site_ref,billing_account_ref,credit_account_ref,
        unit,liability_merchant_account_ref,parent_allocation_ref,is_root,audience,purpose)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5::uuid,'credit_micros','merchant-component',NULL,TRUE,'root','execution_root')`,
      [fixture.allocationRef, fixture.rootRef, fixture.siteId, fixture.billingAccountId,
        fixture.creditAccountRef],
    );
    for (const revision of [
      { revision: 1n, unassigned: 100n, committed: 0n, captured: 0n },
      { revision: 2n, unassigned: 0n, committed: 100n, captured: 0n },
      { revision: 3n, unassigned: 100n - fixture.allocationCapturedAmount, committed: 0n,
        captured: fixture.allocationCapturedAmount },
    ] as const) {
      await client.query(
        `INSERT INTO platform.credit_budget_allocation_revision
         (allocation_revision_ref,budget_allocation_ref,execution_budget_root_ref,site_ref,
          billing_account_ref,credit_account_ref,unit,liability_merchant_account_ref,
          revision,allocation_epoch,credit_ceiling,unassigned_stock,active_child_reserved_stock,
          committed_stock,captured_cumulative,returned_to_parent_cumulative,state)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,'credit_micros','merchant-component',
                 $7::bigint,1,100,$8::numeric,0,$9::numeric,$10::numeric,0,'active')`,
        [randomUUID(), fixture.allocationRef, fixture.rootRef, fixture.siteId,
          fixture.billingAccountId, fixture.creditAccountRef, revision.revision.toString(),
          revision.unassigned.toString(), revision.committed.toString(), revision.captured.toString()],
      );
    }
    await client.query(
      `INSERT INTO platform.credit_authorization_segment
       (authorization_segment_ref,site_ref,execution_budget_root_ref,budget_allocation_ref,
        credit_hold_ref,billing_account_ref,credit_account_ref,unit,liability_merchant_account_ref,
        execution_manifest_ref,rating_policy_revision_ref,business_operation_key,request_digest,
        maximum_amount,allocation_epoch,prepared_against_allocation_revision,
        committed_from_allocation_revision,committed_to_allocation_revision,state,resolution_kind,
        resolution_ref,fence_epoch,aggregate_version,expires_at,committed_at,settled_at,created_at,updated_at)
       VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid,$6,$7::uuid,'credit_micros',
               'merchant-component',$8,$9,$10,$11,100,1,1,1,2,'settled','rated',$12,4,4,
               '2026-08-27T13:00:00.000Z',$13::timestamptz,$13::timestamptz,$13::timestamptz,$13::timestamptz)`,
      [fixture.authorizationSegmentRef, fixture.siteId, fixture.rootRef, fixture.allocationRef,
        fixture.holdRef, fixture.billingAccountId, fixture.creditAccountRef, fixture.manifestRef,
        fixture.ratingPolicyRevisionRef, `segment-${fixture.authorizationSegmentRef}`,
        createHash("sha256").update(`segment:${fixture.siteId}`).digest("hex"), fixture.settlementRef,
        now],
    );
    await client.query(
      `INSERT INTO platform.credit_usage_attempt_intent
       (attempt_authorization_ref,site_ref,execution_budget_root_ref,budget_allocation_ref,
        authorization_segment_ref,credit_hold_ref,credit_account_ref,unit,execution_manifest_ref,
        producer_kind,producer_context,producer_generation,attempt_ref,logical_effect_ref,
        maximum_dimensions,maximum_dimensions_digest,maximum_amount,provisional_customer_amount,
        state,fence_epoch,owner_evidence_ref,committed_at,updated_at)
       VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,'credit_micros',$8,
               'model_gateway',$9,1,$10,$11,'["tokens"]'::jsonb,$12,100,$13::numeric,
               'finalized',2,$14,$15::timestamptz,$15::timestamptz)`,
      [fixture.attemptAuthorizationRef, fixture.siteId, fixture.rootRef, fixture.allocationRef,
        fixture.authorizationSegmentRef, fixture.holdRef, fixture.creditAccountRef, fixture.manifestRef,
        `producer-${fixture.siteId}`, fixture.attemptRef, `effect-${fixture.siteId}`,
        createHash("sha256").update("[\"tokens\"]").digest("hex"),
        fixture.capturedAmount.toString(), fixture.evidenceRef, now],
    );
    await client.query(
      `INSERT INTO platform.credit_attempt_usage_evidence
       (evidence_ref,attempt_authorization_ref,site_ref,execution_budget_root_ref,budget_allocation_ref,
        authorization_segment_ref,credit_hold_ref,credit_account_ref,unit,execution_manifest_ref,
        producer_kind,producer_context,producer_generation,attempt_ref,logical_effect_ref,revision,
        evidence_kind,attempt_outcome,source_digest,evidence,evidence_digest,occurred_at,observed_at)
       VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::uuid,
               'credit_micros',$9,'model_gateway',$10,1,$11,$12,1,$13,'succeeded',$14,
               '{}'::jsonb,$15,$16::timestamptz,$16::timestamptz)`,
      [fixture.evidenceRef, fixture.attemptAuthorizationRef, fixture.siteId, fixture.rootRef,
        fixture.allocationRef, fixture.authorizationSegmentRef, fixture.holdRef,
        fixture.creditAccountRef, fixture.manifestRef, `producer-${fixture.siteId}`,
        fixture.attemptRef, `effect-${fixture.siteId}`,
        fixture.capturedAmount === 0n ? "zero" : "measured",
        createHash("sha256").update(`source:${fixture.siteId}`).digest("hex"),
        createHash("sha256").update(`evidence:${fixture.siteId}`).digest("hex"), now],
    );
    await client.query(
      `INSERT INTO platform.credit_usage_segment_closure
       (closure_ref,site_ref,execution_budget_root_ref,budget_allocation_ref,
        authorization_segment_ref,credit_hold_ref,execution_manifest_ref,closure_revision,
        correction_of_closure_ref,expected_evidence_count,evidence_set_digest,closure_digest,closed_at)
       VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,1,NULL,1,$8,$9,$10::timestamptz)`,
      [fixture.closureRef, fixture.siteId, fixture.rootRef, fixture.allocationRef,
        fixture.authorizationSegmentRef, fixture.holdRef, fixture.manifestRef,
        createHash("sha256").update(fixture.evidenceRef).digest("hex"),
        createHash("sha256").update(`closure:${fixture.siteId}`).digest("hex"), now],
    );
    await client.query(
      `INSERT INTO platform.credit_usage_closure_evidence
       (closure_ref,site_ref,authorization_segment_ref,evidence_ref,evidence_ordinal)
       VALUES ($1::uuid,$2,$3::uuid,$4::uuid,0)`,
      [fixture.closureRef, fixture.siteId, fixture.authorizationSegmentRef, fixture.evidenceRef],
    );
    await client.query(
      `INSERT INTO platform.credit_rating_snapshot
       (rating_snapshot_ref,site_ref,authorization_segment_ref,rating_policy_revision_ref,
        unit,snapshot,snapshot_digest,created_at)
       VALUES ($1::uuid,$2,$3::uuid,$4,'credit_micros','{}'::jsonb,$5,$6::timestamptz)`,
      [fixture.ratingSnapshotRef, fixture.siteId, fixture.authorizationSegmentRef,
        fixture.ratingPolicyRevisionRef,
        createHash("sha256").update(`snapshot:${fixture.siteId}`).digest("hex"), now],
    );
    if (fixture.captureJournalRef !== null) {
      await insertRootClosureJournal(client, fixture, {
        journalRef: fixture.captureJournalRef,
        businessOperationKey: `capture-${fixture.settlementRef}`,
        operationKind: "hold_capture",
        entries: captureEntries,
      });
      await insertRootClosureJournalEntries(client, fixture.captureJournalRef, captureEntries);
    }
    await client.query(
      `INSERT INTO platform.credit_usage_settlement
       (settlement_ref,site_ref,execution_budget_root_ref,budget_allocation_ref,
        authorization_segment_ref,credit_hold_ref,credit_account_ref,unit,closure_ref,
        closure_revision,prior_settlement_ref,rating_snapshot_ref,policy_rated_amount,
        segment_maximum_amount,customer_amount,platform_exposure_amount,journal_transaction_ref,settled_at)
       VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,'credit_micros',
               $8::uuid,1,NULL,$9::uuid,$10::numeric,100,$10::numeric,0,$11::uuid,$12::timestamptz)`,
      [fixture.settlementRef, fixture.siteId, fixture.rootRef, fixture.allocationRef,
        fixture.authorizationSegmentRef, fixture.holdRef, fixture.creditAccountRef,
        fixture.closureRef, fixture.ratingSnapshotRef, fixture.capturedAmount.toString(),
        fixture.captureJournalRef, now],
    );
    if (fixture.capturedAmount > 0n) {
      await client.query(
        `INSERT INTO platform.credit_usage_settlement_source
         (settlement_ref,source_ordinal,site_ref,authorization_segment_ref,credit_hold_ref,
          credit_grant_id,credit_account_ref,unit,allocation_ordinal,direction,amount)
         VALUES ($1::uuid,0,$2,$3::uuid,$4::uuid,$5::uuid,$6::uuid,'credit_micros',0,'capture',$7::numeric)`,
        [fixture.settlementRef, fixture.siteId, fixture.authorizationSegmentRef,
          fixture.holdRef, fixture.creditGrantRef, fixture.creditAccountRef,
          fixture.capturedAmount.toString()],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

type RootClosureJournalEntry = Readonly<{
  ordinal: number;
  siteId: string;
  creditAccountId: string;
  unit: "credit_micros";
  side: "credit" | "debit";
  accountType: "grant_issuance_source" | "customer_available" | "customer_reserved" |
    "customer_consumed";
  amount: string;
  creditGrantId: string;
  creditHoldRef: string | null;
}>;

function rootClosureJournalEntries(
  fixture: CreditRootClosureFixture,
  entries: readonly Readonly<[
    ordinal: number,
    side: RootClosureJournalEntry["side"],
    accountType: RootClosureJournalEntry["accountType"],
    amount: bigint,
    creditHoldRef: string | null,
  ]>[],
): readonly RootClosureJournalEntry[] {
  return entries.map(([ordinal, side, accountType, amount, creditHoldRef]) => Object.freeze({
    ordinal,
    siteId: fixture.siteId,
    creditAccountId: fixture.creditAccountRef,
    unit: "credit_micros" as const,
    side,
    accountType,
    amount: amount.toString(),
    creditGrantId: fixture.creditGrantRef,
    creditHoldRef,
  }));
}

async function insertRootClosureJournal(
  client: Client,
  fixture: CreditRootClosureFixture,
  input: Readonly<{
    journalRef: string;
    businessOperationKey: string;
    operationKind: "grant_issue" | "hold_reserve" | "hold_capture";
    entries: readonly RootClosureJournalEntry[];
  }>,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.credit_journal_transaction
     (journal_transaction_ref,credit_account_ref,site_ref,unit,business_operation_key,
      request_digest,operation_kind,expected_entry_count,entries_digest,occurred_at)
     VALUES ($1::uuid,$2::uuid,$3,'credit_micros',$4,$5,$6,$7,$8,$9::timestamptz)`,
    [input.journalRef, fixture.creditAccountRef, fixture.siteId, input.businessOperationKey,
      createHash("sha256").update(`request:${input.businessOperationKey}`).digest("hex"),
      input.operationKind, input.entries.length, creditJournalEntriesDigest(input.entries),
      "2026-08-27T11:59:00.000Z"],
  );
}

async function insertRootClosureJournalEntries(
  client: Client,
  journalRef: string,
  entries: readonly RootClosureJournalEntry[],
): Promise<void> {
  for (const entry of entries) {
    await client.query(
      `INSERT INTO platform.credit_journal_entry
       (journal_transaction_ref,entry_ordinal,site_ref,credit_account_ref,unit,entry_side,
        account_type,amount,credit_grant_id,credit_hold_ref)
       VALUES ($1::uuid,$2,$3,$4::uuid,'credit_micros',$5,$6,$7::numeric,$8::uuid,$9::uuid)`,
      [journalRef, entry.ordinal, entry.siteId, entry.creditAccountId, entry.side,
        entry.accountType, entry.amount, entry.creditGrantId, entry.creditHoldRef],
    );
  }
}

export async function readCreditRootClosureInventory(
  client: Client,
  fixture: CreditRootClosureFixture,
): Promise<CreditRootClosureInventory> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.site_id',$1,true)", [fixture.siteId]);
    const result = await client.query<CreditRootClosureInventory>(
      `SELECT allocation.current_revision::text AS "allocationRevision",
              allocation.current_allocation_epoch::text AS "allocationEpoch",
              revision.state AS "allocationState",root.state AS "rootState",
              root.aggregate_version::text AS "rootVersion",hold.state AS "holdState",
              hold.fence_epoch::text AS "holdFence",hold.captured_amount::text AS "capturedAmount",
              hold.released_amount::text AS "releasedAmount",
              (SELECT count(*)::text FROM platform.credit_execution_root_closure_receipt
                WHERE site_ref=$1 AND business_operation_key=$4) AS "closureCount",
              (SELECT count(*)::text FROM platform.credit_execution_root_reconciliation
                WHERE site_ref=$1 AND business_operation_key=$4) AS "reconciliationCount",
              (SELECT count(*)::text FROM platform.credit_execution_root_outcome
                WHERE site_ref=$1 AND business_operation_key=$4) AS "outcomeCount",
              (SELECT count(*)::text FROM platform.credit_journal_transaction
                WHERE site_ref=$1 AND business_operation_key=$4 AND operation_kind='hold_release')
                AS "releaseJournalCount"
         FROM platform.credit_execution_budget_root root
         JOIN platform.credit_hold hold ON hold.credit_hold_ref=root.credit_hold_ref
           AND hold.site_ref=root.site_ref
         JOIN platform.credit_budget_allocation allocation
           ON allocation.budget_allocation_ref=root.root_allocation_ref
           AND allocation.site_ref=root.site_ref
         JOIN platform.credit_budget_allocation_revision revision
           ON revision.budget_allocation_ref=allocation.budget_allocation_ref
           AND revision.revision=allocation.current_revision
        WHERE root.site_ref=$1 AND root.execution_budget_root_ref=$2::uuid
          AND hold.credit_hold_ref=$3::uuid`,
      [fixture.siteId, fixture.rootRef, fixture.holdRef, fixture.businessOperationKey],
    );
    if (result.rows.length !== 1) throw new Error("CREDIT_ROOT_CLOSURE_FIXTURE_INVENTORY_INVALID");
    return result.rows[0]!;
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
  }
}


function pgTransaction(client: Client): PlatformSqlTransaction {
  return {
    async query<Row extends Record<string, unknown>>(statement: string, values?: readonly unknown[]) {
      return (await client.query<Row>(statement, values as unknown[] | undefined)).rows;
    },
    async execute(statement: string, values?: readonly unknown[]) {
      return (await client.query(statement, values as unknown[] | undefined)).rowCount ?? 0;
    },
  };
}
