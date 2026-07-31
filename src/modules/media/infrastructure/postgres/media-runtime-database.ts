import { Pool } from "pg";
import type { MediaImageUnitOfWork, MediaOperationOwnerBinding } from "../../application/index.js";
import type { AgentImageAccessDatabase, ResolvedAgentImageAccessRow } from "./agent-image-access-owner.js";
import type { MediaRuntimeQueryDatabase } from "./media-runtime-query-repository.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";

interface QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}
interface MediaPoolClient {
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
  release(destroy?: boolean): void;
}
interface MediaPool {
  connect(): Promise<MediaPoolClient>;
  query?(text: string, values?: readonly unknown[]): Promise<QueryResult>;
  end(): Promise<void>;
}

export type MediaRuntimeDatabaseConfig = Readonly<{
  url: string;
  expectedDatabaseUser: string;
  expectedDatabaseName: string;
  migratorDatabaseUser: string;
  applicationName: "kokoro-platform-media-runtime";
  poolMax: number;
}>;

/** Isolated function-only database credential for the private Media Runtime process. */
export class PostgresMediaRuntimeDatabase
implements AgentImageAccessDatabase, MediaRuntimeQueryDatabase, MediaImageUnitOfWork {
  constructor(private readonly dependencies: Readonly<{
    pool: MediaPool;
    expectedDatabaseUser: string;
    expectedDatabaseName: string;
    migratorDatabaseUser: string;
  }>) {}

  async connect(): Promise<void> {
    if (this.dependencies.pool.query === undefined) throw new Error("MEDIA_RUNTIME_DATABASE_POOL_INVALID");
    const result = await this.dependencies.pool.query(MEDIA_RUNTIME_IDENTITY_SQL, [
      this.dependencies.migratorDatabaseUser,
      this.dependencies.expectedDatabaseUser,
    ]);
    if (result.rows.length !== 1 || !validIdentity(result.rows[0], this.dependencies)) {
      throw new Error("MEDIA_RUNTIME_DATABASE_ROLE_INVALID");
    }
    await this.dependencies.pool.query(`SELECT platform.assert_media_runtime_role('runtime')`);
  }

  disconnect(): Promise<void> {
    return this.dependencies.pool.end();
  }

  async checkHealth(): Promise<void> {
    if (this.dependencies.pool.query === undefined) throw new Error("MEDIA_RUNTIME_DATABASE_POOL_INVALID");
    await this.dependencies.pool.query(`SELECT platform.assert_media_runtime_role('runtime')`);
  }

  async resolveAgentImageAccess(input: Parameters<AgentImageAccessDatabase["resolveAgentImageAccess"]>[0]) {
    return this.#query<ResolvedAgentImageAccessRow>(
      `SELECT site_ref AS "siteRef",project_ref AS "projectRef",session_ref AS "sessionRef",
              run_ref AS "runRef",subject_ref AS "subjectRef",
              subject_generation AS "subjectGeneration",
              configuration_revision_ref AS "configurationRevisionRef",
              execution_budget_root_ref AS "executionBudgetRootRef",
              authorization_segment_ref AS "authorizationSegmentRef",
              execution_manifest_ref AS "executionManifestRef",
              parent_allocation_ref AS "parentAllocationRef",maximum_credit AS "maximumCredit",
              trust_input_decision_ref AS "trustInputDecisionRef",
              expected_parent_revision AS "expectedParentRevision",
              expected_parent_allocation_epoch AS "expectedParentAllocationEpoch",
              credit_surface_ref AS "creditSurfaceRef",
              credit_capability_key AS "creditCapabilityKey",
              credit_agent_ref AS "creditAgentRef",credit_unit AS "creditUnit",
              credit_expires_at AS "creditExpiresAt",
              definition_revision_ref AS "definitionRevisionRef",
              model_option_revision_ref AS "modelOptionRevisionRef"
         FROM platform.resolve_media_access($1,$2)`,
      [input.handleDigest, input.projectionReservationDigest],
    );
  }

  recoverAgentMediaCommand(input: Parameters<MediaRuntimeQueryDatabase["recoverAgentMediaCommand"]>[0]) {
    return this.#query<Awaited<ReturnType<MediaRuntimeQueryDatabase["recoverAgentMediaCommand"]>>[number]>(
      `SELECT command_state AS "commandState",
              caller_request_fingerprint AS "callerRequestFingerprint",
              operation_ref AS "operationRef",receipt_version AS "receiptVersion",
              receipt_recorded_at AS "receiptRecordedAt",receipt_kind AS "receiptKind",
              receipt_outcome AS "receiptOutcome"
         FROM platform.recover_agent_media_command($1,$2,$3)`,
      [input.handleDigest, input.callerAudience, input.commandRef],
    );
  }

  getAgentMediaOperation(input: Parameters<MediaRuntimeQueryDatabase["getAgentMediaOperation"]>[0]) {
    return this.#query<Awaited<ReturnType<MediaRuntimeQueryDatabase["getAgentMediaOperation"]>>[number]>(
      `SELECT operation_ref AS "operationRef",owner_version AS "ownerVersion",
              operation_state AS "operationState",outcome_class AS "outcomeClass",
              observed_at AS "observedAt",candidates
         FROM platform.get_agent_media_operation($1,$2)`,
      [input.handleDigest, input.operationRef],
    );
  }

  async execute<Result>(
    binding: MediaOperationOwnerBinding,
    work: (transaction: PlatformTransaction) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.dependencies.pool.connect();
    let open = false;
    const lease = issuePlatformTransaction({
      query: async <Row extends Record<string, unknown>>(statement: string, values: readonly unknown[] = []) =>
        (await client.query(statement, values)).rows as readonly Row[],
      execute: async (statement, values = []) => (await client.query(statement, values)).rowCount ?? 0,
    });
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      open = true;
      await client.query(
        `SELECT set_config('app.site_id',$1,true),set_config('app.subject_ref',$2,true),
                set_config('app.subject_generation',$3,true),set_config('app.project_ref',$4,true),
                set_config('statement_timeout','15000',true),set_config('lock_timeout','3000',true)`,
        [binding.siteRef, binding.subjectRef, binding.subjectGeneration.toString(), binding.projectRef],
      );
      const result = await work(lease.transaction);
      await client.query("COMMIT");
      open = false;
      return result;
    } catch (error) {
      if (open) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      revokePlatformTransaction(lease);
      client.release();
    }
  }

  async #query<Row extends Record<string, unknown>>(
    statement: string,
    values: readonly unknown[],
  ): Promise<readonly Row[]> {
    if (this.dependencies.pool.query === undefined) throw new Error("MEDIA_RUNTIME_DATABASE_POOL_INVALID");
    return (await this.dependencies.pool.query(statement, values)).rows as readonly Row[];
  }
}

export function loadMediaRuntimeDatabaseConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): MediaRuntimeDatabaseConfig {
  if (environment.PLATFORM_DATABASE_CREDENTIAL_CLASS !== "media-runtime") {
    throw new Error("PLATFORM_DATABASE_CREDENTIAL_CLASS_REQUIRED:media-runtime");
  }
  const value = environment.DATABASE_URL_PLATFORM;
  if (value === undefined) throw new Error("DATABASE_URL_PLATFORM_REQUIRED");
  const url = postgresUrl(value);
  const expectedDatabaseUser = identifier(environment.PLATFORM_DATABASE_MEDIA_RUNTIME_ROLE,
    "PLATFORM_DATABASE_MEDIA_RUNTIME_ROLE");
  const expectedDatabaseName = identifier(environment.PLATFORM_DATABASE_EXPECTED_DATABASE,
    "PLATFORM_DATABASE_EXPECTED_DATABASE");
  const migratorDatabaseUser = identifier(environment.PLATFORM_DATABASE_MIGRATOR_ROLE,
    "PLATFORM_DATABASE_MIGRATOR_ROLE");
  if (decodeURIComponent(url.username) !== expectedDatabaseUser) {
    throw new Error("PLATFORM_DATABASE_URL_USER_MISMATCH");
  }
  if (decodeURIComponent(url.pathname.slice(1)) !== expectedDatabaseName) {
    throw new Error("PLATFORM_DATABASE_URL_NAME_MISMATCH");
  }
  if (expectedDatabaseUser === migratorDatabaseUser) throw new Error("PLATFORM_RUNTIME_ROLE_MUST_DIFFER_FROM_MIGRATOR");
  return Object.freeze({ url: value, expectedDatabaseUser, expectedDatabaseName, migratorDatabaseUser,
    applicationName: "kokoro-platform-media-runtime" as const, poolMax: 16 });
}

export function createPostgresMediaRuntimeDatabase(
  config: MediaRuntimeDatabaseConfig,
): PostgresMediaRuntimeDatabase {
  const pool = new Pool({ connectionString: config.url, max: config.poolMax,
    connectionTimeoutMillis: 5_000, application_name: config.applicationName,
    options: "-c statement_timeout=15000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=10000" });
  return new PostgresMediaRuntimeDatabase({ pool: pool as unknown as MediaPool,
    expectedDatabaseUser: config.expectedDatabaseUser, expectedDatabaseName: config.expectedDatabaseName,
    migratorDatabaseUser: config.migratorDatabaseUser });
}

