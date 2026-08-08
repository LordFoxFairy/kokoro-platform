import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationPath =
  "prisma/migrations/20260825_site_publication_runtime_authority/migration.sql";
const candidateMigrationPath =
  "prisma/migrations/20260818_site_publication_candidate_authority/migration.sql";

describe("Site publication runtime authority schema", () => {
  it("stores immutable effective access, issuer, trust, and admitted envelope facts", async () => {
    const sql = await readFile(migrationPath, "utf8");
    for (const relation of [
      "site_effective_access_authority_revision",
      "site_web_build_intent_issuer_revision",
      "site_web_build_intent_issuer_head",
      "site_web_build_intent_envelope",
      "site_release_producer_trust_revision",
      "site_release_attestation_envelope",
      "site_release_evidence_decision",
    ]) expect(sql).toContain(`CREATE TABLE platform.${relation}`);
    expect(sql).toContain("reject_immutable_site_publication_runtime_authority_mutation");
    expect(sql).not.toContain("REFERENCES platform.site_release(");
  });

  it("forces scoped RLS, revokes PUBLIC, and keeps machine evidence off operator policies", async () => {
    const sql = await readFile(migrationPath, "utf8");
    for (const relation of [
      "site_effective_access_authority_revision",
      "site_web_build_intent_issuer_revision",
      "site_web_build_intent_issuer_head",
      "site_web_build_intent_envelope",
      "site_release_producer_trust_revision",
      "site_release_attestation_envelope",
      "site_release_evidence_decision",
    ]) {
      expect(sql).toContain(`ALTER TABLE platform.${relation} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE platform.${relation} FORCE ROW LEVEL SECURITY`);
      expect(sql).toContain(`REVOKE ALL ON TABLE platform.${relation} FROM PUBLIC`);
    }
    expect(sql).toContain("subject_kind='release-certification'");
    expect(sql).not.toMatch(/platform_admin[\s\S]{0,240}subject_kind='web-artifact-provenance'/u);
    expect(sql).not.toContain("GRANT INSERT ON TABLE platform.site_release_attestation_envelope");
    expect(sql).toContain(
      "payload_type='application/vnd.kokoro.web-build-intent.v1+json'",
    );
    expect(sql).toContain("CREATE POLICY site_web_build_intent_envelope_admin");
  });

  it("has an explicit sealed static bootstrap and no dynamic signature bootstrap", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toContain("platform.bootstrap_site_publication_authorities(JSONB, CHAR(64))");
    expect(sql).toContain("SITE_PUBLICATION_AUTHORITY_BOOTSTRAP_SEALED");
    expect(sql).toContain("REVOKE ALL ON FUNCTION platform.bootstrap_site_publication_authorities(JSONB, CHAR(64)) FROM PUBLIC");
    const bootstrap = sql.slice(
      sql.indexOf("CREATE FUNCTION platform.bootstrap_site_publication_authorities"),
      sql.indexOf("CREATE FUNCTION platform.reject_immutable_site_publication_runtime_authority_mutation"),
    );
    expect(bootstrap).not.toContain("site_release_attestation_envelope");
    expect(bootstrap).not.toContain("detached_signature");
  });

  it("rejects bootstrap deletion and requires every top-level and nested authority key", async () => {
    const sql = await readFile(migrationPath, "utf8");
    const guard = sql.slice(
      sql.indexOf("CREATE FUNCTION platform.guard_site_publication_authority_bootstrap_seal"),
      sql.indexOf("CREATE TRIGGER site_publication_authority_bootstrap_seal"),
    );
    expect(guard).toContain("IF TG_OP='DELETE' THEN");
    expect(guard.indexOf("TG_OP='DELETE'")).toBeLessThan(guard.indexOf("NEW.state"));

    const bootstrap = sql.slice(
      sql.indexOf("CREATE FUNCTION platform.bootstrap_site_publication_authorities"),
      sql.indexOf("CREATE FUNCTION platform.reject_immutable_site_publication_runtime_authority_mutation"),
    );
    expect(bootstrap).toContain(
      "p_document ?& ARRAY['version','effectiveAccess','intentIssuers','producerTrust']",
    );
    expect(bootstrap).toContain(
      "item ?& ARRAY['siteRef','environment','launchProductProfile','productSurfaceCatalog'",
    );
    expect(bootstrap).toContain(
      "item ?& ARRAY['authorityRef','authorityRevision','authorityDigest','siteRef','environment'",
    );
    expect(bootstrap).toContain(
      "item ?& ARRAY['producerIdentityRef','producerRole','environment','producerRegistration'",
    );
    expect(bootstrap).toContain(
      "(item->'launchProductProfile') ?& ARRAY['ref','revision','digest']",
    );
    expect(bootstrap).toContain(
      "(item->'webCompositionRegistry') ?& ARRAY['ref','revision','digest']",
    );
    expect(bootstrap).toContain(
      "(item->'producerRegistration') ?& ARRAY['ref','revision','digest']",
    );
  });

  it("allows Site candidate assembly to read exact Product owner rows", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toContain("CREATE POLICY product_catalog_revision_site_candidate_read");
    expect(sql).toContain("CREATE POLICY launch_product_profile_site_candidate_read");
    expect(sql).toContain("current_setting('app.operation',true)='site.release-candidate.authorize'");
  });

  it("binds machine evidence reads and writes to the live workload authorization", async () => {
    const runtimeSql = await readFile(migrationPath, "utf8");
    const candidateSql = await readFile(candidateMigrationPath, "utf8");
    expect(runtimeSql).toContain("CREATE POLICY site_project_binding_evidence_admission_read");
    expect(runtimeSql).toContain("CREATE POLICY site_evidence_producer_trust_read");
    expect(runtimeSql).toContain("CREATE POLICY site_evidence_attestation_read");
    expect(runtimeSql).toContain("CREATE POLICY site_evidence_decision_read");
    for (const sql of [runtimeSql, candidateSql]) {
      expect(sql).toContain("current_setting('app.workload_identity_ref',true)");
      expect(sql).toContain("current_setting('app.workload_binding_epoch',true)");
      expect(sql).toContain("binding.state='active'");
      expect(sql).toContain("current_setting('app.operation',true)='site.release-evidence.publish'");
    }
    const bindingPolicy = runtimeSql.slice(
      runtimeSql.indexOf("CREATE POLICY site_project_binding_evidence_admission_read"),
      runtimeSql.indexOf("CREATE POLICY site_evidence_producer_trust_read"),
    );
    expect(bindingPolicy).toContain("current_setting('app.workload_kind',true)='platform_admission'");
    expect(bindingPolicy).toContain("current_setting('app.actor_kind',true)='workload'");
    expect(bindingPolicy).toContain("current_setting('app.operation',true)='site.evidence.authorize'");
    expect(bindingPolicy).toContain("binding_ref=current_setting('app.site_project_binding_ref',true)");
    expect(bindingPolicy).toContain("binding_epoch=current_setting('app.workload_binding_epoch',true)::BIGINT");

    const evidencePolicies = candidateSql.slice(
      candidateSql.indexOf("CREATE POLICY site_release_candidate_scope"),
      candidateSql.indexOf("CREATE POLICY site_active_release_pointer_scope"),
    );
    expect(evidencePolicies).toContain("binding.workload_identity_id=current_setting('app.workload_identity_ref',true)");
    expect(evidencePolicies).toContain("binding.binding_epoch=current_setting('app.workload_binding_epoch',true)::BIGINT");
    expect(evidencePolicies).toContain("binding.environment=current_setting('app.environment',true)");
    expect(evidencePolicies).toContain("binding.region=current_setting('app.region',true)");
  });

  it("keeps dormant activation policies aligned with the real Admin workload identity", async () => {
    const sql = await readFile(candidateMigrationPath, "utf8");
    const activationPolicies = sql.slice(
      sql.indexOf("CREATE POLICY site_active_release_pointer_scope"),
      sql.indexOf("REVOKE ALL ON TABLE platform.site_release_candidate_authority"),
    );
    expect(activationPolicies).toContain("current_setting('app.workload_kind',true)='admin_workload'");
    expect(activationPolicies).toContain("current_setting('app.operation',true)='site.activation.begin'");
    expect(activationPolicies).not.toContain(
      "current_setting('app.workload_kind',true)='platform_admin'",
    );
  });

  it("binds operator publication writes to the real caller kind and exact operation", async () => {
    const candidateSql = await readFile(candidateMigrationPath, "utf8");
    const candidatePolicies = candidateSql.slice(
      candidateSql.indexOf("CREATE POLICY site_release_candidate_scope"),
      candidateSql.indexOf("CREATE POLICY site_active_release_pointer_scope"),
    );
    expect(candidatePolicies).toContain("current_setting('app.workload_kind',true)='admin_workload'");
    expect(candidatePolicies).not.toContain(
      "current_setting('app.workload_kind',true)='platform_admin'",
    );
    for (const operation of [
      "site.release-candidate.authorize",
      "site.release-candidate.revoke",
      "site.surface-inventory.publish",
      "site.web-build-material-bundle.publish",
      "site.web-build-intent.publish",
      "site.release-certification.publish",
      "site.release.publish",
    ]) expect(candidatePolicies).toContain(`'${operation}'`);
    for (const binding of [
      "publication_kind='surface-inventory' AND producer_kind='operator-approved'",
      "publication_kind='web-build-material-bundle' AND producer_kind='operator-approved'",
      "publication_kind='web-build-intent' AND producer_kind='platform-issued'",
      "publication_kind='release-certification' AND producer_kind='certifier-signed'",
      "publication_kind='site-release' AND producer_kind='platform-issued'",
    ]) expect(candidatePolicies).toContain(binding);

    const runtimeSql = await readFile(migrationPath, "utf8");
    const commandPolicies = runtimeSql.slice(
      runtimeSql.indexOf("CREATE POLICY site_effective_access_candidate_read"),
      runtimeSql.indexOf("REVOKE ALL ON TABLE platform.site_publication_authority_bootstrap"),
    );
    expect(commandPolicies).toContain("current_setting('app.workload_kind',true)='admin_workload'");
    expect(commandPolicies).not.toContain(
      "current_setting('app.workload_kind',true)='platform_admin'",
    );
  });
});
