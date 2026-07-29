import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../../prisma/migrations/20260729_wave_2a_commerce_core/migration.sql", import.meta.url), "utf8");
const identityMigration = readFileSync(new URL("../../prisma/migrations/20260729_identity_core/migration.sql", import.meta.url), "utf8");
const migrator = readFileSync(new URL("../../src/infrastructure/postgres/migrator.ts", import.meta.url), "utf8");

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
    expect(migration).toContain("UNIQUE(source_type,source_id,purpose,cycle_key)");
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

  it("assembles explicit API/admin privileges while PUBLIC remains revoked", () => {
    expect(migration).toContain("REVOKE ALL ON");
    expect(migrator).toContain("const COMMERCE_TABLES");
    expect(migrator).toContain("GRANT INSERT ON TABLE platform.commerce_command");
    expect(migrator).toContain("GRANT UPDATE ON TABLE platform.commerce_command, platform.commerce_fulfillment_transaction");
    expect(migrator).toContain("GRANT INSERT, UPDATE ON TABLE platform.commerce_billing_account");
  });
});
