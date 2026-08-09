import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Admission Model owner database boundary", () => {
  it("publishes one admission-only safe projection and constructs the native adapter", async () => {
    const [migration, migrator, client, composition] = await Promise.all([
      readFile(resolve("prisma/migrations/20260731_admission_model_owner/migration.sql"), "utf8"),
      readFile(resolve("src/infrastructure/postgres/migrator.ts"), "utf8"),
      readFile(resolve("src/infrastructure/postgres/client.ts"), "utf8"),
      readFile(resolve("src/process/admission-composition.ts"), "utf8"),
    ]);

    expect(migration).toContain("CREATE FUNCTION platform.resolve_admission_model_owner");
    expect(migration).toContain("current_setting('app.operation',true) IS DISTINCT FROM 'admission.command'");
    expect(migration).toContain(
      "current_setting('app.workload_kind',true) IS DISTINCT FROM 'platform_admission'",
    );
    expect(migration).not.toContain(
      "current_setting('app.workload_kind',true) IS DISTINCT FROM 'platform_api'",
    );
    expect(migration).toContain("current_setting('app.site_id',true) IS DISTINCT FROM p_site_id");
    expect(migration).toContain("composition_slot='orchestration'");
    expect(migration).toContain("model_availability.status='active'");
    expect(migration).toContain("provider_availability.health IN ('healthy','degraded')");
    expect(migration).toContain(
      "provider.secret_ref='secret://platform/model-gateway/direct'",
    );
    expect(migration).not.toContain("'secretRef'");
    expect(migration).not.toContain("'accountKey'");
    expect(migration).toContain("REVOKE ALL ON FUNCTION platform.resolve_admission_model_owner(TEXT,TEXT,TEXT) FROM PUBLIC");
    for (const source of [migrator, client]) {
      expect(source).toContain("platform.resolve_admission_model_owner(text,text,text)");
    }
    expect(composition).toContain("model: new PostgresAdmissionModelOwner()");
    expect(composition).not.toContain("directProviderIdentity");
  });
});
