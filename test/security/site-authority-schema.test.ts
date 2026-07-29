import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../prisma/migrations/20260730_site_authority/migration.sql", import.meta.url),
  "utf8",
);

describe("Site authority schema", () => {
  it("owns Site, immutable Release, project/deployment binding and durable activation facts", () => {
    for (const table of [
      "site", "site_project_binding", "site_release", "site_deployment_binding",
      "site_activation_attempt", "site_deployment_observation", "site_traffic_stop_attempt",
      "site_traffic_stop_observation",
    ]) expect(migration).toContain(`CREATE TABLE platform.${table}`);
    expect(migration).toContain("site_release_immutable_facts");
    expect(migration).toContain("site_deployment_observation_immutable");
    expect(migration).toContain("site_decommissioned_terminal");
    expect(migration).toContain("UNIQUE(workload_identity_id)");
    expect(migration).toContain("UNIQUE(deployment_ref)");
    expect(migration).toContain("WHERE state='active'");
    expect(migration).toContain("runtime_binding_epoch BIGINT NOT NULL DEFAULT 1");
    expect(migration).toContain("site_runtime_binding_epoch_monotonic");
    expect(migration).toContain("site_traffic_stop_observation_immutable");
    expect(migration).toContain("provider_namespace TEXT NOT NULL");
    expect(migration).toContain("UNIQUE(provider_namespace,provider_project_ref,environment)");
  });

  it("keeps runtime roles least-privileged and revokes PUBLIC", () => {
    expect(migration).toContain("REVOKE ALL ON");
    expect(migration).toContain("FROM PUBLIC");
    expect(migration).not.toMatch(/GRANT\s+ALL/iu);
    expect(migration).not.toMatch(/ON\s+TABLE[\s\S]*?TO\s+PUBLIC/iu);
  });
});
