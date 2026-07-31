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
const transactionKernelMigration = readFileSync(
  new URL("../../prisma/migrations/0002_platform_transaction_kernel/migration.sql", import.meta.url),
  "utf8",
);
const migrator = readFileSync(
  new URL("../../src/infrastructure/postgres/migrator.ts", import.meta.url),
  "utf8",
);
const commerceReader = readFileSync(
  new URL("../../src/modules/commerce/infrastructure/postgres/commerce-administration-reader.ts", import.meta.url),
  "utf8",
);
const commerceService = readFileSync(
  new URL("../../src/modules/commerce/application/services/commerce-administration.ts", import.meta.url),
  "utf8",
);
const compactMigration = migration.replace(/\s+/gu, " ");

describe("Wave 2A Commerce authority schema", () => {
  it("creates the authoritative command identity shape in the initial transaction kernel", () => {
    expect(transactionKernelMigration).toContain("command_id TEXT PRIMARY KEY");
    expect(transactionKernelMigration).toContain("[a-f0-9]{32}");
    expect(transactionKernelMigration).toContain("-7[a-f0-9]{3}-[89ab]");
    expect(identityMigration).not.toContain("ALTER COLUMN command_id TYPE");
    expect(migration).not.toContain("ALTER COLUMN command_id TYPE TEXT");
  });

  it("owns BillingAccount, Site-composite membership and fulfillment lineage", () => {
    expect(migration).toContain("CREATE TABLE platform.commerce_billing_account (");
    expect(migration).toContain("CREATE TABLE platform.commerce_billing_account_membership (");
    expect(migration).toContain("FOREIGN KEY(billing_account_ref,site_ref)");
    expect(migration).toContain("FOREIGN KEY(subject_ref,site_ref)");
    expect(migration).toContain("UNIQUE(site_ref,source_type,source_id,purpose,cycle_key)");
  });

  it("makes acquisition-source replay the only fulfillment issuance fence", () => {
    expect(migration).toContain("idempotency_key CHAR(64) NOT NULL UNIQUE");
    expect(migration).toContain("acquisition_snapshot_digest CHAR(64) NOT NULL");
    expect(migration).toContain("pricing_snapshot_ref TEXT");
    expect(migration).toContain("source_type IN ('redemption','payment','admin_grant','program_window')");
    expect(compactMigration).toContain("source_type<>'payment' OR pricing_snapshot_ref IS NOT NULL");
  });

  it("stores no raw Code and binds every published output revision to one Site", () => {
    expect(migration).toContain("CREATE TABLE platform.commerce_redeem_code (");
    expect(migration).toContain("lookup_digest CHAR(64) NOT NULL");
    expect(migration).toContain("safe_fingerprint TEXT NOT NULL");
    expect(migration).not.toMatch(/(?:raw|plaintext)_code/iu);
    expect(migration).toContain("FOREIGN KEY(fulfillment_program_revision_ref,site_ref)");
    expect(migration).toContain("FOREIGN KEY(product_version_ref,site_ref,fulfillment_program_revision_ref)");
    expect(migration).toContain("FOREIGN KEY(credit_program_revision_ref,site_ref)");
    expect(migration).toContain("UNIQUE(site_ref,output_plan_digest)");
  });

  it("owns formal maker-checker issuance and one-time Code export facts", () => {
    expect(migration).toContain("batch_selector CHAR(10) NOT NULL");
    expect(migration).toContain("created_by_subject_ref TEXT NOT NULL");
    expect(migration).toContain("CREATE TABLE platform.commerce_code_batch_approval (");
    expect(migration).toContain("CHECK(maker_subject_ref<>checker_subject_ref)");
    expect(migration).toContain("CREATE TABLE platform.commerce_code_secret_export (");
    expect(migration).toContain("commerce_code_secret_export_immutable");
  });

  it("serializes catalog publication through one monotonic committed epoch authority", () => {
    expect(migration).toContain("CREATE TABLE platform.commerce_catalog_epoch_authority (");
    expect(migration).toContain("current_epoch BIGINT NOT NULL CHECK(current_epoch >= 0)");
    expect(migration).toContain("CHECK(singleton)");
    const epochColumns = migration.match(/catalog_epoch BIGINT NOT NULL CHECK\(catalog_epoch > 0\)/gu) ?? [];
    expect(epochColumns).toHaveLength(7);
    expect(migration).toContain("INSERT INTO platform.commerce_catalog_epoch_authority(singleton,current_epoch)");
    for (const index of ["commerce_credit_program_catalog_page_idx",
      "commerce_entitlement_template_catalog_page_idx", "commerce_product_version_catalog_page_idx",
      "commerce_redemption_program_catalog_page_idx", "commerce_code_batch_catalog_page_idx"]) {
      expect(migration).toContain(`CREATE INDEX ${index}`);
    }
    expect(migrator).toContain("GRANT UPDATE ON TABLE platform.commerce_catalog_epoch_authority");
  });

  it("forces default-deny Site RLS across all fresh Commerce and Credit authority tables", () => {
    expect(migration).toContain("ALTER TABLE platform.%I FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("CREATE POLICY site_isolation");
    expect(migration).toContain("current_setting(''app.site_id'',true)");
    expect(migration).toContain("ALTER TABLE platform.commerce_fulfillment_actual_output FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("ALTER TABLE platform.commerce_command_outbox FORCE ROW LEVEL SECURITY");
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
    expect(migration).toContain("JOIN platform.credit_grant hold_grant");
    expect(migration).not.toContain("JOIN platform.credit_grant grant_fact");
    expect(migration).not.toMatch(/available_delta|held_delta|consumed_delta/iu);
  });

  it("fails closed on malformed Grant scope policy and binds the admitted scope to the budget root", () => {
    expect(migration).toContain("CREATE FUNCTION platform.valid_credit_scope_policy");
    expect(migration).toContain("surfaceRefs");
    expect(migration).toContain("capabilityKeys");
    expect(migration).toContain("allowUnattributedAgent");
    expect(migration).toContain("scope_policy JSONB NOT NULL CHECK(platform.valid_credit_scope_policy(scope_policy))");
    expect(compactMigration).toContain("surface_ref TEXT NOT NULL");
    expect(compactMigration).toContain("capability_key TEXT NOT NULL");
    expect(compactMigration).toContain("agent_ref TEXT CHECK");
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
    expect(compactMigration).toContain(
      "target_allocation_ref := CASE TG_TABLE_NAME WHEN 'credit_allocation_reservation_receipt' THEN (payload->>'child_allocation_ref')::UUID ELSE (payload->>'budget_allocation_ref')::UUID END",
    );
    expect(migration).not.toContain("THEN NEW.child_allocation_ref");
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
    expect(migration).toContain("rollover_policy TEXT NOT NULL CHECK(rollover_policy='none')");
    expect(migration).toContain("window_anchor ~ '^daily@");
    expect(migration).toContain("window_anchor='subscription-term-start'");
    expect(migration).toContain("platform.commerce_iana_zone_is_valid(calendar_zone)");
    expect(migration).toContain("FROM pg_catalog.pg_timezone_names WHERE name=zone");
    expect(migration).not.toContain("calendar_zone ~ '^(UTC|");
    expect(commerceReader).not.toContain("Intl.DateTimeFormat");
    expect(commerceService).not.toContain("Intl.DateTimeFormat");
    expect(migration).not.toContain("bucket_spend_order");
  });

  it("uses one Unicode-complete safe-label authority for every persisted label", () => {
    expect(migration).toContain("CREATE FUNCTION platform.commerce_safe_label_is_valid(value TEXT)");
    expect(migration).toContain("value IS NFC NORMALIZED");
    expect(migration).toContain("generate_series(1,char_length(value))");
    expect(migration).toContain("code_point BETWEEN 127 AND 159");
    expect(migration).toContain("code_point BETWEEN 917536 AND 917631");
    expect(migration.match(/CHECK\(platform\.commerce_safe_label_is_valid\(safe_label\)\)/gu) ?? [])
      .toHaveLength(4);
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
