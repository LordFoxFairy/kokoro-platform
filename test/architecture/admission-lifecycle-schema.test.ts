import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Admission lifecycle schema", () => {
  it("deploys Site-scoped binding and manifest projections under the API role", async () => {
    const [migration, schema, migrator, composition] = await Promise.all([
      readFile(resolve("prisma/migrations/20260731_admission_owner_lifecycle/migration.sql"), "utf8"),
      readFile(resolve("prisma/schema.prisma"), "utf8"),
      readFile(resolve("src/infrastructure/postgres/migrator.ts"), "utf8"),
      readFile(resolve("src/process/admission-composition.ts"), "utf8"),
    ]);

    expect(migration).toContain("CREATE TABLE platform.admission_session_execution_binding");
    expect(migration).toContain("CREATE TABLE platform.admission_execution_manifest");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("current_setting('app.site_id',true)");
    expect(migration).toContain("admission_session_execution_binding_immutable");
    expect(migration).not.toContain("trigger_message_content");
    expect(migration).not.toContain("parent_anchor");
    expect(schema).toContain("model AdmissionSessionExecutionBinding");
    expect(schema).toContain("model AdmissionExecutionManifest");
    expect(migrator).toContain('"platform.admission_session_execution_binding"');
    expect(migrator).toContain('"platform.admission_execution_manifest"');
    expect(composition).toContain('"assets" | "budget" | "sessionGrant"');
    expect(composition).toContain("lifecycle: new PostgresAdmissionLifecycleOwner()");
    expect(composition).toContain("site: new PostgresAdmissionSiteOwner()");
    expect(composition).toContain("runtimePolicy: new PostgresAdmissionRuntimePolicyOwner()");
    expect(composition).toContain("capability: new PostgresAdmissionCapabilityOwner()");
    expect(composition).toContain("assets: new PostgresAdmissionAssetOwner()");
    expect(composition).toContain("budget: new PostgresAdmissionBudgetOwner()");
    expect(composition).toContain("sessionGrant: new PostgresAdmissionSessionGrantOwner()");
    expect(composition).toContain("executionBinding: new PostgresAdmissionExecutionBindingOwner()");
    expect(schema).not.toContain("@@unique([siteId, namespace])");
    expect(migration).not.toContain("UNIQUE(site_id,namespace)");
    expect(migrator).toContain("platform.site, platform.site_release TO ${identifier}");
  });
});
