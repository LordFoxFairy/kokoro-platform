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
});

function between(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) throw new Error("MODEL_CONTROL_MIGRATION_SECTION_MISSING");
  return source.slice(startIndex, endIndex);
}
