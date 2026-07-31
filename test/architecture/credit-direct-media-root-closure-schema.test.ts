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
    expect(migration).toContain("PERFORM platform.assert_media_runtime_role('worker')");
    expect(migration).toContain("TO platform_media_worker");
    expect(migration).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)[\s\S]{0,200}\bTO\s+platform_media_worker\b/iu,
    );
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
});
