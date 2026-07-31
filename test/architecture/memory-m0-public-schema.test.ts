import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = join(process.cwd(),
  "prisma/migrations/20260813_memory_m0_public_authority/migration.sql");
const migration = readFileSync(migrationPath, "utf8");

describe("Memory M0.1 public database authority", () => {
  it("keeps revision headers immutable and moves every content byte into one erasable envelope", () => {
    expect(migration).toContain("CREATE TABLE platform.memory_revision_payload");
    expect(migration).toContain("FOREIGN KEY (site_ref,space_ref,entry_ref,revision,revision_ref)");
    expect(migration).toContain("envelope_version SMALLINT NOT NULL CHECK (envelope_version=1)");
    expect(migration).toContain("octet_length(nonce)=12");
    expect(migration).toContain("octet_length(authentication_tag)=16");
    expect(migration).toContain("aad_digest CHAR(64)");
    expect(migration).toContain("ALTER TABLE platform.memory_revision\n  DROP COLUMN protected_ciphertext");
    expect(migration).toContain("BEFORE UPDATE ON platform.memory_revision_payload");
    expect(migration).not.toMatch(/(?:plain|canonical)_?content\s+(?:TEXT|JSONB)/iu);
  });

  it("creates only the M0.1 command, transfer, purge and suppression authority tables", () => {
    for (const table of ["memory_public_command_inbox", "memory_import_job", "memory_export_job",
      "memory_purge_job", "memory_purge_participant_manifest",
      "memory_purge_revision_target", "memory_purge_participant_receipt",
      "memory_suppression_tombstone"]) {
      expect(migration).toContain(`CREATE TABLE platform.${table}`);
      expect(migration).toContain(`ALTER TABLE platform.${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE platform.${table} FORCE ROW LEVEL SECURITY`);
      expect(migration).toContain(`REVOKE ALL ON TABLE platform.${table} FROM PUBLIC`);
    }
    for (const participant of ["revision_payload", "public_presentation_cache",
      "import_quarantine_object", "export_object", "command_outbox_payload", "backup_object_gc"]) {
      expect(migration).toContain(`'${participant}','applicable'`);
    }
    for (const participant of ["lexical_index", "selection_snapshot", "context_use",
      "proposal_payload", "embedding", "ga_checkpoint_evidence"]) {
      expect(migration).toContain(`'${participant}','not_applicable'`);
    }
    expect(migration).not.toMatch(/CREATE TABLE platform\.memory_(?:selection|embedding|context_use)/u);
    expect(migration).toContain("suppression_fingerprint BYTEA");
    expect(migration).not.toContain("suppression_content_digest");
    expect(migration).toContain("revision_target_manifest_digest CHAR(64)");
    expect(migration).toContain("RETURN 'already_deleted'");
    expect(migration).toContain("RAISE EXCEPTION 'MEMORY_PURGE_TARGET_FORBIDDEN'");
    expect(migration).toContain("MEMORY_PURGE_REVISION_TARGETS_INCOMPLETE");
  });

  it("pins three actual least-privilege login OIDs while runtime remains grant-free", () => {
    const provision = readFileSync(join(process.cwd(), "scripts/ci/provision-platform-postgres.sql"), "utf8");
    for (const role of ["platform_memory_public", "platform_memory_runtime", "platform_memory_worker"]) {
      expect(provision).toContain(`CREATE ROLE ${role}`);
      expect(provision).toMatch(new RegExp(
        `CREATE ROLE ${role}\\s+LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
        "u",
      ));
      expect(migration).toContain(`'${role}'`);
    }
    expect(migration).toContain("CREATE TABLE platform.memory_database_role_identity");
    expect(migration).toContain("actual_oid<>expected_oid");
    expect(migration).toContain("SESSION_USER<>expected_name::TEXT");
    expect(migration).toContain("REVOKE CREATE,TEMPORARY ON DATABASE");
    expect(migration).toContain("REVOKE CREATE,USAGE ON SCHEMA public FROM");
    expect(migration).not.toMatch(/GRANT EXECUTE[^;]+TO platform_memory_runtime/isu);
    expect(migration).not.toMatch(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)[^;]+TO platform_memory_/isu);
  });

  it("exposes only operation-specific definers with exact live owner facts and no GUC authority", () => {
    for (const routine of ["memory_public_authorize_read", "memory_public_authorize_command",
      "memory_worker_claim_purge", "memory_worker_delete_revision_payload",
      "memory_worker_record_purge_receipt"]) {
      expect(migration).toContain(`CREATE FUNCTION platform.${routine}`);
      expect(migration).toContain(`REVOKE ALL ON FUNCTION platform.${routine}`);
    }
    expect(migration).toContain("subject_row.subject_generation=p_subject_generation");
    expect(migration).toContain("membership.membership_epoch=p_membership_epoch");
    expect(migration).toContain("membership.authorization_epoch=p_authorization_epoch");
    expect(migration).toContain("release.feature_policy_revision=p_feature_policy_revision_ref");
    expect(migration).not.toContain("current_setting('app.");
    expect(migration).toContain("MEMORY_PUBLIC_OWNER_AUTHORITY_FORBIDDEN");
  });
});
