import { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { runPlatformMigrations } from "../../src/infrastructure/postgres/migrator.js";
import {
  creditRootClosureFixture,
  creditRootClosureRequest,
  creditUsageRevisionFixture,
  executeCreditRootClosure,
  finalizeCreditUsageRevision,
  readCreditRootClosureInventory,
  readCreditUsageCorrectionInventory,
  seedCreditRootClosure,
  settleCreditUsageRevision,
} from "./support/credit-execution-root-closure-fixture.js";

const bootstrapDatabaseUrl = leased(process.env.DATABASE_URL_PLATFORM_BOOTSTRAP_TEST);
const admissionDatabaseUrl = leased(process.env.DATABASE_URL_PLATFORM_ADMISSION_TEST);
const apiDatabaseUrl = leased(process.env.DATABASE_URL_PLATFORM_API_TEST);
const modelGatewayDatabaseUrl = leased(process.env.DATABASE_URL_PLATFORM_MODEL_GATEWAY_TEST);
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

describe("Credit execution-root closure PostgreSQL authority", () => {
  beforeAll(async () => {
    await runPlatformMigrations({ environment: process.env });
  }, 60_000);

  for (const capturedAmount of [25n, 0n] as const) {
    it(`atomically closes a ${capturedAmount === 0n ? "zero" : "positive"}-cost root`, async () => {
      const fixture = creditRootClosureFixture({ capturedAmount });
      const bootstrap = new Client({ connectionString: bootstrapDatabaseUrl });
      const admission = new Client({ connectionString: admissionDatabaseUrl });
      await Promise.all([bootstrap.connect(), admission.connect()]);
      try {
        await seedCreditRootClosure(bootstrap, fixture);
        await expect(executeCreditRootClosure(admission, fixture)).resolves.toEqual({
          kind: "accepted",
          value: {
            allocationClosureReceiptRef: expect.stringMatching(UUID_PATTERN),
            capturedAmount,
            releasedAmount: 100n - capturedAmount,
          },
        });
        await expect(readCreditRootClosureInventory(bootstrap, fixture)).resolves.toEqual({
          allocationRevision: "4",
          allocationEpoch: "2",
          allocationState: "terminal",
          rootState: "settled",
          rootVersion: "2",
          holdState: capturedAmount === 0n ? "released" : "settled",
          holdFence: capturedAmount === 0n ? "2" : "3",
          capturedAmount: capturedAmount.toString(),
          releasedAmount: (100n - capturedAmount).toString(),
          closureCount: "1",
          reconciliationCount: "0",
          outcomeCount: "1",
          releaseJournalCount: "1",
        });
      } finally {
        await Promise.allSettled([bootstrap.end(), admission.end()]);
      }
    });
  }

  it("keeps corrected Usage as one net financial authority through root closure", async () => {
    const fixture = creditRootClosureFixture({ capturedAmount: 25n });
    const bootstrap = new Client({ connectionString: bootstrapDatabaseUrl });
    const modelGateway = new Client({ connectionString: modelGatewayDatabaseUrl });
    const firstAdmission = new Client({ connectionString: admissionDatabaseUrl });
    const secondAdmission = new Client({ connectionString: admissionDatabaseUrl });
    await Promise.all([
      bootstrap.connect(), modelGateway.connect(), firstAdmission.connect(), secondAdmission.connect(),
    ]);
    try {
      const settle = (owner: Client, revision: Parameters<typeof settleCreditUsageRevision>[2]) =>
        settleCreditUsageRevision(owner, fixture, revision);
      const sourceAuthority = await bootstrap.query<{
        admissionCanSelect: boolean;
        admissionCanInsert: boolean;
        admissionCanUpdate: boolean;
        admissionCanUpdateAnyColumn: boolean;
        sourceFencesEnabled: boolean;
      }>(
        `SELECT has_table_privilege($1,'platform.credit_hold_allocation','SELECT')
                  AS "admissionCanSelect",
                has_table_privilege($1,'platform.credit_hold_allocation','INSERT')
                  AS "admissionCanInsert",
                has_table_privilege($1,'platform.credit_hold_allocation','UPDATE')
                  AS "admissionCanUpdate",
                has_any_column_privilege($1,'platform.credit_hold_allocation','UPDATE')
                  AS "admissionCanUpdateAnyColumn",
                count(*)=3 AND bool_and(trigger.tgenabled<>'D') AS "sourceFencesEnabled"
           FROM pg_catalog.pg_trigger trigger
          WHERE (trigger.tgrelid='platform.credit_hold'::regclass
              AND trigger.tgname=$2::text)
             OR (trigger.tgrelid='platform.credit_hold_allocation'::regclass
              AND trigger.tgname=ANY($3::text[]))`,
        [new URL(admissionDatabaseUrl).username, "credit_hold_fully_allocated_from_hold", [
          "credit_hold_allocation_immutable",
          "credit_hold_fully_allocated_from_allocation",
        ]],
      );
      expect(sourceAuthority.rows).toEqual([{
        admissionCanSelect: true,
        admissionCanInsert: true,
        admissionCanUpdate: false,
        admissionCanUpdateAnyColumn: false,
        sourceFencesEnabled: true,
      }]);
      await firstAdmission.query("BEGIN");
      try {
        await firstAdmission.query(
          "SELECT platform.begin_admission_transaction('admission.command')",
        );
        await firstAdmission.query("SELECT set_config('app.site_id',$1,true)", [fixture.siteId]);
        await expect(firstAdmission.query(
          `UPDATE platform.credit_hold_allocation
              SET allocation_ordinal=allocation_ordinal
            WHERE site_ref=$1 AND credit_hold_ref=$2::uuid`,
          [fixture.siteId, fixture.holdRef],
        )).rejects.toMatchObject({ code: "42501" });
      } finally {
        await firstAdmission.query("ROLLBACK").catch(() => undefined);
      }
      await seedCreditRootClosure(bootstrap, fixture, { usageState: "committed" });
      const capture = creditUsageRevisionFixture(fixture, {
        evidenceRef: fixture.evidenceRef,
        revision: 1n,
        correctionOfEvidenceRef: null,
        amount: 25n,
        closureRef: fixture.closureRef,
        closureRevision: 1n,
        correctionOfClosureRef: null,
      });
      const captured = await settle(firstAdmission, capture);
      expect(captured).toMatchObject({
        kind: "accepted",
        value: { closureRevision: 1n, customerAmount: 25n },
      });
      await expect(settle(firstAdmission, capture)).resolves.toEqual({
        kind: "replayed",
        value: captured.kind === "accepted" ? captured.value : expect.anything(),
      });
      await expect(readCreditUsageCorrectionInventory(bootstrap, fixture)).resolves.toMatchObject({
        allocationRevision: "3",
        allocationEpoch: "1",
        unassignedStock: "75",
        capturedCumulative: "25",
        holdFence: "2",
        capturedAmount: "25",
        signedCustomerConsumed: "25",
        usageJournalCount: "1",
        correctionJournalCount: "0",
        settlementCount: "1",
        settlementJournalCount: "1",
        settlementSourceCount: "1",
        settleReceiptCount: "1",
      });

      const decrease = creditUsageRevisionFixture(fixture, {
        revision: 2n,
        correctionOfEvidenceRef: capture.evidenceRef,
        amount: 10n,
        closureRevision: 2n,
        correctionOfClosureRef: capture.closureRef,
      });
      await expect(finalizeCreditUsageRevision(modelGateway, fixture, decrease, 1n)).resolves.toEqual({
        kind: "invalid_state",
        code: "CREDIT_USAGE_ATTEMPT_FENCE_STALE",
      });
      await expect(finalizeCreditUsageRevision(modelGateway, fixture, decrease, 2n)).resolves.toEqual({
        kind: "accepted",
        value: { evidenceRef: decrease.evidenceRef, revision: 2n },
      });
      const skippedClosure = creditUsageRevisionFixture(fixture, {
        evidenceRef: decrease.evidenceRef,
        revision: 2n,
        correctionOfEvidenceRef: capture.evidenceRef,
        amount: 10n,
        closureRevision: 3n,
        correctionOfClosureRef: capture.closureRef,
      });
      await expect(settle(firstAdmission, skippedClosure)).resolves.toEqual({
        kind: "invalid_state",
        code: "CREDIT_USAGE_CLOSURE_CHAIN_INVALID",
      });
      await bootstrap.query("BEGIN");
      await bootstrap.query("SELECT set_config('app.site_id',$1,true)", [fixture.siteId]);
      await bootstrap.query(
        `INSERT INTO platform.credit_budget_allocation_revision
         (allocation_revision_ref,budget_allocation_ref,execution_budget_root_ref,site_ref,
          billing_account_ref,credit_account_ref,unit,liability_merchant_account_ref,
          revision,allocation_epoch,credit_ceiling,unassigned_stock,active_child_reserved_stock,
          committed_stock,captured_cumulative,returned_to_parent_cumulative,state)
         SELECT gen_random_uuid(),prior.budget_allocation_ref,prior.execution_budget_root_ref,
                prior.site_ref,prior.billing_account_ref,prior.credit_account_ref,prior.unit,
                prior.liability_merchant_account_ref,prior.revision+1,prior.allocation_epoch,
                prior.credit_ceiling,prior.unassigned_stock,prior.active_child_reserved_stock,
                prior.committed_stock,prior.captured_cumulative,prior.returned_to_parent_cumulative,'returning'
           FROM platform.credit_budget_allocation_revision prior
          WHERE prior.site_ref=$1 AND prior.budget_allocation_ref=$2::uuid AND prior.revision=3`,
        [fixture.siteId, fixture.allocationRef],
      );
      await expect(bootstrap.query(
        `INSERT INTO platform.credit_budget_allocation_revision
         (allocation_revision_ref,budget_allocation_ref,execution_budget_root_ref,site_ref,
          billing_account_ref,credit_account_ref,unit,liability_merchant_account_ref,
          revision,allocation_epoch,credit_ceiling,unassigned_stock,active_child_reserved_stock,
          committed_stock,captured_cumulative,returned_to_parent_cumulative,state)
         SELECT gen_random_uuid(),prior.budget_allocation_ref,prior.execution_budget_root_ref,
                prior.site_ref,prior.billing_account_ref,prior.credit_account_ref,prior.unit,
                prior.liability_merchant_account_ref,prior.revision+1,prior.allocation_epoch,
                prior.credit_ceiling,90,prior.active_child_reserved_stock,
                prior.committed_stock,10,prior.returned_to_parent_cumulative,prior.state
           FROM platform.credit_budget_allocation_revision prior
          WHERE prior.site_ref=$1 AND prior.budget_allocation_ref=$2::uuid AND prior.revision=4`,
        [fixture.siteId, fixture.allocationRef],
      )).rejects.toMatchObject({
        code: "23514",
        message: "CREDIT_ALLOCATION_CAPTURE_CORRECTION_INVALID",
      });
      await bootstrap.query("ROLLBACK");
      for (const drift of [
        { epoch: "1", unassigned: "90", activeChild: "1", committed: "0", returned: "0", state: "active" },
        { epoch: "1", unassigned: "90", activeChild: "0", committed: "1", returned: "0", state: "active" },
        { epoch: "1", unassigned: "90", activeChild: "0", committed: "0", returned: "1", state: "active" },
        { epoch: "2", unassigned: "90", activeChild: "0", committed: "0", returned: "0", state: "active" },
        { epoch: "1", unassigned: "90", activeChild: "0", committed: "0", returned: "0",
          state: "reconciliation_required" },
      ] as const) {
        await bootstrap.query("BEGIN");
        await bootstrap.query("SELECT set_config('app.site_id',$1,true)", [fixture.siteId]);
        await expect(bootstrap.query(
          `INSERT INTO platform.credit_budget_allocation_revision
           (allocation_revision_ref,budget_allocation_ref,execution_budget_root_ref,site_ref,
            billing_account_ref,credit_account_ref,unit,liability_merchant_account_ref,
            revision,allocation_epoch,credit_ceiling,unassigned_stock,active_child_reserved_stock,
            committed_stock,captured_cumulative,returned_to_parent_cumulative,state)
           SELECT gen_random_uuid(),prior.budget_allocation_ref,prior.execution_budget_root_ref,
                  prior.site_ref,prior.billing_account_ref,prior.credit_account_ref,prior.unit,
                  prior.liability_merchant_account_ref,prior.revision+1,$3::bigint,
                  prior.credit_ceiling,$4::numeric,$5::numeric,$6::numeric,10,$7::numeric,$8
             FROM platform.credit_budget_allocation_revision prior
            WHERE prior.site_ref=$1 AND prior.budget_allocation_ref=$2::uuid AND prior.revision=3`,
          [fixture.siteId, fixture.allocationRef, drift.epoch, drift.unassigned,
            drift.activeChild, drift.committed, drift.returned, drift.state],
        )).rejects.toMatchObject({
          code: "23514",
          message: "CREDIT_ALLOCATION_CAPTURE_CORRECTION_INVALID",
        });
        await bootstrap.query("ROLLBACK");
      }
      const concurrentDecrease = await Promise.all([
        settle(firstAdmission, decrease),
        settle(secondAdmission, decrease),
      ]);
      expect(concurrentDecrease.map((result) => result.kind).sort()).toEqual(["accepted", "replayed"]);
      await expect(settle(firstAdmission, decrease)).resolves.toMatchObject({
        kind: "replayed",
        value: { closureRevision: 2n, customerAmount: 10n },
      });
      await expect(readCreditUsageCorrectionInventory(bootstrap, fixture)).resolves.toMatchObject({
        allocationRevision: "4",
        allocationEpoch: "1",
        creditCeiling: "100",
        unassignedStock: "90",
        activeChildReservedStock: "0",
        committedStock: "0",
        capturedCumulative: "10",
        returnedToParentCumulative: "0",
        allocationState: "active",
        rootState: "open",
        rootVersion: "1",
        holdState: "open",
        holdFence: "3",
        capturedAmount: "10",
        releasedAmount: "0",
        signedCustomerConsumed: "10",
        usageJournalCount: "2",
        correctionJournalCount: "1",
        settlementCount: "2",
        settlementJournalCount: "2",
        settlementSourceCount: "2",
        evidenceCount: "2",
        settleReceiptCount: "2",
      });

      const zeroDelta = creditUsageRevisionFixture(fixture, {
        revision: 3n,
        correctionOfEvidenceRef: decrease.evidenceRef,
        amount: 10n,
        closureRevision: 3n,
        correctionOfClosureRef: decrease.closureRef,
      });
      await expect(finalizeCreditUsageRevision(modelGateway, fixture, zeroDelta, 3n)).resolves.toEqual({
        kind: "accepted",
        value: { evidenceRef: zeroDelta.evidenceRef, revision: 3n },
      });
      const beforeZeroDelta = await readCreditUsageCorrectionInventory(bootstrap, fixture);
      await expect(settle(firstAdmission, zeroDelta)).resolves.toMatchObject({
        kind: "accepted",
        value: { closureRevision: 3n, customerAmount: 10n },
      });
      const afterZeroDelta = await readCreditUsageCorrectionInventory(bootstrap, fixture);
      expect(afterZeroDelta).toMatchObject({
        allocationRevision: beforeZeroDelta.allocationRevision,
        allocationRevisionCount: beforeZeroDelta.allocationRevisionCount,
        allocationEpoch: beforeZeroDelta.allocationEpoch,
        creditCeiling: beforeZeroDelta.creditCeiling,
        unassignedStock: beforeZeroDelta.unassignedStock,
        activeChildReservedStock: beforeZeroDelta.activeChildReservedStock,
        committedStock: beforeZeroDelta.committedStock,
        capturedCumulative: beforeZeroDelta.capturedCumulative,
        returnedToParentCumulative: beforeZeroDelta.returnedToParentCumulative,
        allocationState: beforeZeroDelta.allocationState,
        holdState: beforeZeroDelta.holdState,
        holdFence: beforeZeroDelta.holdFence,
        capturedAmount: beforeZeroDelta.capturedAmount,
        releasedAmount: beforeZeroDelta.releasedAmount,
        signedCustomerConsumed: beforeZeroDelta.signedCustomerConsumed,
        usageJournalCount: beforeZeroDelta.usageJournalCount,
        correctionJournalCount: beforeZeroDelta.correctionJournalCount,
        settlementCount: "3",
        settlementJournalCount: beforeZeroDelta.settlementJournalCount,
        settlementSourceCount: beforeZeroDelta.settlementSourceCount,
        evidenceCount: "3",
        settleReceiptCount: "3",
      });

      const increase = creditUsageRevisionFixture(fixture, {
        revision: 4n,
        correctionOfEvidenceRef: zeroDelta.evidenceRef,
        amount: 20n,
        closureRevision: 4n,
        correctionOfClosureRef: zeroDelta.closureRef,
      });
      await expect(finalizeCreditUsageRevision(modelGateway, fixture, increase, 4n)).resolves.toEqual({
        kind: "accepted",
        value: { evidenceRef: increase.evidenceRef, revision: 4n },
      });
      const increased = await settle(firstAdmission, increase);
      expect(increased).toMatchObject({
        kind: "accepted",
        value: { closureRevision: 4n, customerAmount: 20n },
      });
      if (increased.kind !== "accepted") throw new Error("CREDIT_USAGE_INCREASE_SETTLEMENT_MISSING");

      await bootstrap.query("BEGIN");
      await bootstrap.query("SELECT set_config('app.site_id',$1,true)", [fixture.siteId]);
      await bootstrap.query(
        `UPDATE platform.credit_hold
            SET captured_amount=captured_amount-1,fence_epoch=fence_epoch+1,
                updated_at='2026-08-27T12:10:00.000Z'
          WHERE site_ref=$1 AND credit_hold_ref=$2::uuid`,
        [fixture.siteId, fixture.holdRef],
      );
      await expect(bootstrap.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toMatchObject({
        code: "23514",
        message: "CREDIT_HOLD_JOURNAL_TOTAL_MISMATCH",
      });
      await bootstrap.query("ROLLBACK");

      for (const mutation of [
        {
          statement: `UPDATE platform.credit_usage_settlement SET customer_amount=customer_amount+1
            WHERE site_ref=$1 AND settlement_ref=$2::uuid`,
          values: [fixture.siteId, increased.value.settlementRef],
        },
        {
          statement: `UPDATE platform.credit_journal_transaction SET occurred_at=occurred_at+interval '1 second'
            WHERE site_ref=$1 AND operation_kind='correction'`,
          values: [fixture.siteId],
        },
        {
          statement: `UPDATE platform.credit_budget_allocation_revision SET captured_cumulative=captured_cumulative+1
            WHERE site_ref=$1 AND budget_allocation_ref=$2::uuid AND revision=4`,
          values: [fixture.siteId, fixture.allocationRef],
        },
      ] as const) {
        await bootstrap.query("BEGIN");
        await bootstrap.query("SELECT set_config('app.site_id',$1,true)", [fixture.siteId]);
        await expect(bootstrap.query(mutation.statement, [...mutation.values]))
          .rejects.toMatchObject({ code: "23000" });
        await bootstrap.query("ROLLBACK");
      }

      const closure = creditRootClosureRequest(fixture, {
        settlement: {
          settlementRef: increased.value.settlementRef,
          closureRef: increased.value.closureRef,
          closureRevision: increased.value.closureRevision,
          customerAmount: increased.value.customerAmount,
        },
      });
      await expect(executeCreditRootClosure(firstAdmission, fixture, closure)).resolves.toMatchObject({
        kind: "accepted",
        value: { capturedAmount: 20n, releasedAmount: 80n },
      });
      await expect(readCreditUsageCorrectionInventory(bootstrap, fixture)).resolves.toEqual({
        allocationRevision: "6",
        allocationEpoch: "2",
        creditCeiling: "100",
        unassignedStock: "0",
        activeChildReservedStock: "0",
        committedStock: "0",
        capturedCumulative: "20",
        returnedToParentCumulative: "80",
        allocationState: "terminal",
        allocationRevisionCount: "6",
        rootState: "settled",
        rootVersion: "2",
        holdState: "settled",
        holdFence: "5",
        capturedAmount: "20",
        releasedAmount: "80",
        signedCustomerConsumed: "20",
        usageJournalCount: "3",
        correctionJournalCount: "2",
        settlementCount: "4",
        settlementJournalCount: "3",
        settlementSourceCount: "3",
        evidenceCount: "4",
        settleReceiptCount: "4",
      });
    } finally {
      await Promise.allSettled([
        bootstrap.query("ROLLBACK"), modelGateway.query("ROLLBACK"),
        firstAdmission.query("ROLLBACK"), secondAdmission.query("ROLLBACK"),
      ]);
      await Promise.allSettled([
        bootstrap.end(), modelGateway.end(), firstAdmission.end(), secondAdmission.end(),
      ]);
    }
  }, 60_000);

  it("keeps raw Admission terminal transitions denied even with a spoofed closure marker", async () => {
    const fixture = creditRootClosureFixture({ capturedAmount: 25n });
    const bootstrap = new Client({ connectionString: bootstrapDatabaseUrl });
    const admission = new Client({ connectionString: admissionDatabaseUrl });
    await Promise.all([bootstrap.connect(), admission.connect()]);
    try {
      await seedCreditRootClosure(bootstrap, fixture);
      await admission.query("BEGIN");
      await admission.query("SELECT platform.begin_admission_transaction('admission.command')");
      await admission.query(
        `SELECT set_config('app.site_id',$1,true),
                set_config('app.credit_execution_root_closure_transition','commit',true)`,
        [fixture.siteId],
      );
      await expect(admission.query(
        `UPDATE platform.credit_hold
            SET released_amount=75,state='settled',resolution_kind='known_outcome',
                resolution_ref='spoofed-direct-transition',fence_epoch=fence_epoch+1,
                settled_at='2026-08-27T12:00:00.000Z',updated_at='2026-08-27T12:00:00.000Z'
          WHERE credit_hold_ref=$1::uuid AND site_ref=$2`,
        [fixture.holdRef, fixture.siteId],
      )).rejects.toMatchObject({ code: "23514", message: "CREDIT_HOLD_TRANSITION_INVALID" });
      await admission.query("ROLLBACK");

      await admission.query("BEGIN");
      await admission.query("SELECT platform.begin_admission_transaction('admission.command')");
      await admission.query(
        `SELECT set_config('app.site_id',$1,true),
                set_config('app.credit_execution_root_closure_transition','commit',true)`,
        [fixture.siteId],
      );
      const identity = await admission.query<{ current_user: string; session_user: string }>(
        "SELECT current_user,session_user",
      );
      expect(identity.rows).toEqual([{
        current_user: new URL(admissionDatabaseUrl).username,
        session_user: new URL(admissionDatabaseUrl).username,
      }]);
      await expect(admission.query(
        `UPDATE platform.credit_execution_budget_root
            SET state='settled',aggregate_version=aggregate_version+1,
                updated_at='2026-08-27T12:00:00.000Z'
          WHERE execution_budget_root_ref=$1::uuid AND site_ref=$2`,
        [fixture.rootRef, fixture.siteId],
      )).rejects.toMatchObject({
        code: "23514",
        message: "CREDIT_EXECUTION_BUDGET_ROOT_TRANSITION_INVALID",
      });
      await admission.query("ROLLBACK");

      await expect(readCreditRootClosureInventory(bootstrap, fixture)).resolves.toMatchObject({
        allocationRevision: "3",
        rootState: "open",
        holdState: "open",
        closureCount: "0",
        outcomeCount: "0",
        releaseJournalCount: "0",
      });
    } finally {
      await admission.query("ROLLBACK").catch(() => undefined);
      await Promise.allSettled([bootstrap.end(), admission.end()]);
    }
  });

  it("replays a committed closure after its caller loses the response", async () => {
    const fixture = creditRootClosureFixture({ capturedAmount: 25n });
    const bootstrap = new Client({ connectionString: bootstrapDatabaseUrl });
    const admission = new Client({ connectionString: admissionDatabaseUrl });
    await Promise.all([bootstrap.connect(), admission.connect()]);
    try {
      await seedCreditRootClosure(bootstrap, fixture);
      let acceptedReceiptRef: string | undefined;
      await expect((async () => {
        const accepted = await executeCreditRootClosure(admission, fixture);
        if (accepted.kind !== "accepted") throw new Error("CREDIT_CLOSURE_ACCEPTED_RECEIPT_MISSING");
        acceptedReceiptRef = accepted.value.allocationClosureReceiptRef;
        throw new Error("SIMULATED_COMMIT_RESPONSE_LOSS");
      })()).rejects.toThrow("SIMULATED_COMMIT_RESPONSE_LOSS");
      expect(acceptedReceiptRef).toMatch(UUID_PATTERN);
      await expect(executeCreditRootClosure(admission, fixture)).resolves.toEqual({
        kind: "replayed",
        value: {
          allocationClosureReceiptRef: acceptedReceiptRef,
          capturedAmount: 25n,
          releasedAmount: 75n,
        },
      });
      await expect(readCreditRootClosureInventory(bootstrap, fixture)).resolves.toMatchObject({
        allocationRevision: "4",
        closureCount: "1",
        outcomeCount: "1",
        releaseJournalCount: "1",
      });
    } finally {
      await Promise.allSettled([bootstrap.end(), admission.end()]);
    }
  });

  it("rejects a stale source allocation fence without leaving closure facts", async () => {
    const fixture = creditRootClosureFixture({ capturedAmount: 25n });
    const bootstrap = new Client({ connectionString: bootstrapDatabaseUrl });
    const admission = new Client({ connectionString: admissionDatabaseUrl });
    await Promise.all([bootstrap.connect(), admission.connect()]);
    try {
      await seedCreditRootClosure(bootstrap, fixture);
      const stale = creditRootClosureRequest(fixture, { rootAllocationRevision: 2n });
      await expect(executeCreditRootClosure(admission, fixture, stale)).resolves.toEqual({
        kind: "not_found",
      });
      await expect(readCreditRootClosureInventory(bootstrap, fixture)).resolves.toMatchObject({
        allocationRevision: "3",
        allocationEpoch: "1",
        allocationState: "active",
        rootState: "open",
        rootVersion: "1",
        holdState: "open",
        holdFence: "2",
        releasedAmount: "0",
        closureCount: "0",
        reconciliationCount: "0",
        outcomeCount: "0",
        releaseJournalCount: "0",
      });
    } finally {
      await Promise.allSettled([bootstrap.end(), admission.end()]);
    }
  });

  it("records rating mismatch reconciliation without a duplicate head CAS", async () => {
    const fixture = creditRootClosureFixture({ capturedAmount: 25n, allocationCapturedAmount: 24n });
    const bootstrap = new Client({ connectionString: bootstrapDatabaseUrl });
    const admission = new Client({ connectionString: admissionDatabaseUrl });
    await Promise.all([bootstrap.connect(), admission.connect()]);
    try {
      await seedCreditRootClosure(bootstrap, fixture);
      const first = await executeCreditRootClosure(admission, fixture);
      expect(first).toEqual({
        kind: "reconciliation_required",
        reconciliationReceiptRef: expect.stringMatching(UUID_PATTERN),
        code: "CREDIT_EXECUTION_ROOT_RATING_MISMATCH",
      });
      if (first.kind !== "reconciliation_required") {
        throw new Error("CREDIT_RECONCILIATION_RECEIPT_MISSING");
      }
      await expect(executeCreditRootClosure(admission, fixture)).resolves.toEqual({
        kind: "reconciliation_required",
        reconciliationReceiptRef: first.reconciliationReceiptRef,
        code: "CREDIT_EXECUTION_ROOT_RATING_MISMATCH",
      });
      await expect(readCreditRootClosureInventory(bootstrap, fixture)).resolves.toEqual({
        allocationRevision: "4",
        allocationEpoch: "2",
        allocationState: "reconciliation_required",
        rootState: "reconciliation_required",
        rootVersion: "2",
        holdState: "reconciliation_required",
        holdFence: "3",
        capturedAmount: "25",
        releasedAmount: "0",
        closureCount: "0",
        reconciliationCount: "1",
        outcomeCount: "1",
        releaseJournalCount: "0",
      });
    } finally {
      await Promise.allSettled([bootstrap.end(), admission.end()]);
    }
  });

  it("preserves exact Media and Admission closure routine ACLs across the forward migration", async () => {
    const bootstrap = new Client({ connectionString: bootstrapDatabaseUrl });
    await bootstrap.connect();
    try {
      const routines = [
        "platform.find_execution_root_closure(text,jsonb,text,character)",
        "platform.lock_execution_root_closure(text,jsonb,text,uuid,uuid,uuid,uuid,uuid,text,bigint,bigint,bigint,numeric,text)",
        "platform.commit_execution_root_closure(jsonb)",
        "platform.mark_execution_root_reconciliation(jsonb)",
      ];
      const result = await bootstrap.query<{
        routine_count: string;
        admission_executes: boolean;
        media_executes: boolean;
        api_executes: boolean;
        public_executes: boolean;
      }>(
        `WITH routine AS (
           SELECT procedure.oid,procedure.proowner,procedure.proacl
             FROM pg_catalog.pg_proc procedure
            WHERE procedure.oid=ANY($1::regprocedure[])
         )
         SELECT count(*)::text AS routine_count,
                bool_and(has_function_privilege($2,routine.oid,'EXECUTE')) AS admission_executes,
                bool_and(has_function_privilege('platform_media_worker',routine.oid,'EXECUTE'))
                  AS media_executes,
                bool_or(has_function_privilege($3,routine.oid,'EXECUTE')) AS api_executes,
                bool_or(EXISTS(SELECT 1
                  FROM aclexplode(COALESCE(routine.proacl,acldefault('f',routine.proowner))) privilege
                 WHERE privilege.grantee=0 AND privilege.privilege_type='EXECUTE')) AS public_executes
           FROM routine`,
        [routines, new URL(admissionDatabaseUrl).username, new URL(apiDatabaseUrl).username],
      );
      expect(result.rows).toEqual([{
        routine_count: "4",
        admission_executes: true,
        media_executes: true,
        api_executes: false,
        public_executes: false,
      }]);
    } finally {
      await bootstrap.end();
    }
  });
});

function leased(value: string | undefined): string {
  if (value === undefined) throw new Error("PLATFORM_POSTGRES_LEASE_URL_REQUIRED");
  const url = new URL(value);
  if (!url.pathname.slice(1).startsWith("kokoro_test_")) {
    throw new Error("DATABASE_URL_PLATFORM_TEST_MUST_BE_LEASED");
  }
  return value;
}
