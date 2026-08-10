import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationPath = "prisma/migrations/20260812_credit_execution_root_closure/migration.sql";
const admissionAuthorityMigrationPath =
  "prisma/migrations/20260822_admission_execution_root_role_authority/migration.sql";
const closureTransitionFixMigrationPath =
  "prisma/migrations/20260827_credit_execution_root_closure_transition_fix/migration.sql";

describe("Credit execution root closure schema", () => {
  it("persists one recoverable Admission lease transition and fences every transaction epoch", async () => {
    const [migration, schema, client, migrator, lease] = await Promise.all([
      readFile(admissionAuthorityMigrationPath, "utf8"),
      readFile("prisma/schema.prisma", "utf8"),
      readFile("src/infrastructure/postgres/client.ts", "utf8"),
      readFile("src/infrastructure/postgres/migrator.ts", "utf8"),
      readFile("src/infrastructure/postgres/admission-role-lease.ts", "utf8"),
    ]);

    for (const column of [
      "lease_state", "lease_epoch", "pending_role_name", "pending_role_oid",
      "retiring_role_names", "draining_started_at",
    ]) {
      expect(migration).toContain(column);
      expect(schema).toContain(column.replaceAll(/_([a-z])/gu, (_, letter: string) =>
        letter.toUpperCase()));
    }
    expect(migration).toContain("CHECK (lease_state IN ('active','draining'))");
    expect(migration).toContain(
      "CREATE FUNCTION platform.begin_admission_transaction(p_operation TEXT)",
    );
    expect(migration).toContain("current_setting('app.admission_lease_epoch',true)");
    expect(migration).toContain("authority.lease_state='active'");
    expect(migration).toContain("authority.lease_epoch::TEXT");
    expect(client).toContain("platform.begin_admission_transaction($1)");
    const admissionTransaction = client.slice(
      client.indexOf('if (config.role === "admission") {'),
      client.indexOf("const lease = issuePlatformTransaction", client.indexOf(
        'if (config.role === "admission") {',
      )),
    );
    expect(admissionTransaction).toContain("platform.begin_admission_transaction($1)");
    expect(admissionTransaction.indexOf("platform.begin_admission_transaction($1)"))
      .toBeLessThan(admissionTransaction.indexOf("set_config('app.operation'"));

    expect(migrator).toContain("prepareAdmissionRoleLease");
    expect(migrator).toContain("finalizeAdmissionRoleLease");
    expect(migrator).not.toContain("pg_stat_activity");
    expect(lease).toContain("admissionRoleTransitionPrepare");
    expect(lease).toContain("admissionRoleTransitionFinalize");
    expect(lease).toContain("pg_stat_activity");
    expect(lease).toContain("pg_auth_members");
    expect(lease).toContain("PLATFORM_ADMISSION_ROLE_DRAIN_REQUIRED");
    expect(lease).toContain("PLATFORM_ADMISSION_ROLE_TRANSITION_TARGET_MISMATCH");
    expect(lease).toContain("PLATFORM_ADMISSION_ROLE_MEMBERSHIP_INVALID");
    expect(lease).toContain("admissionDefaultAuthorityClosed");
    expect(lease).toContain("retiring_role_names='{}'::TEXT[]");
  });

  it("binds Admission closure authority to the configured database role identity", async () => {
    const migration = await readFile(admissionAuthorityMigrationPath, "utf8");
    expect(migration).toContain("runtime_role_identity_authority_role_kind_check");
    expect(migration).toContain("'admission'");
    for (const existingRoleKind of ["memory_public", "memory_runtime", "memory_worker"]) {
      expect(migration).toContain(`'${existingRoleKind}'`);
    }
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION platform.admission_role_identity_is_current()",
    );
    expect(migration).toContain("authority.role_kind='admission'");
    expect(migration).toContain("runtime_role.rolname=SESSION_USER");
    expect(migration).toContain("runtime_role.oid::BIGINT=authority.role_oid");
    expect(migration).toContain("SECURITY DEFINER SET search_path=pg_catalog,platform");

    for (const relation of [
      "credit_execution_root_closure_receipt",
      "credit_execution_root_reconciliation",
      "credit_execution_root_outcome",
      "admission_verified_terminal_evidence",
    ]) {
      expect(migration).toContain(`ON platform.${relation} TO platform_migrator`);
    }
    expect(migration.match(/platform\.admission_role_identity_is_current\(\)/gu)?.length)
      .toBeGreaterThanOrEqual(7);
    expect(migration).not.toContain("SESSION_USER<>'platform_admission'");
    expect(migration).not.toContain("SESSION_USER='platform_admission'");

    expect(migration).not.toMatch(/\b(?:TO|FROM)\s+platform_admission\b/iu);
  });

  it("keeps closure receipts immutable, conserved and fenced", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).toContain("credit_execution_root_closure_receipt");
    expect(migration).toContain("captured_amount+released_amount=reserved_ceiling");
    expect(migration).toContain("allocation_after_revision=allocation_before_revision+1");
    expect(migration).toContain("hold_after_fence=hold_before_fence+1");
    expect(migration).toContain("CREDIT_EXECUTION_ROOT_FACT_IMMUTABLE");
    expect(migration).not.toMatch(/refund/iu);
  });

  it("exposes exact definer routines to verified Media and Admission owners only", async () => {
    const migration = await readFile(migrationPath, "utf8");
    for (const routine of ["find_execution_root_closure", "lock_execution_root_closure",
      "commit_execution_root_closure", "mark_execution_root_reconciliation"]) {
      expect(migration).toContain(`platform.${routine}`);
    }
    expect(migration).toContain("platform.assert_execution_root_owner_proof");
    expect(migration).toContain("PERFORM platform.assert_media_image_worker_lease(");
    expect(migration).toContain("platform.admission_verified_terminal_evidence");
    expect(migration).toContain("TO platform_media_worker");
    expect(migration).toContain("platform.admission_role_identity_is_current()");
    expect(migration).not.toMatch(/\b(?:TO|FROM)\s+platform_admission\b/iu);
    expect(migration).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)[\s\S]{0,200}\bTO\s+platform_media_worker\b/iu,
    );
  });

  it("accepts only closed bounded commands and independently verifies their digests", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).toContain("credit_direct_root_json_exact_keys");
    expect(migration).toContain("octet_length(p_record::TEXT)");
    expect(migration).not.toContain("pg_column_size(p_record)");
    expect(migration).toMatch(/jsonb_array_length\([^)]*releases[^)]*\)>256/u);
    expect(migration).toContain("credit_direct_root_framed_digest");
    expect(migration).toContain("CREDIT_DIRECT_ROOT_REQUEST_DIGEST_INVALID");
    expect(migration).toContain("CREDIT_DIRECT_ROOT_RECEIPT_DIGEST_INVALID");
    expect(migration).toContain("CREDIT_DIRECT_ROOT_RELEASE_DIGEST_INVALID");
    expect(migration).toContain("CREDIT_DIRECT_ROOT_TIMESTAMP_INVALID");
    expect(migration).toMatch(
      /to_char\(receipt\.recorded_at AT TIME ZONE 'UTC',\s*'YYYY-MM-DD"T"HH24:MI:SS\.MS"Z"'\)/u,
    );
    expect(migration).not.toMatch(/p_record[#-]>>?'?\{?current/iu);
    expect(migration).not.toContain("p_record->'receipt'");
  });

  it("never regresses terminal facts and uses a distinct allocation revision identity", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).toContain("reconciliation_allocation_revision_ref");
    expect(migration).toContain("allocation_after_revision=allocation_before_revision+1");
    expect(migration).toContain("context->>'rootState' NOT IN ('open','closing')");
    expect(migration).toContain("context->>'holdState' NOT IN ('open','closing')");
    expect(migration).toContain("context#>>'{allocation,state}' NOT IN ('active','returning')");
    expect(migration).toContain("CREDIT_DIRECT_ROOT_RECONCILIATION_EVIDENCE_INVALID");
    expect(migration).toContain("CREDIT_EXECUTION_ROOT_SOURCE_AUTHORITY_MISMATCH");
    expect(migration).toContain("CREDIT_EXECUTION_ROOT_RATING_MISMATCH");
    expect(migration).toContain("CREDIT_EXECUTION_ROOT_HOLD_SOURCE_MISMATCH");
  });

  it("looks up closure and reconciliation as one exclusive durable outcome", async () => {
    const migration = await readFile(migrationPath, "utf8");
    const lookup = migration.slice(
      migration.indexOf("CREATE FUNCTION platform.find_execution_root_closure"),
      migration.indexOf("CREATE FUNCTION platform.lock_execution_root_closure"),
    );
    expect(lookup).toContain("credit_execution_root_outcome");
    expect(lookup).toContain("outcome_kind='closure'");
    expect(lookup).toContain("outcome_kind='reconciliation'");
    expect(lookup).toContain("reconciliationReceiptRef");
    expect(lookup).toContain("reconciliation_required");
    expect(lookup).toContain("CREDIT_DIRECT_ROOT_OUTCOME_CORRUPT");
  });

  it("rejects non-canonical digest-bound scalar text before any UUID or numeric cast", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).toContain("credit_direct_root_is_canonical_uuid");
    expect(migration).toContain("credit_direct_root_is_canonical_positive_bigint");
    expect(migration).toContain("credit_direct_root_is_canonical_nonnegative_amount");
    expect(migration).toContain("CREDIT_DIRECT_ROOT_CANONICAL_VALUE_INVALID");
    expect(migration).toMatch(/parsed::TEXT\s*=\s*value/u);
    expect(migration).toMatch(/\^\(0\|\[1-9\]\[0-9\]\*\)\$/u);
    expect(migration).not.toMatch(/\[eE\]/u);
  });

  it("locks and revalidates every financial fence before terminal mutation", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).toMatch(/FOR UPDATE OF root,hold,allocation,revision,segment,settlement/iu);
    expect(migration).toContain("openChildCount");
    expect(migration).toContain("openSegmentCount");
    expect(migration).toContain("openAttemptCount");
    expect(migration).toContain("CREDIT_DIRECT_ROOT_COMMIT_FENCE_INVALID");
    expect(migration).toContain("customer_reserved");
    expect(migration).toContain("customer_available");
  });

  it("binds each source budget without duplicating the common Credit mutation", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).not.toContain(
      "operation.credit_authorization_segment_version=p_authorization_segment_version",
    );
    expect(migration).toContain(
      "'authorizationSegmentVersion',context.authorization_segment_version::TEXT",
    );
    expect(migration).toContain("segment.allocation_epoch AS root_allocation_epoch");
    expect(migration).toContain("segment.aggregate_version AS authorization_segment_version");
    expect(migration).toContain("segment.state='settled'");
    expect(migration).toContain("segment.execution_manifest_ref=p_execution_manifest_ref");
    expect(migration).not.toContain(
      "operation.credit_execution_manifest_ref=p_execution_manifest_ref",
    );
    expect(migration.match(/INSERT INTO platform\.credit_journal_transaction/gu)).toHaveLength(1);
  });

  it("hard-binds each proof kind to its exact database principal and durable owner fact", async () => {
    const migration = await readFile(migrationPath, "utf8");
    const proof = migration.slice(
      migration.indexOf("CREATE FUNCTION platform.assert_execution_root_owner_proof"),
      migration.indexOf("CREATE FUNCTION platform.execution_root_closure_receipt_json"),
    );
    expect(proof).toContain("SESSION_USER<>'platform_media_worker'");
    expect(proof).toContain("NOT platform.admission_role_identity_is_current()");
    expect(proof).toContain("platform.admission_verified_terminal_evidence");
    expect(proof).toContain("terminal_evidence_digest");
    expect(proof).toContain("credit_direct_root_is_reference");
  });

  it("registers closure and reconciliation in one globally unique outcome authority", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).toContain("CREATE TABLE platform.credit_execution_root_outcome");
    expect(migration).toContain("UNIQUE(site_ref,business_operation_key)");
    expect(migration).toContain("UNIQUE(site_ref,source_kind,source_ref)");
    expect(migration).toContain("INSERT INTO platform.credit_execution_root_outcome");
  });

  it("validates an exact replay envelope without nullable SQL comparisons", async () => {
    const migration = await readFile(migrationPath, "utf8");
    const lookup = migration.slice(
      migration.indexOf("CREATE FUNCTION platform.find_execution_root_closure"),
      migration.indexOf("CREATE FUNCTION platform.lock_execution_root_closure"),
    );
    expect(lookup).toContain("assert_execution_root_owner_proof_envelope");
    expect(lookup).toContain("IS DISTINCT FROM");
    expect(lookup).not.toMatch(/\w+\s*<>\s*p_owner_proof/gu);
  });

  it("derives the exact grant release plan inside Credit and supports more than sixteen sources", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).toContain("expected_releases");
    expect(migration).toContain("ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING");
    expect(migration).toContain("expected_releases IS DISTINCT FROM result->'releases'");
    expect(migration).not.toMatch(/jsonb_array_length\([^)]*releases[^)]*\)>16/u);
    expect(migration).toMatch(/jsonb_array_length\([^)]*releases[^)]*\)>256/u);
  });

  it("loads the canonical root only from Credit-owned facts", async () => {
    const migration = await readFile(migrationPath, "utf8");
    const lock = migration.slice(
      migration.indexOf("CREATE FUNCTION platform.lock_execution_root_closure"),
      migration.indexOf("CREATE FUNCTION platform.commit_execution_root_closure"),
    );
    expect(lock).not.toContain("platform.media_operation");
    expect(lock).not.toContain("platform.admission_execution_manifest");
    expect(lock).toContain("segment.aggregate_version");
    expect(lock).toContain("root.execution_root_ref=p_owner_proof->>'sourceRef'");
  });

  it("upgrades the closure routines without rewriting their immutable source migration", async () => {
    const migration = await readFile(closureTransitionFixMigrationPath, "utf8");
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION platform.commit_execution_root_closure(p_record JSONB)",
    );
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION platform.mark_execution_root_reconciliation(p_record JSONB)",
    );
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION platform.guard_credit_execution_budget_root_transition()",
    );
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION platform.guard_credit_hold_transition()",
    );
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION platform.credit_direct_root_lock_outcome(",
    );
    expect(migration).not.toContain("chr(0)");
    expect(migration).toContain(
      "platform.credit_direct_root_framed_digest(VARIADIC ARRAY[",
    );

    const commit = migration.slice(
      migration.indexOf("CREATE OR REPLACE FUNCTION platform.commit_execution_root_closure"),
      migration.indexOf("CREATE OR REPLACE FUNCTION platform.mark_execution_root_reconciliation"),
    );
    const reconciliation = migration.slice(
      migration.indexOf("CREATE OR REPLACE FUNCTION platform.mark_execution_root_reconciliation"),
    );
    expect(commit).not.toContain("UPDATE platform.credit_budget_allocation SET current_revision");
    expect(commit).not.toContain("concat_ws('|'");
    expect(commit).toContain("octet_length(posting.ordinal)::TEXT||':'||posting.ordinal");
    expect(reconciliation).not.toContain(
      "UPDATE platform.credit_budget_allocation SET current_revision",
    );
    expect(migration).toContain(
      "OLD.state='open' AND NEW.state NOT IN ('closing','settled','reconciliation_required')",
    );
    expect(migration).toContain(
      "OLD.state='open' AND NEW.state NOT IN ('open','closing','settled','released','expired','reconciliation_required')",
    );
    expect(migration).toContain("NEW.aggregate_version<>OLD.aggregate_version+1");
    expect(migration).toContain("NEW.fence_epoch<>OLD.fence_epoch+1");
    expect(migration).toContain(
      "set_config('app.credit_execution_root_closure_transition','commit',true)",
    );
    expect(migration).toContain("CURRENT_USER=SESSION_USER");
    expect(migration).toContain("CURRENT_USER IS DISTINCT FROM relation_owner");
    expect(migration.match(/FROM pg_catalog\.pg_class relation WHERE relation\.oid=TG_RELID/gu))
      .toHaveLength(2);
  });
});
