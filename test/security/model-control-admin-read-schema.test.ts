import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(import.meta.dirname,
  "../../prisma/migrations/20260803_model_control_admin_read_plane/migration.sql"), "utf8");
const migrator = readFileSync(resolve(import.meta.dirname,
  "../../src/infrastructure/postgres/migrator.ts"), "utf8");

describe("ModelControl Admin read-plane schema", () => {
  it("enforces exact Site RLS on policy and release-catalog projections", () => {
    for (const table of [
      "model_site_policy_revision", "model_site_assignment_revision",
      "model_site_policy_pointer", "site_release_model_catalog_publication",
      "site_release_model_catalog_surface", "site_release_model_catalog_option",
    ]) expect(migration).toContain(`ALTER TABLE platform.${table} ENABLE ROW LEVEL SECURITY`);
    expect(migration).toContain("NULLIF(current_setting('app.site_id',true),'')");
    expect(migration).toContain("current_setting('app.workload_kind',true)='platform_admin'");
    expect(migration).toContain("current_setting('app.admin_scope_kind',true)='global'");
    expect(migration).toMatch(/current_setting\('app\.admin_site_refs',true\)[\s\S]{0,80}::jsonb/u);
  });

  it("grants the Admin workload only the safe inventory/provider columns", () => {
    expect(migrator).toContain("MODEL_ADMIN_READ_TABLES");
    expect(migrator).toMatch(/GRANT SELECT\(import_id,source_digest,source_reference,counts,imported_at\)[\s\S]*model_inventory_import/u);
    expect(migrator).toMatch(/GRANT SELECT\(import_id,provider_key,provider,account_key,adapter_kind,priority\)[\s\S]*model_provider_snapshot/u);
    expect(migrator).not.toMatch(/GRANT SELECT ON TABLE[^\n]*model_inventory_import/u);
    expect(migrator).not.toMatch(/GRANT SELECT ON TABLE[^\n]*model_provider_snapshot/u);
  });
});