interface RuntimeIdentity extends Record<string, unknown> {
  currentUser: string;
  currentDatabase: string;
  databaseOwner: string;
  isSuperuser: boolean;
  canCreateDatabase: boolean;
  canCreateRole: boolean;
  canReplicate: boolean;
  canBypassRls: boolean;
  inheritsPrivileges: boolean;
  hasAnyMembership: boolean;
  isMigratorMember: boolean;
  canCreateDatabaseObject: boolean;
  canCreateSchema: boolean;
  canUseSchema: boolean;
  canExecuteAssert: boolean;
  canExecuteResolve: boolean;
  canExecuteBegin: boolean;
  canExecuteCommit: boolean;
  canExecuteRecover: boolean;
  canExecuteGet: boolean;
  hasAnyMediaTableAccess: boolean;
}

function validIdentity(row: Record<string, unknown> | undefined, expected: Readonly<{
  expectedDatabaseUser: string;
  expectedDatabaseName: string;
  migratorDatabaseUser: string;
}>): boolean {
  const value = row as RuntimeIdentity | undefined;
  return value !== undefined && value.currentUser === expected.expectedDatabaseUser &&
    value.currentDatabase === expected.expectedDatabaseName && value.databaseOwner === expected.migratorDatabaseUser &&
    value.isSuperuser === false && value.canCreateDatabase === false && value.canCreateRole === false &&
    value.canReplicate === false && value.canBypassRls === false && value.inheritsPrivileges === false &&
    value.hasAnyMembership === false && value.isMigratorMember === false &&
    value.canCreateDatabaseObject === false && value.canCreateSchema === false && value.canUseSchema === true &&
    value.canExecuteAssert === true &&
    value.canExecuteResolve === true && value.canExecuteBegin === true && value.canExecuteCommit === true &&
    value.canExecuteRecover === true && value.canExecuteGet === true && value.hasAnyMediaTableAccess === false;
}

const MEDIA_RUNTIME_IDENTITY_SQL = `
SELECT current_user AS "currentUser",current_database() AS "currentDatabase",owner.rolname AS "databaseOwner",
       runtime.rolsuper AS "isSuperuser",runtime.rolcreatedb AS "canCreateDatabase",
       runtime.rolcreaterole AS "canCreateRole",runtime.rolreplication AS "canReplicate",
       runtime.rolbypassrls AS "canBypassRls",runtime.rolinherit AS "inheritsPrivileges",
       EXISTS(SELECT 1 FROM pg_auth_members member WHERE member.member=runtime.oid) AS "hasAnyMembership",
       pg_has_role(current_user,$1,'MEMBER') AS "isMigratorMember",
       has_database_privilege(current_user,current_database(),'CREATE') AS "canCreateDatabaseObject",
       has_schema_privilege(current_user,'platform','CREATE') AS "canCreateSchema",
       has_schema_privilege(current_user,'platform','USAGE') AS "canUseSchema",
       has_function_privilege(current_user,'platform.assert_media_runtime_role(text)','EXECUTE') AS "canExecuteAssert",
       has_function_privilege(current_user,'platform.resolve_media_access(character,character)','EXECUTE') AS "canExecuteResolve",
       has_function_privilege(current_user,'platform.begin_media_image_command(text,character,character,text,text,bigint,text,text,text,text,text,text,character,character,character)','EXECUTE') AS "canExecuteBegin",
       has_function_privilege(current_user,'platform.commit_media_image_operation(jsonb,character)','EXECUTE') AS "canExecuteCommit",
       has_function_privilege(current_user,'platform.recover_agent_media_command(character,text,text)','EXECUTE') AS "canExecuteRecover",
       has_function_privilege(current_user,'platform.get_agent_media_operation(character,text)','EXECUTE') AS "canExecuteGet",
       EXISTS(
         SELECT 1
           FROM unnest(ARRAY[
             'platform.admission_media_access_authorization',
             'platform.site_release_media_definition',
             'platform.media_operation_input_revision',
             'platform.media_operation',
             'platform.media_command_journal',
             'platform.media_command_receipt',
             'platform.media_candidate',
             'platform.media_dispatch_outbox',
             'platform.media_provider_effect_journal',
             'platform.artifact',
             'platform.artifact_version',
             'platform.artifact_delivery_authorization'
           ]) relation(name)
          CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege(name)
          WHERE has_table_privilege(current_user,relation.name,privilege.name)
       ) AS "hasAnyMediaTableAccess"
  FROM pg_roles runtime
  JOIN pg_database database ON database.datname=current_database()
  JOIN pg_roles owner ON owner.oid=database.datdba
 WHERE runtime.rolname=current_user AND runtime.rolname=$2`;

function postgresUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("DATABASE_URL_PLATFORM_INVALID"); }
  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol) || url.username.length < 1 ||
      url.pathname.length < 2) throw new Error("DATABASE_URL_PLATFORM_INVALID");
  return url;
}

function identifier(value: string | undefined, name: string): string {
  if (value === undefined || !/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) throw new Error(`${name}_INVALID`);
  return value;
}
