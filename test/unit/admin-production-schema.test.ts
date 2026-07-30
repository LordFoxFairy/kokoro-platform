import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const schema = readFileSync(resolve("prisma/schema.prisma"), "utf8");
const migration = readFileSync(
  resolve("prisma/migrations/20260729_admin_control_authority/migration.sql"),
  "utf8",
);
const migrator = readFileSync(resolve("src/infrastructure/postgres/migrator.ts"), "utf8");
const databaseClient = readFileSync(resolve("src/infrastructure/postgres/client.ts"), "utf8");

describe("production Admin authority schema", () => {
  it("stores typed Site, Global and BreakGlass grants instead of wildcard arrays", () => {
    for (const model of [
      "AdminOperatorSiteScope",
      "AdminOperatorGlobalScopeGrant",
      "AdminBreakGlassGrant",
    ]) expect(schema).toContain(`model ${model}`);
    expect(schema).not.toMatch(/siteScopes\s+String\[\]/u);
    expect(migration).toContain("CREATE TABLE platform.admin_operator_site_scope");
    expect(migration).toContain("CREATE TABLE platform.admin_operator_global_scope_grant");
    expect(migration).toContain("CREATE TABLE platform.admin_breakglass_grant");
    expect(migration).not.toContain("site_scopes TEXT[]");
  });

  it("owns OIDC identity, single-use transaction and revocable session facts", () => {
    for (const model of [
      "AdminOperatorIdentity",
      "AdminOidcTransaction",
      "AdminOperatorSession",
    ]) expect(schema).toContain(`model ${model}`);
    expect(migration).toContain("UNIQUE(issuer,subject)");
    expect(migration).toContain("UNIQUE(recovery_digest)");
    expect(migration).toContain("UNIQUE(credential_digest)");
    expect(migration).toContain("provider_outcome_unknown");
  });

  it("grants Admin only its exact control-plane tables and keeps DDL forbidden", () => {
    expect(migrator).toContain("platform.admin_oidc_transaction");
    expect(migrator).toContain("platform.admin_operator_session");
    expect(migrator).toContain("platform.admin_operator_site_scope");
    expect(migrator).toContain("platform.admin_operator_global_scope_grant");
    expect(migrator).toContain("platform.admin_breakglass_grant");
    expect(migrator).not.toMatch(/GRANT\s+ALL[^\n]+platform\.admin_/u);
    for (const table of [
      "admin_operator_site_scope", "admin_operator_global_scope_grant", "admin_breakglass_grant",
      "admin_operator_identity", "admin_oidc_transaction", "admin_operator_session",
      "admin_step_up_transaction",
    ]) expect(databaseClient).toContain(`platform.${table}`);
  });
});
