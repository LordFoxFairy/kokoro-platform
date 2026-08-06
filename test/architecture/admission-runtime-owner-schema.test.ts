import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Admission immutable runtime owner schema", () => {
  it("pins launch and capability projections to an exact SiteRelease and freezes them", async () => {
    const [migration, schema, migrator] = await Promise.all([
      readFile(resolve("prisma/migrations/20260731_admission_runtime_owners/migration.sql"), "utf8"),
      readFile(resolve("prisma/schema.prisma"), "utf8"),
      readFile(resolve("src/infrastructure/postgres/migrator.ts"), "utf8"),
    ]);
    expect(migration).toContain("CREATE TABLE platform.admission_launch_profile_snapshot");
    expect(migration).toContain("CREATE TABLE platform.admission_capability_catalog_snapshot");
    expect(migration).toContain("CREATE TABLE platform.capability_projection_command");
    expect(migration).toContain("signature_payload_digest CHAR(64) NOT NULL");
    expect(migration).toContain("signature BYTEA NOT NULL CHECK(octet_length(signature)=64)");
    expect(migration).toContain("REFERENCES platform.site_release(release_ref,site_ref)");
    expect(migration).toContain("admission_launch_profile_immutable");
    expect(migration).toContain("admission_capability_catalog_immutable");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(schema).toContain("model AdmissionLaunchProfileSnapshot");
    expect(schema).toContain("model AdmissionCapabilityCatalogSnapshot");
    expect(schema).toContain("model CapabilityProjectionCommand");
    expect(migrator).toContain('"platform.admission_launch_profile_snapshot"');
    expect(migrator).toContain('"platform.admission_capability_catalog_snapshot"');
    expect(migrator).toMatch(
      /GRANT INSERT ON TABLE[^`]*platform\.admission_capability_catalog_snapshot[^`]*platform\.capability_projection_command/u,
    );
  });

  it("allows the production Admission role to execute its capability projection operation", async () => {
    const [client, composition, repository] = await Promise.all([
      readFile(resolve("src/infrastructure/postgres/client.ts"), "utf8"),
      readFile(resolve("src/process/admission-composition.ts"), "utf8"),
      readFile(resolve(
        "src/modules/admission/infrastructure/postgres/capability-catalog-projection-repository.ts",
      ), "utf8"),
    ]);
    expect(composition).toContain(
      "new PostgresCapabilityCatalogProjectionRepository(input.database",
    );
    expect(repository).toContain('internalTransaction("capability.projection"');
    const admissionOperations = client.match(
      /config\.role === "admission"[\s\S]*?(?=: workerAuthority !== undefined)/u,
    )?.[0];
    expect(admissionOperations).toContain('operation === "capability.projection"');
  });
});
