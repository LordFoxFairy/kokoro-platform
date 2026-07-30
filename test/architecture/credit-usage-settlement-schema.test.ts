import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../prisma/migrations/20260801_credit_usage_settlement/migration.sql",
  import.meta.url,
);

describe("Credit usage settlement authority schema", () => {
  it("persists immutable evidence, closure revisions, rating snapshots and settlement facts", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    for (const relation of [
      "credit_rating_policy_revision",
      "credit_rating_snapshot",
      "credit_usage_attempt_intent",
      "credit_attempt_usage_evidence",
      "credit_usage_segment_closure",
      "credit_usage_closure_evidence",
      "credit_rated_usage",
      "credit_usage_settlement",
      "credit_usage_settlement_source",
      "credit_usage_variance",
      "credit_usage_command_receipt",
    ]) expect(sql).toContain(`CREATE TABLE platform.${relation}`);
    expect(sql).toContain("UNIQUE(site_ref,producer_kind,producer_context,producer_generation,attempt_ref,revision)");
    expect(sql).toContain("CREDIT_USAGE_ATTEMPT_IDENTITY_IMMUTABLE");
    expect(sql).toContain("CREDIT_USAGE_ATTEMPT_TRANSITION_INVALID");
    expect(sql).toContain("attempt_authorization_ref");
    expect(sql).toContain("correction_of_evidence_ref");
    expect(sql).toContain("correction_of_closure_ref");
    expect(sql).toContain("prior_settlement_ref");
    expect(sql).toContain("CREDIT_USAGE_FACT_IMMUTABLE");
  });

  it("keeps customer capture bounded and every correction source-linked", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("customer_amount<=segment_maximum_amount");
    expect(sql).toContain("platform_exposure_amount=policy_rated_amount-customer_amount");
    expect(sql).toContain("FOREIGN KEY(credit_hold_ref,credit_grant_id,site_ref,credit_account_ref,unit)");
    expect(sql).toContain("direction IN ('capture','increase','decrease')");
    expect(sql).toContain("expected_evidence_count");
    expect(sql).toContain("assert_credit_usage_closure_complete");
  });
});
