import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationPath = "prisma/migrations/20260812_credit_direct_media_root_closure/migration.sql";

describe("Credit direct Media root closure schema", () => {
  it("keeps closure receipts immutable, conserved and fenced", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).toContain("credit_direct_media_root_closure_receipt");
    expect(migration).toContain("captured_amount+released_amount=reserved_ceiling");
    expect(migration).toContain("allocation_after_revision=allocation_before_revision+1");
    expect(migration).toContain("hold_after_fence=hold_before_fence+1");
    expect(migration).toContain("CREDIT_DIRECT_MEDIA_ROOT_FACT_IMMUTABLE");
    expect(migration).not.toMatch(/refund/iu);
  });

  it("exposes only exact worker definer routines and no Credit table privileges", async () => {
    const migration = await readFile(migrationPath, "utf8");
    for (const routine of ["find_direct_media_root_closure", "lock_direct_media_root_closure",
      "commit_direct_media_root_closure", "mark_direct_media_root_reconciliation"]) {
      expect(migration).toContain(`platform.${routine}`);
    }
    expect(migration).toContain("PERFORM platform.assert_media_image_worker_lease(");
    expect(migration).toContain("TO platform_media_worker");
    expect(migration).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)[\s\S]{0,200}\bTO\s+platform_media_worker\b/iu,
    );
  });

  it("accepts only closed bounded commands and independently verifies their digests", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).toContain("credit_direct_root_json_exact_keys");
    expect(migration).toContain("octet_length(p_record::TEXT)");
    expect(migration).not.toContain("pg_column_size(p_record)");
    expect(migration).toMatch(/jsonb_array_length\([^)]*releases[^)]*\)>16/u);
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
    expect(migration).toContain("CREDIT_DIRECT_ROOT_AUTHORITY_MISMATCH");
    expect(migration).toContain("CREDIT_DIRECT_ROOT_RATING_MISMATCH");
    expect(migration).toContain("CREDIT_DIRECT_ROOT_HOLD_SOURCE_MISMATCH");
  });

  it("looks up closure and reconciliation as one exclusive durable outcome", async () => {
    const migration = await readFile(migrationPath, "utf8");
    const lookup = migration.slice(
      migration.indexOf("CREATE FUNCTION platform.find_direct_media_root_closure"),
      migration.indexOf("CREATE FUNCTION platform.lock_direct_media_root_closure"),
    );
    expect(lookup).toContain("credit_direct_media_root_closure_receipt");
    expect(lookup).toContain("credit_direct_media_root_reconciliation");
    expect(lookup).toContain("reconciliationReceiptRef");
    expect(lookup).toContain("reconciliation_required");
    expect(lookup).toContain("CREDIT_DIRECT_ROOT_OUTCOME_EXCLUSIVITY_VIOLATION");
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
    expect(migration).toMatch(/FOR UPDATE OF (?:operation,)?root,hold,allocation,revision,segment,settlement/iu);
    expect(migration).toContain("openChildCount");
    expect(migration).toContain("openSegmentCount");
    expect(migration).toContain("openAttemptCount");
    expect(migration).toContain("CREDIT_DIRECT_ROOT_COMMIT_FENCE_INVALID");
    expect(migration).toContain("customer_reserved");
    expect(migration).toContain("customer_available");
  });

  it("binds the frozen admission segment version without mistaking it for the evolved settlement head", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).not.toContain(
      "operation.credit_authorization_segment_version=p_authorization_segment_version",
    );
    expect(migration).toContain(
      "'authorizationSegmentVersion',context.credit_authorization_segment_version::TEXT",
    );
    expect(migration).not.toContain("segment.aggregate_version=p_authorization_segment_version");
    expect(migration).toContain("segment.state='settled'");
    expect(migration).toContain(
      "segment.execution_manifest_ref=operation.credit_execution_manifest_ref",
    );
    expect(migration).not.toContain(
      "operation.credit_execution_manifest_ref=p_execution_manifest_ref",
    );
  });
});
