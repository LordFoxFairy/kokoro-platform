import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL(
  "../../prisma/migrations/20260729_admin_control_authority/migration.sql",
  import.meta.url,
), "utf8");
const migrator = readFileSync(new URL(
  "../../src/infrastructure/postgres/migrator.ts",
  import.meta.url,
), "utf8");
const client = readFileSync(new URL(
  "../../src/infrastructure/postgres/client.ts",
  import.meta.url,
), "utf8");

describe("Admin control-plane authority schema", () => {
  it("owns current operator authority, immutable decisions and maker/checker approvals", () => {
    expect(migration).toContain("CREATE TABLE platform.admin_operator_authority");
    expect(migration).toContain("CREATE TABLE platform.admin_command_decision");
    expect(migration).toContain("CREATE TABLE platform.admin_approval (");
    expect(migration).toContain("CHECK (checker_ref IS NULL OR checker_ref<>maker_ref)");
    expect(migration).toContain("admin_command_decision_immutable");
    expect(migration).toContain("admin_approval_transition_guard");
    expect(migration).toContain("'execution_queued'");
    expect(migration).toContain("OLD.state='pending' AND NEW.state IN ('execution_queued','rejected','expired','stale_authority')");
    expect(migration).toContain("OLD.state='execution_queued' AND NEW.state IN ('executed','effect_rejected','stale_authority')");
  });

  it("has a sealed offline bootstrap and durable post-effect review authority", () => {
    expect(migration).toContain("CREATE TABLE platform.admin_authority_bootstrap");
    expect(migration).toContain("CREATE FUNCTION platform.bootstrap_admin_authorities");
    expect(migration).toContain("ADMIN_AUTHORITY_BOOTSTRAP_SEALED");
    expect(migration).toContain("CREATE TABLE platform.admin_post_effect_review");
    expect(migration).toContain("post_effect_review_no_delete");
  });

  it("forces RLS across Site, operator, environment and region axes", () => {
    for (const table of ["admin_operator_authority", "admin_command_decision",
      "admin_approval", "admin_approval_decision"]) {
      expect(migration).toContain(`ALTER TABLE platform.${table} FORCE ROW LEVEL SECURITY`);
    }
    expect(migration).toContain("operator_ref=current_setting('app.subject_id',true)");
    expect(migration).toContain("COALESCE(target_site_ref,'')=current_setting('app.site_id',true)");
    expect(migration).toContain("environment=current_setting('app.environment',true)");
    expect(migration).toContain("region=current_setting('app.region',true)");
  });

  it("grants only the dedicated Admin role and verifies the same privilege manifest at runtime", () => {
    expect(migrator).toContain("const ADMIN_TABLES");
    expect(migrator).toContain("GRANT INSERT ON TABLE platform.admin_command_decision");
    expect(migrator).toContain("GRANT UPDATE ON TABLE platform.admin_approval");
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION platform.bootstrap_admin_authorities(JSONB, CHAR(64)) FROM PUBLIC",
    );
    expect(migrator).toContain("platform.admin_post_effect_review");
    expect(migrator).not.toContain("GRANT INSERT ON TABLE platform.admin_operator_authority");
    expect(migrator).not.toContain("GRANT EXECUTE ON FUNCTION platform.bootstrap_admin_authorities");
    expect(client).toContain("'platform.admin_operator_authority', 'SELECT'");
    expect(client).toContain("'platform.admin_approval', 'SELECT,INSERT,UPDATE'");
  });
});
