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
const lifecycleOwner = readFileSync(new URL(
  "../../src/modules/admission/infrastructure/postgres/admission-lifecycle-owner.ts",
  import.meta.url,
), "utf8");
const artifactObjectStore = readFileSync(new URL(
  "../../src/modules/artifact/infrastructure/s3/s3-artifact-object-store.ts",
  import.meta.url,
), "utf8");
const mediaComposition = readFileSync(new URL(
  "../../src/process/media-runtime-composition.ts",
  import.meta.url,
), "utf8");
const localCreditOwner = readFileSync(new URL(
  "../../src/process/media-image-local-credit-owner.ts",
  import.meta.url,
), "utf8");
const typedUsageMigration = readFileSync(new URL(
  "../../prisma/migrations/20260811_media_image_typed_usage_materializer/migration.sql",
  import.meta.url,
), "utf8");
const workerDatabase = readFileSync(new URL(
  "../../src/modules/media/infrastructure/postgres/media-image-worker-database.ts",
  import.meta.url,
), "utf8");
const admissionRoleAuthorityMigration = readFileSync(new URL(
  "../../prisma/migrations/20260822_admission_execution_root_role_authority/migration.sql",
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

  it("binds media-access reservation to the exact leased Admission role and site context", () => {
    expect(admissionRoleAuthorityMigration).toContain(
      "DROP POLICY admission_media_access_scope\n  ON platform.admission_media_access_authorization",
    );
    expect(admissionRoleAuthorityMigration).toContain(
      "CREATE POLICY admission_media_access_scope\n  ON platform.admission_media_access_authorization",
    );
    expect(admissionRoleAuthorityMigration).toContain(
      "platform.admission_role_identity_is_current()",
    );
    expect(admissionRoleAuthorityMigration).toContain(
      "current_setting('app.operation',true)='admission.command'",
    );
    expect(admissionRoleAuthorityMigration).toContain(
      "current_setting('app.workload_kind',true)='platform_admission'",
    );
    expect(admissionRoleAuthorityMigration).toContain(
      "site_id=NULLIF(current_setting('app.site_id',true),'')",
    );
  });

  it("keeps both submit adapters function-only", () => {
    expect(submitRepository).toContain("platform.begin_media_image_command");
    expect(submitRepository).toContain("platform.commit_media_image_operation");
    expect(submitRepository).toContain("platform.begin_direct_media_image_command");
    expect(submitRepository).toContain("platform.commit_direct_media_image_operation");
    expect(submitRepository).not.toMatch(
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+platform\.(?:media_|artifact)/iu,
    );
    expect(migration).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[\s\S]{0,160}\bTO\s+platform_media_runtime\b/iu,
    );
  });

  it("fixes Media child allocation to the native transaction owner in production composition", () => {
    const signature = mediaComposition.slice(
      mediaComposition.indexOf("export function createMediaRuntimeApplicationComposition"),
      mediaComposition.indexOf(">): MediaRuntimeApplicationComposition"),
    );
    expect(mediaComposition).toContain('budgets: Object.freeze({ kind: "agent_only" as const,');
    expect(mediaComposition).toContain("agentChild: new NativeMediaImageCreditOwner()");
    expect(signature).not.toContain("\n  budgets:");
    expect(localCreditOwner).toContain("new CreditService");
    expect(localCreditOwner).toContain("new PostgresCreditAuthorityRepository()");
    expect(localCreditOwner).not.toMatch(/@connectrpc|\bfetch\s*\(|node:https?|axios/iu);
  });

  it("derives the FORCE-RLS Credit scope from the opaque access pair", () => {
    const resolver = routine("resolve_media_access");
    expect(resolver).toContain("projection_reservation_digest=p_projection_reservation_digest");
    expect(resolver).toContain("PERFORM set_config('app.site_id',resolved_site_ref,true)");
    expect(resolver).toContain("LEAST(authority.expires_at,hold.expires_at,segment.expires_at)");
    expect(resolver).not.toContain("p_site_ref");
  });

  it("binds command creation and commit to the exact live opaque authorization pair", () => {
    const begin = routine("begin_media_image_command");
    const commit = routine("commit_media_image_operation");
    const journal = table("media_command_journal");
    expect(begin).toContain("p_handle_digest CHAR(64)");
    expect(begin).toContain("p_projection_reservation_digest CHAR(64)");
    expect(begin).toContain("item.state='active'");
    expect(begin).toContain("item.expires_at>statement_timestamp()");
    expect(journal).toContain("access_authorization_handle_digest CHAR(64) NOT NULL");
    expect(journal).toContain("projection_reservation_digest CHAR(64) NOT NULL");
    expect(journal).toContain("authorization_expires_at TIMESTAMPTZ NOT NULL");
    expect(journal).toContain("workload_ref TEXT NOT NULL");
    expect(journal).toContain("definition_revision_ref TEXT NOT NULL");
    expect(journal).toContain("model_option_revision_ref TEXT NOT NULL");
    expect(commit).toContain("JOIN platform.admission_media_access_authorization authority");
    expect(commit).toContain("authority.handle_digest=journal.access_authorization_handle_digest");
    expect(commit).toContain("authority.projection_reservation_digest=journal.projection_reservation_digest");
    expect(commit).toContain("authority.expires_at>statement_timestamp()");
    expect(commit).toContain("authority.execution_budget_root_ref=journal.credit_execution_budget_root_ref");
    expect(commit).toContain("authority.input_policy_decision_ref=journal.trust_input_decision_ref");
    expect(commit).toContain("root.root_allocation_ref=journal_record.credit_parent_allocation_ref");
    expect(commit).toContain("segment.state='committed'");
    expect(begin).toContain("LEAST(authority.expires_at,hold.expires_at,segment.expires_at)");
    expect(commit).toContain("segment.expires_at>=journal_record.credit_expires_at");
    expect(commit).toContain(
      "surface.default_model_option_revision_ref=journal_record.model_option_revision_ref",
    );
    expect(commit).toContain("credit_record->>'executionBudgetRootRef'<>journal_record.credit_execution_budget_root_ref::TEXT");
    expect(commit).toContain("p_record->>'trustInputDecisionRef'<>journal_record.trust_input_decision_ref");
  });

  it("loads composite command authorities with PostgreSQL-valid row assignment", () => {
    const commit = routine("commit_media_image_operation");
    expect(commit).not.toMatch(
      /SELECT\s+journal\s*,\s*authority\s+INTO\s+STRICT\s+journal_record\s*,\s*authority_record/iu,
    );
    expect(commit).toContain("SELECT journal.* INTO STRICT journal_record");
    expect(commit).toContain("SELECT authority.* INTO STRICT authority_record");
    expect(commit).toContain("FOR SHARE OF authority");
  });

  it("accepts later sibling allocations while proving the exact child reservation fence", () => {
    const commit = routine("commit_media_image_operation");
    expect(commit).not.toContain(
      "parent.current_revision=journal_record.credit_parent_expected_revision+1",
    );
    expect(commit).toContain(
      "credit_receipt.parent_resulting_revision=journal_record.credit_parent_expected_revision+1",
    );
    expect(commit).toContain("credit_receipt.parent_expected_epoch=journal_record.credit_parent_expected_epoch");
    expect(commit).toContain("credit_receipt.business_operation_key=journal_record.command_ref");
    expect(commit).toContain("credit_receipt.request_digest=journal_record.owner_request_digest");
    expect(commit).toContain("child.current_revision=child_segment.committed_to_allocation_revision");
    expect(commit).toContain("child_revision.allocation_epoch=credit_receipt.child_initial_epoch");
    expect(commit).toContain("child_revision.state='active'");
  });

  it("keeps command recovery and operation reads on the exact issuing access handle", () => {
    const recover = routine("recover_agent_media_command");
    const get = routine("get_agent_media_operation");
    expect(recover).toContain("journal.access_authorization_handle_digest=authority.handle_digest");
    expect(get).toContain("journal.access_authorization_handle_digest=authority.handle_digest");
    expect(get).toContain("journal.operation_ref=operation.operation_ref");
  });

  it("binds the Credit child receipt to the same Media operation and full allocation lineage", () => {
    const operation = table("media_operation");
    expect(migration).toMatch(
      /UNIQUE\(allocation_reservation_receipt_ref,site_ref,execution_budget_root_ref,\s*parent_allocation_ref,child_allocation_ref,child_authorization_segment_ref,media_operation_ref\)/u,
    );
    expect(operation).toContain("credit_execution_budget_root_ref UUID NOT NULL");
    expect(operation).toContain("credit_budget_kind TEXT NOT NULL");
    expect(operation).toContain("credit_parent_allocation_ref UUID");
    expect(operation).toContain("credit_root_hold_ref UUID");
    expect(operation).toContain("credit_budget_kind='agent_child' AND credit_parent_allocation_ref IS NOT NULL");
    expect(operation).toContain("credit_budget_kind='direct_root' AND credit_parent_allocation_ref IS NULL");
    expect(operation).toMatch(
      /FOREIGN KEY\(credit_allocation_receipt_ref,site_ref,credit_execution_budget_root_ref,\s*credit_parent_allocation_ref,credit_child_allocation_ref,credit_authorization_segment_ref,operation_ref\)/u,
    );
  });

  it("materializes image usage only through the exact pre-authorized Credit attempt identity", () => {
    expect(typedUsageMigration).toContain("JOIN platform.credit_usage_attempt_intent intent");
    expect(typedUsageMigration).toContain(
      "PERFORM platform.assert_media_image_worker_lease(p_task_ref,p_operation_ref,p_lease_epoch,p_lease_token_hash)",
    );
    expect(typedUsageMigration).toContain(
      "intent.attempt_authorization_ref=attempt.attempt_authorization_ref",
    );
    expect(typedUsageMigration).toContain(
      "intent.authorization_segment_ref=operation.credit_authorization_segment_ref",
    );
    expect(typedUsageMigration).toContain(
      "intent.execution_manifest_ref=operation.credit_execution_manifest_ref",
    );
    expect(typedUsageMigration).toContain("intent.attempt_ref=ledger.attempt_ref");
    expect(typedUsageMigration).toContain("intent.logical_effect_ref=invocation.logical_invocation_ref");
    expect(typedUsageMigration).toContain("attempt.attempt_authorization_fence_epoch");
    expect(typedUsageMigration).toContain("intent.producer_kind='model_gateway'");
    for (const alias of ["authorizationSegmentRef", "executionManifestRef", "producerKind",
      "producerContext", "producerGeneration", "logicalEffectRef"]) {
      expect(workerDatabase).toContain(`AS "${alias}"`);
    }
  });

  it("allows an exact empty closure only for the canceled-before-effect path", () => {
    expect(typedUsageMigration).toContain(
      "DROP CONSTRAINT credit_usage_segment_closure_expected_evidence_count_check",
    );
    expect(typedUsageMigration).toContain("expected_evidence_count BETWEEN 0 AND 4096");
  });

  it("freezes the full Direct Studio authority and root budget before dispatch", () => {
    const journal = table("media_direct_command_journal");
    const begin = routine("begin_direct_media_image_command");
    const commit = routine("commit_direct_media_image_operation");
    for (const field of ["site_release_ref", "site_security_epoch", "policy_epoch", "workload_binding_epoch",
      "identity_session_ref", "identity_session_epoch", "restriction_epoch", "membership_epoch",
      "authorization_epoch"]) {
      expect(journal).toContain(field);
    }
    expect(begin).toContain("FOR SHARE OF site,release,binding,subject,identity,project,membership");
    expect(commit).toContain("p_record#>>'{credit,kind}'<>'direct_root'");
    expect(commit).toContain("JOIN platform.credit_execution_budget_root root");
    expect(commit).toContain("JOIN platform.credit_authorization_segment segment");
    expect(commit).toContain("FOR SHARE OF site,auth_release,binding,subject,identity,project,membership,definition");
    expect(migration).toContain("CREATE TRIGGER media_direct_command_receipt_immutable");
    expect(migration).toContain("REVOKE ALL ON FUNCTION platform.commit_direct_media_image_operation(JSONB,CHAR)");
  });

  it("never extends the Session-owned media projection reservation expiry", () => {
    expect(lifecycleOwner).toContain("expires_at=LEAST(expires_at,$5::timestamptz)");
    expect(lifecycleOwner).not.toContain("authorization_segment_ref=$4,expires_at=$5::timestamptz");
  });

  it("persists append-only command receipts and returns the latest durable receipt", () => {
    const receipt = table("media_command_receipt");
    expect(receipt).toContain("receipt_version BIGINT NOT NULL");
    expect(receipt).toContain("recorded_at TIMESTAMPTZ NOT NULL");
    expect(receipt).toContain("command_kind TEXT NOT NULL CHECK(command_kind='create_agent_image_operation')");
    expect(receipt).toContain(
      "outcome TEXT NOT NULL CHECK(outcome IN ('submit_outcome_unknown','submit_accepted'))",
    );
    expect(migration).toContain("CREATE TRIGGER media_command_receipt_immutable");
    expect(routine("commit_media_image_operation")).toContain("RETURNS TABLE(");
    const recover = routine("recover_agent_media_command");
    for (const field of ["receipt_version", "receipt_recorded_at", "receipt_kind", "receipt_outcome"]) {
      expect(recover).toContain(field);
    }
  });

  it("promotes an immutable Artifact version with a conditional create instead of an overwrite", () => {
    expect(artifactObjectStore).not.toContain("CopyObjectCommand");
    expect(artifactObjectStore).toContain("new GetObjectCommand");
    expect(artifactObjectStore).toMatch(
      /new PutObjectCommand\(\{[\s\S]+Key: readyKey,[\s\S]+IfNoneMatch: "\*"/u,
    );
    expect(artifactObjectStore).toContain("ARTIFACT_PROMOTION_SOURCE_CHANGED");
    expect(artifactObjectStore).toContain("kokoro.platform.artifact-object.v1");
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
