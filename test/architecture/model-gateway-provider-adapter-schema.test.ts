import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationPath =
  "prisma/migrations/20260802_1200_model_gateway_attempt_producer/migration.sql";
const obsoleteMigrationPath =
  "prisma/migrations/20260824_model_gateway_optional_litellm_adapter/migration.sql";

describe("Model Gateway provider adapter schema", () => {
  it("preserves Direct and LiteLLM as exact authorization choices", async () => {
    const migration = await readFile(migrationPath, "utf8");

    expect(migration).toContain("CHECK (adapter_kind IN ('direct','litellm'))");
    expect(migration).toContain("provider_model TEXT NOT NULL");
    expect(migration).toContain(
      "CREATE FUNCTION platform.resolve_model_gateway_authorization",
    );
    expect(migration).not.toContain("gateway_authorization.adapter_kind='litellm'");
    expect(migration).toContain("gateway_authorization.adapter_kind");
    expect(migration).toContain("gateway_authorization.provider_model");
    expect(migration).toContain("OLD.provider_model IS DISTINCT FROM NEW.provider_model");
    expect(migration).toContain("REVOKE ALL ON FUNCTION platform.resolve_model_gateway_authorization");
  });

  it("has no post-baseline compatibility migration", async () => {
    await expect(access(obsoleteMigrationPath)).rejects.toThrow();
  });
});
