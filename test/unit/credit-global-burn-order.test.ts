import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const commerceCoreMigration = readFileSync(new URL(
  "../../prisma/migrations/20260729_wave_2a_commerce_core/migration.sql",
  import.meta.url,
), "utf8");
const globalBurnOrderMigration = readFileSync(new URL(
  "../../prisma/migrations/20260817_credit_global_burn_order/migration.sql",
  import.meta.url,
), "utf8");

describe("Credit Grant global burn-order migration", () => {
  it("reuses the acquisition timestamp created by the Commerce core migration", () => {
    expect(commerceCoreMigration).toMatch(
      /CREATE TABLE platform\.credit_grant \([\s\S]*?acquired_at TIMESTAMPTZ NOT NULL/u,
    );
    expect(globalBurnOrderMigration).not.toMatch(/ADD COLUMN acquired_at/u);
    expect(globalBurnOrderMigration).toContain("acquired_at ASC");
  });
});
