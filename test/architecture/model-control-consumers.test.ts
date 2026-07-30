import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("ModelControl consumer boundary", () => {
  it("has no new local self-RPC consumer", async () => {
    const files = await Promise.all(
      [
        "src/modules/model-control/application/contracts/model-control-ports.ts",
        "src/process/model-option-admin-composition.ts",
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

  it("keeps Admin on the explicit inventory, policy, and ModelOption management functions", async () => {
    const migrator = await readFile(resolve("src/infrastructure/postgres/migrator.ts"), "utf8");
    const adminGrant = between(
      migrator,
      "GRANT EXECUTE ON FUNCTION platform.import_model_inventory",
      "TO ${identifier}`",
    );
    expect(adminGrant.match(/platform\.[a-z_]+\(/gu)).toHaveLength(7);
    expect(adminGrant).toContain("platform.import_model_inventory");
    expect(adminGrant).toContain("platform.activate_model_inventory");
    expect(adminGrant).toContain("platform.put_model_site_policy");
    expect(adminGrant).toContain("platform.load_model_option_inventory");
    expect(adminGrant).toContain("platform.load_model_option_revisions");
    expect(adminGrant).toContain("platform.materialize_legacy_model_options");
    expect(adminGrant).toContain("platform.publish_site_release_model_catalog");
  });

  it("owns ModelOption facts relationally and exposes only exact-Site safe projections", async () => {
    const migration = await readFile(
      resolve("prisma/migrations/20260729_product_model_options/migration.sql"),
      "utf8",
    );
    for (const relation of [
      "model_option_materialization",
      "model_option_revision",
      "model_option_role_binding",
      "model_option_materialization_quarantine",
      "site_release_model_catalog_publication",
      "site_release_model_catalog_surface",
      "site_release_model_catalog_option",
    ]) {
      expect(migration).toContain(`platform.${relation}`);
    }
    expect(migration).toContain("FOREIGN KEY(site_release_ref,site_id,model_option_catalog_ref)");
    expect(migration).toContain("REFERENCES platform.authorization_site_release");
    expect(migration).toContain("MODEL_OPTION_PUBLICATION_ID_CONFLICT");
    expect(migration).toContain("MODEL_OPTION_MATERIALIZATION_ID_CONFLICT");
    expect(migration).toContain("platform.resolve_product_model_option_catalog");
    expect(migration).toContain("model_availability.status='active'");
    expect(migration).toContain("provider_availability.health IN ('healthy','degraded')");
    expect(migration).not.toContain("default 'available'");
  });

  it("wires the public binary and executable admin commands to the PostgreSQL owner", async () => {
    const [api, publicComposition, adminComposition, manifest] = await Promise.all([
      readFile(resolve("src/process/api.ts"), "utf8"),
      readFile(resolve("src/process/platform-public-composition.ts"), "utf8"),
      readFile(resolve("src/process/model-option-admin-composition.ts"), "utf8"),
      readFile(resolve("package.json"), "utf8"),
    ]);
    expect(api).toContain("runPlatformApiMain(): Promise<void>");
    expect(api).toContain("await runPlatformApiMain()");
    expect(api).not.toContain("failStandaloneWithoutModelOptionOwner");
    expect(publicComposition).toContain("new PostgresProductModelOptionCatalogReader()");
    expect(adminComposition).toContain("new PublishSiteReleaseModelCatalogService");
    expect(adminComposition).toContain("new PostgresModelControlCommandJournal()");
    expect(manifest).not.toContain("model-option:materialize-legacy");
    expect(manifest).toContain("model-option:publish-site-release");
  });

  it("journals every ModelControl command and exposes activation through a durable owner outbox", async () => {
    const [importService, activationService, policyService, journal, migrator] = await Promise.all([
      readFile(
        resolve("src/modules/model-control/application/services/import-model-control.ts"),
        "utf8",
      ),
      readFile(
        resolve("src/modules/model-control/application/services/activate-model-inventory.ts"),
        "utf8",
      ),
      readFile(
        resolve("src/modules/model-control/application/services/change-site-model-policy.ts"),
        "utf8",
      ),
      readFile(
        resolve(
          "src/modules/model-control/infrastructure/postgres/model-control-command-journal.ts",
        ),
        "utf8",
      ),
      readFile(resolve("src/infrastructure/postgres/migrator.ts"), "utf8"),
    ]);
    for (const service of [importService, activationService, policyService]) {
      expect(service).toContain("this.journal.begin(transaction, command)");
      expect(service).toContain("this.journal.succeed(transaction, command, receipt, context)");
    }
    expect(journal).toContain("owner: event.owner");
    expect(journal).toContain("eventType: event.eventType");
    expect(journal).toContain('state: "succeeded"');
    expect(migrator).toContain(
      "GRANT INSERT ON TABLE platform.command_receipt, platform.outbox_event",
    );
    expect(migrator).toContain("GRANT UPDATE ON TABLE platform.command_receipt");
  });

  it("keeps operational provider availability separate from catalog state", async () => {
    const [migration, repository] = await Promise.all([
      readFile(resolve("prisma/migrations/0003_model_control/migration.sql"), "utf8"),
      readFile(
        resolve("src/modules/model-control/infrastructure/postgres/model-control-repository.ts"),
        "utf8",
      ),
    ]);
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
    expect(migration).toContain("platform.model_identifier_is_valid");
    expect(migration).toContain("platform.model_text_is_valid");
    expect(migration).toContain("platform.model_identifier_array_is_canonical");
    expect(migration).toContain("MODEL_INVENTORY_PAYLOAD_NON_CANONICAL");
    expect(migration).toContain("CHECK (platform.model_identifier_is_valid(provider_key))");
    expect(migration).toContain("CHECK (platform.model_secret_reference_is_valid(secret_ref))");
    expect(migration).toContain(
      "CHECK (platform.model_identifier_array_is_canonical(capabilities, TRUE))",
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
