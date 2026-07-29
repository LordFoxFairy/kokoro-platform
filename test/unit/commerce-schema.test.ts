import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../prisma/migrations/20260729_wave_2a_commerce_core/migration.sql", import.meta.url),
  "utf8",
);
const identityMigration = readFileSync(
  new URL("../../prisma/migrations/20260729_identity_core/migration.sql", import.meta.url),
  "utf8",
);
const migrator = readFileSync(
  new URL("../../src/infrastructure/postgres/migrator.ts", import.meta.url),
  "utf8",
);
const compactMigration = migration.replace(/\s+/gu, " ");

describe("Wave 2A Commerce authority schema", () => {
  it("upgrades legacy UUID command ids to the authoritative 32hex representation", () => {
    expect(identityMigration).toContain("ELSE replace(command_id::TEXT,'-','')");
    expect(identityMigration).toContain("WHEN command_id::TEXT ~");
    expect(identityMigration).toContain("[a-f0-9]{32}");
    expect(identityMigration).toContain("-7[a-f0-9]{3}-[89ab]");
    expect(migration).not.toContain("ALTER COLUMN command_id TYPE TEXT");
  });

  it("owns BillingAccount, Site-composite membership and fulfillment lineage", () => {
    expect(migration).toContain("CREATE TABLE platform.commerce_billing_account (");
    expect(migration).toContain("CREATE TABLE platform.commerce_billing_account_membership (");
    expect(migration).toContain("FOREIGN KEY(billing_account_ref,site_ref)");
    expect(migration).toContain("FOREIGN KEY(subject_ref,site_ref)");
    expect(migration).toContain("UNIQUE(site_ref,source_type,source_id,purpose,cycle_key)");
  });

  it("stores no raw Code and binds every published output revision to one Site", () => {
    expect(migration).toContain("CREATE TABLE platform.commerce_redeem_code (");
    expect(migration).toContain("lookup_digest CHAR(64) NOT NULL");
    expect(migration).toContain("safe_fingerprint TEXT NOT NULL");
    expect(migration).not.toMatch(/(?:raw|plaintext)_code/iu);
    expect(migration).toContain("FOREIGN KEY(fulfillment_program_revision_ref,site_ref)");
    expect(migration).toContain("FOREIGN KEY(credit_program_revision_ref,site_ref)");
    expect(migration).toContain("UNIQUE(site_ref,output_plan_digest)");
  });

  it("keeps preview non-reserving and freezes its complete confirmation binding", () => {
    expect(migration).toContain("CREATE TABLE platform.commerce_redemption_preview (");
    expect(migration).toContain("subject_generation BIGINT NOT NULL");
    expect(migration).toContain("billing_account_ref TEXT NOT NULL");
    expect(migration).toContain("product_revision_digest CHAR(64) NOT NULL");
    expect(migration).toContain("program_digest CHAR(64) NOT NULL");
    expect(migration).toContain("output_plan_digest CHAR(64) NOT NULL");
    expect(migration).not.toContain("reserved_by_preview");
  });

  it("makes output truth and audit append-only and validates the exact set at success", () => {
    expect(migration).toContain("commerce_output_plan_contiguous");
    expect(migration).toContain("commerce_command_update_guard");
    expect(migration).toContain("FULFILLMENT_OUTPUT_SET_INVALID");
    expect(migration).toContain("CREATE TABLE platform.commerce_audit_entry");
    expect(migration).toContain("commerce_audit_immutable");
    expect(migration).toContain("REFERENCES platform.outbox_event(event_id)");
  });

  it("keeps Term and Entitlement issuance immutable and records revocation facts", () => {
    expect(migration).toContain("CREATE TABLE platform.commerce_subscription_term_revocation (");
    expect(migration).toContain("CREATE TABLE platform.commerce_entitlement_revocation (");
    expect(migration).toContain("commerce_subscription_term_immutable");
    expect(migration).toContain("commerce_entitlement_grant_immutable");
    expect(migration).not.toMatch(/commerce_subscription_term[\s\S]{0,800}reversed_at/iu);
    expect(migration).not.toMatch(/commerce_entitlement_grant[\s\S]{0,800}revoked_at/iu);
  });

  it("owns an immutable Grant journal with deterministic burn order and exact cross-fact proofs", () => {
    expect(migration).toContain("CREATE TABLE platform.credit_grant (");
    expect(migration).toContain("CREATE TABLE platform.credit_journal_transaction (");
    expect(migration).toContain("CREATE TABLE platform.credit_journal_entry (");
    expect(compactMigration).toContain(
      "expires_at ASC NULLS LAST,burn_priority ASC,issued_at ASC,credit_grant_id ASC",
    );
    expect(migration).toContain("entries_digest CHAR(64) NOT NULL");
    expect(migration).toContain("actual_digest<>expected_digest");
    expect(migration).toContain("CREDIT_JOURNAL_OPERATION_SHAPE_INVALID");
    expect(migration).toContain("CREDIT_GRANT_ISSUANCE_JOURNAL_MISMATCH");
    expect(migration).toContain("CREDIT_HOLD_ALLOCATION_JOURNAL_MISMATCH");
    expect(migration).not.toMatch(/available_delta|held_delta|consumed_delta/iu);
  });

  it("binds each Hold allocation and Journal entry to one exact Site Account and unit", () => {
    expect(compactMigration).toContain(
      "FOREIGN KEY(credit_account_ref,site_ref,billing_account_ref,unit,liability_merchant_account_ref) REFERENCES platform.credit_account",
    );
    expect(compactMigration).toContain(
      "FOREIGN KEY(credit_hold_ref,site_ref,credit_account_ref,unit) REFERENCES platform.credit_hold",
    );
    expect(compactMigration).toContain(
      "FOREIGN KEY(credit_hold_ref,credit_grant_id,site_ref,credit_account_ref,unit) REFERENCES platform.credit_hold_allocation",
    );
    expect(migration).toContain("CHECK(reserved_amount = requested_amount)");
    expect(migration).toContain("CREDIT_HOLD_JOURNAL_TOTAL_MISMATCH");
  });

  it("owns the sole execution budget allocation tree and fenced Segment state machine", () => {
    expect(migration).toContain("CREATE TABLE platform.credit_execution_budget_root (");
    expect(migration).toContain("CREATE TABLE platform.credit_budget_allocation_revision (");
    expect(migration).toContain("CREATE TABLE platform.credit_authorization_segment (");
    expect(migration).toContain("CREDIT_ALLOCATION_REVISION_CAS_FAILED");
    expect(migration).toContain("CREDIT_ALLOCATION_CHILD_STOCK_MISMATCH");
    expect(migration).toContain("CREDIT_CHILD_ALLOCATION_ORIGIN_INVALID");
    expect(migration).toContain("CREDIT_ALLOCATION_RETURN_CONSERVATION_FAILED");
    expect(migration).toContain("CREDIT_AUTHORIZATION_SEGMENT_COMMIT_STOCK_INVALID");
    expect(migration).toContain("CREDIT_AUTHORIZATION_ROOT_NOT_OPEN");
    expect(migration).toContain("CREDIT_AUTHORIZATION_SEGMENT_EXPIRED");
    expect(compactMigration).toContain("NEW.committed_at>=OLD.expires_at");
    expect(migration).toContain("CREDIT_HOLD_SEGMENT_STILL_ACTIVE");
  });

  it("persists budget command replay evidence and its outbox event in the same authority schema", () => {
    expect(migration).toContain("CREATE TABLE platform.credit_budget_operation_receipt (");
    expect(compactMigration).toContain(
      "UNIQUE(site_ref,operation_kind,business_operation_key)",
    );
    expect(migration).toContain("request_digest CHAR(64) NOT NULL");
    expect(migration).toContain("result_digest CHAR(64) NOT NULL");
    expect(migration).toContain("REFERENCES platform.outbox_event(event_id)");
    expect(migration).toContain("credit_budget_operation_receipt_immutable");
    expect(migrator).toContain("platform.credit_budget_operation_receipt");
  });

  it("keeps UX bucket labels out of burn authority and freezes window semantics", () => {
    expect(migration).toContain("ux_bucket_class TEXT NOT NULL");
    expect(migration).toContain("ux_bucket_class='daily' AND window_kind='daily'");
    expect(migration).toContain("ux_bucket_class='period' AND window_kind='period'");
    expect(migration).toContain("ux_bucket_class='permanent' AND window_kind='none'");
    expect(migration).not.toContain("bucket_spend_order");
  });

  it("assembles explicit API/admin privileges while PUBLIC remains revoked", () => {
    expect(migration).toContain("REVOKE ALL ON");
    expect(migrator).toContain("const COMMERCE_TABLES");
    expect(migrator).toContain("GRANT INSERT ON TABLE platform.commerce_command");
    expect(migrator).toContain(
      "platform.credit_authorization_segment, platform.commerce_fulfillment_transaction",
    );
    expect(migrator).toContain("GRANT INSERT, UPDATE ON TABLE platform.commerce_billing_account");
  });
});
