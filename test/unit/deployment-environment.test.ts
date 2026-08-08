import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEPLOYMENT_ENVIRONMENTS,
  isDeploymentEnvironment,
} from "../../src/shared/deployment-environment.js";

describe("Deployment environment vocabulary", () => {
  it("defines the exact four production deployment stages", () => {
    expect(DEPLOYMENT_ENVIRONMENTS).toEqual([
      "development",
      "preview",
      "staging",
      "production",
    ]);
    expect(DEPLOYMENT_ENVIRONMENTS.every(isDeploymentEnvironment)).toBe(true);
  });

  it("rejects aliases, casing drift, and non-string values", () => {
    for (const value of ["dev", "stage", "qa", "Staging", "", null, 1]) {
      expect(isDeploymentEnvironment(value)).toBe(false);
    }
  });

  it("uses the same four values in every persisted runtime boundary", () => {
    for (const path of [
      "prisma/migrations/20260728_session_access_authorization/migration.sql",
      "prisma/migrations/20260730_site_authority/migration.sql",
      "prisma/migrations/20260824_admin_pending_approval_projection/migration.sql",
    ]) {
      const sql = readFileSync(path, "utf8");
      expect(sql).not.toContain("('development','preview','production')");
      expect(sql).toContain("('development','preview','staging','production')");
    }
  });
});
