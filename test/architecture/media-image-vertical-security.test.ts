import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL(
  "../../prisma/migrations/20260809_media_artifact_image_vertical/migration.sql",
  import.meta.url,
), "utf8");
const submitRepository = readFileSync(new URL(
  "../../src/modules/media/infrastructure/postgres/media-image-operation-repository.ts",
  import.meta.url,
), "utf8");

describe("Media/Artifact image vertical database boundary", () => {
  it("uses encrypted-only canonical input persistence", () => {
    const inputTable = table("media_operation_input_revision");
    expect(inputTable).toContain("ciphertext BYTEA NOT NULL");
    expect(inputTable).toContain("wrapped_dek BYTEA NOT NULL");
    expect(inputTable).not.toMatch(/\bprompt\b|request_json|input_json/iu);
  });

  it("binds command and candidate ownership to subject generation and project", () => {
    const journal = table("media_command_journal");
    expect(journal).toContain("subject_generation BIGINT NOT NULL");
    expect(journal).toContain("project_ref TEXT NOT NULL");
    expect(journal).toContain(
      "PRIMARY KEY(caller_audience,site_ref,subject_ref,subject_generation,project_ref,command_ref)",
    );
    const candidate = table("media_candidate");
    expect(candidate).toContain("subject_generation BIGINT NOT NULL");
    expect(candidate).toContain("project_ref TEXT NOT NULL");
    expect(candidate).toContain(
      "FOREIGN KEY(operation_ref,site_ref,subject_ref,subject_generation,project_ref)",
    );
    expect(migration).toMatch(/CREATE POLICY media_candidate_public_scope[\s\S]+subject_generation[\s\S]+project_ref/u);
  });

  it("keeps runtime access behind exact role identity and fixed-search-path routines", () => {
    expect(migration).toContain("role_oid OID NOT NULL UNIQUE");
    expect(migration).toContain("IF SESSION_USER<>expected_name::TEXT OR actual_oid<>expected_oid");
    expect(migration).toContain("SET search_path=pg_catalog,platform");
    expect(migration).toContain("REVOKE ALL ON FUNCTION platform.resolve_media_access(CHAR,CHAR) FROM PUBLIC");
    expect(migration).toContain("REVOKE ALL ON FUNCTION platform.begin_media_image_command(");
    expect(migration).toContain("REVOKE ALL ON FUNCTION platform.commit_media_image_operation(JSONB,CHAR) FROM PUBLIC");
    expect(migration).toContain("REVOKE ALL ON FUNCTION platform.recover_agent_media_command(CHAR,TEXT,TEXT) FROM PUBLIC");
    expect(migration).toContain("REVOKE ALL ON FUNCTION platform.get_agent_media_operation(CHAR,TEXT) FROM PUBLIC");
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION platform.assert_media_runtime_role(TEXT)\n  TO platform_media_runtime,platform_media_worker",
    );
    expect(migration).toContain("CREATE POLICY media_operation_runtime_definer");
    expect(migration).toContain("REVOKE CREATE ON SCHEMA platform FROM platform_media_public,platform_media_runtime,platform_media_worker");
  });

  it("keeps the Agent submit adapter function-only", () => {
    expect(submitRepository).toContain("platform.begin_media_image_command");
    expect(submitRepository).toContain("platform.commit_media_image_operation");
    expect(submitRepository).not.toMatch(
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+platform\.(?:media_|artifact)/iu,
    );
    expect(migration).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[\s\S]{0,160}\bTO\s+platform_media_runtime\b/iu,
    );
  });

  it("derives the FORCE-RLS Credit scope from the opaque access pair", () => {
    const resolver = routine("resolve_media_access");
    expect(resolver).toContain("projection_reservation_digest=p_projection_reservation_digest");
    expect(resolver).toContain("PERFORM set_config('app.site_id',resolved_site_ref,true)");
    expect(resolver).not.toContain("p_site_ref");
  });

  it("uses exact owner composite foreign keys across Artifact and command references", () => {
    expect(migration).toContain(
      "FOREIGN KEY(operation_ref,site_ref,subject_ref,subject_generation,project_ref)",
    );
    expect(migration).toContain(
      "FOREIGN KEY(artifact_ref,site_ref,subject_ref,subject_generation,project_ref)",
    );
    expect(migration).toContain(
      "FOREIGN KEY(artifact_ref,artifact_version_ref,site_ref,subject_ref,subject_generation,project_ref)",
    );
  });
});

function table(name: string): string {
  const matched = migration.match(new RegExp(`CREATE TABLE platform\\.${name} \\(([\\s\\S]+?)\\n\\);`, "u"));
  if (matched?.[1] === undefined) throw new Error(`missing table ${name}`);
  return matched[1];
}

function routine(name: string): string {
  const matched = migration.match(new RegExp(
    `CREATE FUNCTION platform\\.${name}\\([\\s\\S]+?\\n\\$\\$;`,
    "u",
  ));
  if (matched?.[0] === undefined) throw new Error(`missing routine ${name}`);
  return matched[0];
}
