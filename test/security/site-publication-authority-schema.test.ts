import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Site publication authority schema", () => {
  it("persists the immutable authority DAG and a separate CAS pointer", async () => {
    const sql = await readFile(new URL(
      "../../prisma/migrations/20260818_site_publication_candidate_authority/migration.sql",
      import.meta.url,
    ), "utf8");
    for (const table of [
      "site_release_candidate_authority", "site_release_candidate_authorization",
      "site_publication_revision",
      "site_active_release_pointer", "site_activation_authority_snapshot",
      "site_activation_eligibility_evidence",
    ]) expect(sql).toContain(`CREATE TABLE platform.${table}`);
    expect(sql).toContain("UNIQUE (publication_kind,candidate_ref,candidate_version)");
    expect(sql).toContain("CHECK (active_release_kind='site-release')");
    expect(sql).toContain("BEFORE UPDATE OR DELETE ON platform.site_publication_revision");
    expect(sql).toContain("site_candidate_authorization_epoch_guard");
    expect(sql).not.toContain("site_one_authorized_release_candidate");
    expect(sql).toContain("phase='pre-cas'");
    expect(sql.match(/FORCE ROW LEVEL SECURITY/gu)?.length).toBe(6);
    for (const column of [
      "candidate_version",
      "candidate_authorization_epoch",
      "profile_revision",
      "catalog_revision",
      "authorization_epoch",
      "revision",
      "generation",
      "active_release_revision",
      "release_revision",
      "certification_revocation_epoch",
      "active_pointer_generation",
    ]) {
      expect(sql).not.toMatch(new RegExp(`^\\s*${column}\\s+BIGINT\\b`, "mu"));
    }
    const workloadBindingEpochCast =
      "binding.binding_epoch=current_setting('app.workload_binding_epoch',true)::BIGINT";
    expect(sql.split(workloadBindingEpochCast)).toHaveLength(5);
    expect(sql.match(/\bBIGINT\b/gu)).toHaveLength(4);
    expect(sql).not.toContain("candidate_release_ref");
    expect(sql).not.toContain("expected_active_release_ref");
  });

  it("stays runtime-inert instead of granting authority to retired fixed roles", async () => {
    const sql = await readFile(new URL(
      "../../prisma/migrations/20260818_site_publication_candidate_authority/migration.sql",
      import.meta.url,
    ), "utf8");
    expect(sql).not.toMatch(/GRANT [^;]+ TO platform_(?:admin|worker);/gu);
  });
});
