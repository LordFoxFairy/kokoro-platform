import { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { runPlatformMigrations } from "../../src/infrastructure/postgres/migrator.js";
import {
  creditRootClosureFixture,
  creditRootClosureRequest,
  executeCreditRootClosure,
  readCreditRootClosureInventory,
  seedCreditRootClosure,
} from "./support/credit-execution-root-closure-fixture.js";

const bootstrapDatabaseUrl = leased(process.env.DATABASE_URL_PLATFORM_BOOTSTRAP_TEST);
const admissionDatabaseUrl = leased(process.env.DATABASE_URL_PLATFORM_ADMISSION_TEST);
const apiDatabaseUrl = leased(process.env.DATABASE_URL_PLATFORM_API_TEST);
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
