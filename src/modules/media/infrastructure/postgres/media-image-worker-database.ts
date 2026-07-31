import { Pool } from "pg";
import type {
  MediaImageWorkerDatabase,
  MediaImageWorkerEffectRow,
  MediaImageWorkerTaskRow,
} from "./media-image-worker-repository.js";
import type { MediaImageTypedUsageFactDatabase, MediaImageTypedUsageFactRow } from
  "./media-image-typed-usage-owner.js";

interface QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}
export interface MediaImageWorkerPool {
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
  end(): Promise<void>;
}

export type MediaImageWorkerDatabaseConfig = Readonly<{
  url: string;
  expectedDatabaseUser: string;
  expectedDatabaseName: string;
  migratorDatabaseUser: string;
  applicationName: "kokoro-platform-media-worker";
  poolMax: number;
  maxAttempts: number;
}>;

export type MediaArtifactCleanupTaskRow = Readonly<{
  artifactVersionRef: string;
  artifactRef: string;
  stagedObjectRef: string;
  leaseEpoch: bigint | string;
  siteRef: string;
  subjectRef: string;
  subjectGeneration: bigint | string;
  projectRef: string;
}>;

/** Dedicated function-only PostgreSQL identity for the Media worker process. */
export class PostgresMediaImageWorkerDatabase implements MediaImageWorkerDatabase {
  constructor(private readonly dependencies: Readonly<{
    pool: MediaImageWorkerPool;
    expectedDatabaseUser: string;
    expectedDatabaseName: string;
    migratorDatabaseUser: string;
    maxAttempts: number;
  }>) {}

  async connect(): Promise<void> {
    const result = await this.dependencies.pool.query(MEDIA_WORKER_IDENTITY_SQL, [
      this.dependencies.migratorDatabaseUser,
      this.dependencies.expectedDatabaseUser,
    ]);
    const row = result.rows[0];
    if (result.rows.length !== 1 || row?.currentUser !== this.dependencies.expectedDatabaseUser ||
        row.currentDatabase !== this.dependencies.expectedDatabaseName ||
        row.databaseOwner !== this.dependencies.migratorDatabaseUser || row.isSuperuser !== false ||
        row.canCreateDatabase !== false || row.canCreateRole !== false || row.canReplicate !== false ||
        row.canBypassRls !== false || row.hasAnyMembership !== false || row.isMigratorMember !== false ||
        row.hasAnyMediaTableAccess !== false || row.canExecuteClaim !== true || row.canExecuteSaga !== true ||
        row.canExecuteEvidence !== true || row.canExecuteTypedUsage !== true) {
      throw new Error("MEDIA_WORKER_DATABASE_ROLE_INVALID");
    }
    await this.dependencies.pool.query(`SELECT platform.assert_media_runtime_role('worker')`);
  }

  disconnect(): Promise<void> { return this.dependencies.pool.end(); }
  async checkHealth(): Promise<void> {
    await this.dependencies.pool.query(`SELECT platform.assert_media_runtime_role('worker')`);
  }

