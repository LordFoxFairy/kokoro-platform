import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("ModelControl consumer boundary", () => {
  it("has no new local self-RPC consumer", async () => {
    const files = await Promise.all(
      [
        "src/modules/model-control/application/contracts/model-control-ports.ts",
        "src/platform-registry.ts",
        "kokoro-user/src/config/env.ts",
        "kokoro-credit/src/config/env.ts",
        "kokoro-platform-admin/src/config.ts",
      ].map((file) => readFile(resolve(file), "utf8")),
    );
    expect(files.join("\n")).not.toMatch(
      /fetch\(|callService|KOKORO_MODEL_BASE_URL|from ["']@kokoro\/model/u,
    );
    expect(files[0]).toContain("ModelControlApplication");
    const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies).not.toHaveProperty("@kokoro/model");
  });

  it("materializes and activates catalogs through separate immutable commands", async () => {
    const migration = await readFile(
      resolve("prisma/migrations/0003_model_control/migration.sql"),
      "utf8",
    );
    const importFunction = between(
      migration,
      "CREATE FUNCTION platform.import_model_inventory(",
      "CREATE FUNCTION platform.activate_model_inventory(",
    );
    const activationFunction = between(
      migration,
      "CREATE FUNCTION platform.activate_model_inventory(",
      "CREATE FUNCTION platform.put_model_site_policy(",
    );

    expect(importFunction).not.toContain("model_inventory_pointer");
    expect(importFunction).toContain("model_inventory_import");
    expect(activationFunction).toContain("model_inventory_activation");
    expect(activationFunction).toContain("WHERE singleton IS TRUE FOR UPDATE");
    expect(activationFunction).toContain(
      "WHERE singleton IS TRUE AND revision=p_expected_revision",
    );
    expect(activationFunction).toContain("existing_activation.activated_revision,TRUE");
  });

  it("keeps the SQL catalog route invariants aligned with the domain", async () => {
    const migration = await readFile(
      resolve("prisma/migrations/0003_model_control/migration.sql"),
      "utf8",
    );
    expect(migration).toContain("item->>'role'='main' AND item->>'position'='0'");
    expect(migration).toContain("item->'requiredCapabilities' ? 'chat'");
    expect(migration).toContain("item->>'role'='generation' AND item->>'position'='0'");
    expect(migration).toContain("item->'requiredCapabilities' ? (product_name||'.generate')");
  });

  it("exposes runtime ModelControl through safe projections instead of raw catalog reads", async () => {
    const [migration, repository, migrator] = await Promise.all([
      readFile(resolve("prisma/migrations/0003_model_control/migration.sql"), "utf8"),
      readFile(
        resolve("src/modules/model-control/infrastructure/postgres/model-control-repository.ts"),
        "utf8",
      ),
      readFile(resolve("src/infrastructure/postgres/migrator.ts"), "utf8"),
    ]);

    expect(migration).toContain("platform.resolve_model_candidates");
    expect(migration).toContain("platform.find_model_selection_decision");
    expect(repository).toContain("FROM platform.resolve_model_candidates(");
    expect(repository).toContain("FROM platform.find_model_selection_decision(");
    expect(repository).not.toContain("FROM platform.model_provider_snapshot");
    expect(repository).not.toContain("FROM platform.model_inventory_import");
    expect(migrator).not.toContain("GRANT SELECT ON TABLE ${KERNEL_AND_MODEL_TABLES}");
    expect(migrator).not.toContain("GRANT SELECT ON TABLE platform.model_provider_snapshot");
  });

  it("keeps Admin on exactly three management functions", async () => {
    const migrator = await readFile(resolve("src/infrastructure/postgres/migrator.ts"), "utf8");
    const adminGrant = between(
      migrator,
      "GRANT EXECUTE ON FUNCTION platform.import_model_inventory",
      "TO ${identifier}`",
    );
    expect(adminGrant.match(/platform\.[a-z_]+\(/gu)).toHaveLength(3);
    expect(adminGrant).toContain("platform.import_model_inventory");
    expect(adminGrant).toContain("platform.activate_model_inventory");
    expect(adminGrant).toContain("platform.put_model_site_policy");
  });

  it("bootstraps operational provider availability without rewriting it as catalog state", async () => {
    const [migration, exporter, repository] = await Promise.all([
      readFile(resolve("prisma/migrations/0003_model_control/migration.sql"), "utf8"),
      readFile(resolve("scripts/model-control/export-legacy.mts"), "utf8"),
      readFile(
        resolve("src/modules/model-control/infrastructure/postgres/model-control-repository.ts"),
        "utf8",
      ),
    ]);
    expect(exporter).toContain("healthStatus");
    expect(exporter).toContain("providerAvailability");
    expect(migration).toContain("p_provider_availability JSONB");
    expect(migration).not.toContain(
      "SELECT item->>'key','active','unknown',0 FROM jsonb_array_elements(canonical_payload->'providers')",
    );
    expect(repository).toContain("input.providerAvailability");
    expect(migration).toContain("platform.report_model_provider_availability");
    expect(migratorWorkerGrant(repository, migration)).toBe(true);
  });

  it("permits one signed migration workload to replay deterministic policies for every Site", async () => {
    const [migration, service, packageManifest] = await Promise.all([
      readFile(resolve("prisma/migrations/0003_model_control/migration.sql"), "utf8"),
      readFile(
        resolve("src/modules/model-control/application/services/change-site-model-policy.ts"),
        "utf8",
      ),
      readFile(resolve("package.json"), "utf8"),
    ]);
    expect(service).toContain("model_control_migration");
    expect(service).toContain("model:site-policy:migrate");
    expect(migration).toContain("set_config('app.site_id',site_key,true)");
    expect(packageManifest).toContain("model-control:import-bundle");
  });

  it("exports legacy state only under an explicit cross-source consistency fence", async () => {
    const [exporter, snapshot] = await Promise.all([
      readFile(resolve("scripts/model-control/export-legacy.mts"), "utf8"),
      readFile(resolve("src/modules/model-control/migration/legacy-export-snapshot.ts"), "utf8"),
    ]);
    expect(exporter).toContain('argument("--fence-token")');
    expect(exporter).toContain('argument("--fenced-at")');
    expect(exporter).toContain("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
    expect(exporter).toContain("captureCrossDatabase");
    expect(exporter).toContain("COMBINED_WATERMARK_SQL");
    expect(snapshot).toContain("assertSameWatermark");
    expect(snapshot).toContain("MODEL_LEGACY_EXPORT_FENCE_VIOLATED");
  });

  it("keeps SQL import schemas closed and validates only published products", async () => {
    const migration = await readFile(
      resolve("prisma/migrations/0003_model_control/migration.sql"),
      "utf8",
    );
    expect(migration).toContain("MODEL_INVENTORY_PAYLOAD_UNKNOWN_FIELD");
    expect(migration).toContain("MODEL_SITE_POLICY_UNKNOWN_FIELD");
    expect(migration).toContain(
      "canonical_payload - ARRAY['schemaVersion','source','providers','models','bindings','productRoutes']",
    );
    expect(migration).toContain(
      "item - ARRAY['key','provider','accountKey','secretRef','adapterKind','priority']",
    );
    expect(migration).toContain(
      "IF EXISTS (SELECT 1 FROM jsonb_array_elements(canonical_payload->'productRoutes') route(item)",
    );
  });
});

function migratorWorkerGrant(repository: string, migration: string): boolean {
  return (
    migration.includes("model_provider_availability_report") &&
    repository.includes("reportProviderAvailability")
  );
}

function between(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) throw new Error("MODEL_CONTROL_MIGRATION_SECTION_MISSING");
  return source.slice(startIndex, endIndex);
}