  async assertOwned(input: Readonly<{ taskRef: string; operationRef: string; leaseEpoch: bigint;
    leaseTokenHash: string }>): Promise<void> {
    await this.#void(`SELECT platform.assert_media_image_worker_lease($1,$2,$3,$4)`,
      [input.taskRef, input.operationRef, input.leaseEpoch.toString(), input.leaseTokenHash]);
  }

  loadMediaImageEffectUsageFact(
    input: Parameters<MediaImageTypedUsageFactDatabase["loadMediaImageEffectUsageFact"]>[0],
  ): Promise<readonly MediaImageTypedUsageFactRow[]> {
    return this.#rows<MediaImageTypedUsageFactRow>(
      `SELECT attempt_ref AS "attemptRef",attempt_authorization_ref AS "attemptAuthorizationRef",
              attempt_authorization_fence_epoch AS "attemptAuthorizationFenceEpoch",
              attempt_authorization_digest AS "attemptAuthorizationDigest",
              authorization_segment_ref AS "authorizationSegmentRef",
              execution_manifest_ref AS "executionManifestRef",
              producer_kind AS "producerKind",producer_context AS "producerContext",
              producer_generation AS "producerGeneration",logical_effect_ref AS "logicalEffectRef",
              usage_evidence_ref AS "usageEvidenceRef",
              usage_evidence_digest AS "usageEvidenceDigest",usage_fact AS "usageFact",
              recorded_at AS "recordedAt"
         FROM platform.load_media_image_effect_usage_fact($1,$2,$3,$4,$5,$6,$7,$8)`,
      [input.taskRef, input.operationRef, input.leaseEpoch.toString(), input.leaseTokenHash,
        input.modelInvocationCommandRef, input.logicalInvocationRef,
        input.usageEvidenceRef, input.usageEvidenceDigest],
    );
  }

  claim(input: Parameters<MediaImageWorkerDatabase["claim"]>[0]): Promise<readonly MediaImageWorkerTaskRow[]> {
    return this.#rows<MediaImageWorkerTaskRow>(
      `SELECT task_ref AS "taskRef",operation_ref AS "operationRef",lease_epoch AS "leaseEpoch",
              operation_state AS "operationState",cancel_intent_receipt_ref AS "cancelIntentReceiptRef",
              model_invocation_command_ref AS "modelInvocationCommandRef",
              credit_execution_budget_root_ref AS "creditExecutionBudgetRootRef",
              credit_authorization_segment_ref AS "creditAuthorizationSegmentRef",
              credit_execution_manifest_ref AS "creditExecutionManifestRef",
              credit_budget_kind AS "creditBudgetKind",
              credit_parent_allocation_ref AS "creditParentAllocationRef",
              credit_child_allocation_ref AS "creditChildAllocationRef",
              credit_allocation_receipt_ref AS "creditAllocationReceiptRef",
              credit_root_hold_ref AS "creditRootHoldRef",
              credit_root_allocation_ref AS "creditRootAllocationRef",
              credit_root_allocation_revision AS "creditRootAllocationRevision",
              credit_root_allocation_epoch AS "creditRootAllocationEpoch",
              credit_authorization_segment_version AS "creditAuthorizationSegmentVersion",
              credit_reserved_ceiling AS "creditReservedCeiling",
              credit_unit AS "creditUnit",
              effect_budget_commit_ref AS "effectBudgetCommitRef",
              effect_budget_commit_digest AS "effectBudgetCommitDigest",
              effect_attempt_ordinal AS "attemptOrdinal",
              gateway_caller_request_fingerprint AS "gatewayCallerRequestFingerprint",
              gateway_create_effect_digest AS "gatewayCreateEffectDigest",
              definition_role_ref AS "definitionRoleRef",
              operation_input_revision_digest AS "operationInputRevisionDigest",
              trust_effect_allow_receipt_ref AS "trustEffectAllowReceiptRef",
              trust_effect_allow_receipt_digest AS "trustEffectAllowReceiptDigest",
              source_grants AS "sourceGrants",
              caller_access_capability_envelope AS "callerAccessCapabilityEnvelope",
              caller_access_handle_digest AS "callerAccessHandleDigest",
              caller_access_expires_at AS "callerAccessExpiresAt",
              caller_access_binding_ref AS "callerAccessBindingRef",
              model_option_authorization_capability_envelope AS "modelOptionAuthorizationCapabilityEnvelope",
              model_option_authorization_handle_digest AS "modelOptionAuthorizationHandleDigest",
              model_option_authorization_expires_at AS "modelOptionAuthorizationExpiresAt",
              model_option_authorization_binding_ref AS "modelOptionAuthorizationBindingRef",
              site_ref AS "siteRef",subject_ref AS "subjectRef",subject_generation AS "subjectGeneration",
              project_ref AS "projectRef",workload_ref AS "workloadRef",source,
              definition_revision_ref AS "definitionRevisionRef",
              model_option_revision_ref AS "modelOptionRevisionRef",
              site_release_ref AS "siteReleaseRef",site_security_epoch AS "siteSecurityEpoch",
              policy_epoch AS "policyEpoch",workload_binding_epoch AS "workloadBindingEpoch",
              identity_session_ref AS "identitySessionRef",identity_session_epoch AS "identitySessionEpoch",
              restriction_epoch AS "restrictionEpoch",membership_epoch AS "membershipEpoch",
              authorization_epoch AS "authorizationEpoch",
              operation_input_revision_ref AS "operationInputRevisionRef",key_revision_ref AS "keyRevisionRef",
              ciphertext,content_iv AS "contentIv",content_tag AS "contentTag",wrapped_dek AS "wrappedDek",
              wrap_iv AS "wrapIv",wrap_tag AS "wrapTag",plaintext_bytes AS "plaintextBytes",candidates,
              cancel_command_ref AS "cancelCommandRef",
              cancel_request_fingerprint AS "cancelRequestFingerprint",
              saga_checkpoint AS "sagaCheckpoint"
         FROM platform.claim_media_image_task_v2($1,$2,$3)`,
      [input.workerId, input.leaseTokenHash, input.leaseSeconds],
    );
  }

  async renew(input: Parameters<MediaImageWorkerDatabase["renew"]>[0]): Promise<void> {
    await this.#void(`SELECT platform.renew_media_image_task($1,$2,$3,$4,$5)`,
      [input.taskRef, input.operationRef, input.leaseEpoch.toString(), input.leaseTokenHash, input.leaseSeconds]);
  }

  prepareEffect(input: Parameters<MediaImageWorkerDatabase["prepareEffect"]>[0]):
  Promise<readonly MediaImageWorkerEffectRow[]> {
    return this.#rows<MediaImageWorkerEffectRow>(
      `SELECT request_digest AS "requestDigest",state,owner_result AS "ownerResult",created
         FROM platform.prepare_media_image_gateway_effect($1,$2,$3,$4,$5,$6,$7)`,
      fenceValues(input, [input.requestDigest, input.effectOwnerKind, input.startedAt]),
    );
  }

  async recordEffectView(input: Parameters<MediaImageWorkerDatabase["recordEffectView"]>[0]) {
    const rows = await this.#rows<{ lateCancellationObserved: boolean }>(
      `SELECT late_cancellation_observed AS "lateCancellationObserved"
         FROM platform.record_media_image_gateway_view($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      fenceValues(input, [input.requestDigest, input.ownerResult, input.gatewayCommandReceiptRef,
        input.gatewayCommandReceiptDigest, input.recordedAt]),
    );
    if (rows.length !== 1) throw new Error("MEDIA_GATEWAY_VIEW_RESULT_INVALID");
    return Object.freeze({ lateCancellationObserved: rows[0]!.lateCancellationObserved });
  }

  async recordOwnerView(input: Parameters<MediaImageWorkerDatabase["recordOwnerView"]>[0]) {
    const rows = await this.#rows<{ lateCancellationObserved: boolean }>(
      `SELECT late_cancellation_observed AS "lateCancellationObserved"
         FROM platform.record_media_image_gateway_owner_view($1,$2,$3,$4,$5,$6,$7)`,
      fenceValues(input, [input.requestDigest, input.ownerView, input.recordedAt]),
    );
    if (rows.length !== 1) throw new Error("MEDIA_GATEWAY_VIEW_RESULT_INVALID");
    return Object.freeze({ lateCancellationObserved: rows[0]!.lateCancellationObserved });
  }

  recordEvidencePage(input: Parameters<MediaImageWorkerDatabase["recordEvidencePage"]>[0]) {
    return this.#rows<{ evidenceCheckpoint: unknown }>(
      `SELECT evidence_checkpoint AS "evidenceCheckpoint"
         FROM platform.record_media_image_gateway_evidence_page($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      fenceValues(input, [input.logicalInvocationRef, input.priorNextEvidenceSequence.toString(),
        input.nextEvidenceSequence.toString(), input.caughtUp, input.ownerView, input.facts, input.recordedAt]),
    );
  }

  prepareCancel(input: Parameters<MediaImageWorkerDatabase["prepareCancel"]>[0]) {
    return this.#rows<MediaImageWorkerEffectRow>(
      `SELECT request_digest AS "requestDigest",state,owner_result AS "ownerResult",created
         FROM platform.prepare_media_image_gateway_cancel($1,$2,$3,$4,$5,$6,$7)`,
      fenceValues(input, [input.cancelCommandRef, input.requestDigest, input.startedAt]),
    );
  }

  async recordCancelResult(input: Parameters<MediaImageWorkerDatabase["recordCancelResult"]>[0]): Promise<void> {
    await this.#void(`SELECT platform.record_media_image_gateway_cancel_result($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      fenceValues(input, [input.cancelCommandRef, input.requestDigest, input.ownerResult,
        input.gatewayCommandReceiptRef, input.gatewayCommandReceiptDigest, input.recordedAt]));
  }

  async recordCancelOutcomeUnknown(
    input: Parameters<MediaImageWorkerDatabase["recordCancelOutcomeUnknown"]>[0],
  ): Promise<void> {
    await this.#void(`SELECT platform.record_media_image_gateway_cancel_outcome_unknown($1,$2,$3,$4,$5,$6,$7,$8)`,
      fenceValues(input, [input.cancelCommandRef, input.requestDigest, input.errorCode, input.observedAt]));
  }

  async recordOutcomeUnknown(input: Parameters<MediaImageWorkerDatabase["recordOutcomeUnknown"]>[0]): Promise<void> {
    await this.#void(`SELECT platform.record_media_image_outcome_unknown($1,$2,$3,$4,$5,$6)`,
      fenceValues(input, [input.errorCode, input.observedAt]));
  }

  async recordSagaReceipt(input: Parameters<MediaImageWorkerDatabase["recordSagaReceipt"]>[0]): Promise<void> {
    await this.#void(`SELECT platform.record_media_image_saga_receipt($1,$2,$3,$4,$5,$6,$7)`,
      fenceValues(input, [input.step, input.bindingRef, input.receipt]));
  }

  async complete(input: Parameters<MediaImageWorkerDatabase["complete"]>[0]): Promise<void> {
    await this.#void(`SELECT platform.complete_media_image_task($1,$2,$3,$4,$5)`,
      fenceValues(input, [input.closure]));
  }

  async retryOrDeadLetter(input: Parameters<MediaImageWorkerDatabase["retryOrDeadLetter"]>[0]) {
    const rows = await this.#rows<{ resolution: "retry" | "dead_letter" }>(
      `SELECT platform.retry_or_dead_letter_media_image_task($1,$2,$3,$4,$5,$6,$7,$8) AS resolution`,
      fenceValues(input, [input.errorCode, input.retryAt, input.failedAt, this.dependencies.maxAttempts]),
    );
    if (rows.length !== 1 || (rows[0]!.resolution !== "retry" && rows[0]!.resolution !== "dead_letter")) {
      throw new Error("MEDIA_WORKER_RETRY_RESULT_INVALID");
    }
    return rows[0]!.resolution;
  }

  async releaseOwnedLeases(input: Parameters<MediaImageWorkerDatabase["releaseOwnedLeases"]>[0]): Promise<void> {
    await this.#void(`SELECT platform.return_media_image_worker_leases($1,$2)`, [input.workerId, input.reason]);
  }

  claimArtifactCleanup(input: Readonly<{ workerId: string; leaseTokenHash: string; leaseSeconds: number }> ) {
    return this.#rows<MediaArtifactCleanupTaskRow>(
      `SELECT artifact_version_ref AS "artifactVersionRef",artifact_ref AS "artifactRef",
              staged_object_ref AS "stagedObjectRef",lease_epoch AS "leaseEpoch",site_ref AS "siteRef",
              subject_ref AS "subjectRef",subject_generation AS "subjectGeneration",project_ref AS "projectRef"
         FROM platform.claim_media_artifact_cleanup($1,$2,$3)`,
      [input.workerId, input.leaseTokenHash, input.leaseSeconds],
    );
  }

  async renewArtifactCleanup(input: Readonly<{
    artifactVersionRef: string; leaseEpoch: bigint; leaseTokenHash: string; leaseSeconds: number;
  }>): Promise<void> {
    await this.#void(`SELECT platform.renew_media_artifact_cleanup($1,$2,$3,$4)`,
      [input.artifactVersionRef, input.leaseEpoch.toString(), input.leaseTokenHash, input.leaseSeconds]);
  }

  async completeArtifactCleanup(input: Readonly<{
    artifactVersionRef: string; leaseEpoch: bigint; leaseTokenHash: string;
  }>): Promise<void> {
    await this.#void(`SELECT platform.complete_media_artifact_cleanup($1,$2,$3)`,
      [input.artifactVersionRef, input.leaseEpoch.toString(), input.leaseTokenHash]);
  }

  async retryArtifactCleanup(input: Readonly<{ artifactVersionRef: string; leaseEpoch: bigint;
    leaseTokenHash: string; errorCode: string; retryAt: string; failedAt: string }>) {
    const rows = await this.#rows<{ resolution: "retry" | "dead_letter" }>(
      `SELECT platform.retry_media_artifact_cleanup($1,$2,$3,$4,$5,$6,$7) AS resolution`,
      [input.artifactVersionRef, input.leaseEpoch.toString(), input.leaseTokenHash, input.errorCode,
        input.retryAt, input.failedAt, this.dependencies.maxAttempts],
    );
    if (rows.length !== 1) throw new Error("MEDIA_CLEANUP_RETRY_RESULT_INVALID");
    return rows[0]!.resolution;
  }

  async releaseArtifactCleanupLeases(input: Readonly<{ workerId: string; reason: string }>): Promise<void> {
    await this.#void(`SELECT platform.return_media_artifact_cleanup_leases($1,$2)`,
      [input.workerId, input.reason]);
  }

  async #rows<Row extends Record<string, unknown>>(sql: string, values: readonly unknown[]): Promise<readonly Row[]> {
    return (await this.dependencies.pool.query(sql, values)).rows as readonly Row[];
  }
  async #void(sql: string, values: readonly unknown[]): Promise<void> {
    await this.dependencies.pool.query(sql, values);
  }
}

export function loadMediaImageWorkerDatabaseConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): MediaImageWorkerDatabaseConfig {
  if (environment.PLATFORM_DATABASE_CREDENTIAL_CLASS !== "media-worker") {
    throw new Error("PLATFORM_DATABASE_CREDENTIAL_CLASS_REQUIRED:media-worker");
  }
  const urlValue = environment.DATABASE_URL_PLATFORM;
  if (urlValue === undefined) throw new Error("DATABASE_URL_PLATFORM_REQUIRED");
  const url = postgresUrl(urlValue);
  const expectedDatabaseUser = identifier(environment.PLATFORM_DATABASE_MEDIA_WORKER_ROLE,
    "PLATFORM_DATABASE_MEDIA_WORKER_ROLE");
  const expectedDatabaseName = identifier(environment.PLATFORM_DATABASE_EXPECTED_DATABASE,
    "PLATFORM_DATABASE_EXPECTED_DATABASE");
  const migratorDatabaseUser = identifier(environment.PLATFORM_DATABASE_MIGRATOR_ROLE,
    "PLATFORM_DATABASE_MIGRATOR_ROLE");
  if (decodeURIComponent(url.username) !== expectedDatabaseUser) throw new Error("PLATFORM_DATABASE_URL_USER_MISMATCH");
  if (decodeURIComponent(url.pathname.slice(1)) !== expectedDatabaseName) {
    throw new Error("PLATFORM_DATABASE_URL_NAME_MISMATCH");
  }
  if (expectedDatabaseUser === migratorDatabaseUser) throw new Error("PLATFORM_RUNTIME_ROLE_MUST_DIFFER_FROM_MIGRATOR");
  const maxAttempts = integer(environment.PLATFORM_MEDIA_WORKER_MAX_ATTEMPTS ?? "10", 1, 100,
    "PLATFORM_MEDIA_WORKER_MAX_ATTEMPTS");
  return Object.freeze({ url: urlValue, expectedDatabaseUser, expectedDatabaseName, migratorDatabaseUser,
    applicationName: "kokoro-platform-media-worker" as const, poolMax: 8, maxAttempts });
}

export function createPostgresMediaImageWorkerDatabase(
  config: MediaImageWorkerDatabaseConfig,
): PostgresMediaImageWorkerDatabase {
  const pool = new Pool({ connectionString: config.url, max: config.poolMax,
    connectionTimeoutMillis: 5_000, application_name: config.applicationName,
    options: "-c statement_timeout=15000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=10000" });
  return new PostgresMediaImageWorkerDatabase({ pool: pool as unknown as MediaImageWorkerPool,
    expectedDatabaseUser: config.expectedDatabaseUser, expectedDatabaseName: config.expectedDatabaseName,
    migratorDatabaseUser: config.migratorDatabaseUser, maxAttempts: config.maxAttempts });
}

function fenceValues(value: Readonly<{ taskRef: string; operationRef: string; leaseEpoch: bigint;
  leaseTokenHash: string }>, tail: readonly unknown[]): readonly unknown[] {
  return [value.taskRef, value.operationRef, value.leaseEpoch.toString(), value.leaseTokenHash, ...tail];
}
function postgresUrl(value: string): URL {
  let url: URL; try { url = new URL(value); } catch { throw new Error("DATABASE_URL_PLATFORM_INVALID"); }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("DATABASE_URL_PLATFORM_INVALID");
  if (url.username.length < 1 || url.pathname.length < 2) throw new Error("DATABASE_URL_PLATFORM_INVALID");
  return url;
}
function identifier(value: string | undefined, name: string): string {
  if (value === undefined || !/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) throw new Error(`${name}_INVALID`);
  return value;
}
function integer(value: string, minimum: number, maximum: number, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name}_INVALID`);
  return parsed;
}

const MEDIA_WORKER_IDENTITY_SQL = `
SELECT current_user AS "currentUser",current_database() AS "currentDatabase",
       pg_get_userbyid(database.datdba) AS "databaseOwner",role.rolsuper AS "isSuperuser",
       role.rolcreatedb AS "canCreateDatabase",role.rolcreaterole AS "canCreateRole",
       role.rolreplication AS "canReplicate",role.rolbypassrls AS "canBypassRls",
       EXISTS(SELECT 1 FROM pg_auth_members membership WHERE membership.member=role.oid) AS "hasAnyMembership",
       pg_has_role(current_user,$1,'MEMBER') AS "isMigratorMember",
       has_function_privilege(current_user,'platform.claim_media_image_task_v2(text,character,integer)','EXECUTE')
         AS "canExecuteClaim",
       has_function_privilege(current_user,
         'platform.record_media_image_saga_receipt(text,text,bigint,character,text,text,jsonb)','EXECUTE')
         AS "canExecuteSaga",
       has_function_privilege(current_user,
         'platform.record_media_image_gateway_evidence_page(text,text,bigint,character,text,numeric,numeric,boolean,jsonb,jsonb,timestamp with time zone)','EXECUTE')
         AS "canExecuteEvidence",
       has_function_privilege(current_user,
         'platform.load_media_image_effect_usage_fact(text,text,bigint,character,text,text,text,character)','EXECUTE')
         AS "canExecuteTypedUsage",
       EXISTS(SELECT 1 FROM information_schema.tables owned
               WHERE owned.table_schema='platform' AND owned.table_name LIKE 'media_%'
                 AND (has_table_privilege(current_user,format('%I.%I',owned.table_schema,owned.table_name),'SELECT') OR
                      has_table_privilege(current_user,format('%I.%I',owned.table_schema,owned.table_name),'INSERT') OR
                      has_table_privilege(current_user,format('%I.%I',owned.table_schema,owned.table_name),'UPDATE') OR
                      has_table_privilege(current_user,format('%I.%I',owned.table_schema,owned.table_name),'DELETE')))
         AS "hasAnyMediaTableAccess"
  FROM pg_roles role,pg_database database
 WHERE role.rolname=current_user AND database.datname=current_database() AND current_user=$2`;
