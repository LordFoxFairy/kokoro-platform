import { Pool, type PoolClient } from "pg";
import type {
  ArtifactDeliveryDatabaseOperation,
  ArtifactDeliveryPostgresDatabase,
} from "../modules/artifact/infrastructure/postgres/index.js";
import type { PlatformSqlTransaction } from "../shared/unit-of-work/platform-transaction.js";

const ALLOWED_ROUTINES = Object.freeze([
  "assert_artifact_delivery_data_plane_role",
  "find_artifact_delivery_authorization_by_capability",
  "begin_artifact_delivery_redemption",
  "complete_artifact_delivery_stream",
  "fail_artifact_delivery_stream",
]);

export interface ArtifactDataPlaneDatabase extends ArtifactDeliveryPostgresDatabase {
  connect(): Promise<void>;
  checkHealth(): Promise<void>;
  disconnect(): Promise<void>;
}

export type ArtifactDataPlaneDatabaseConfig = Readonly<{
  url: string;
  expectedUser: string;
  expectedDatabase: string;
  migratorUser: string;
  poolMaximum: number;
}>;

export function loadArtifactDataPlaneDatabaseConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ArtifactDataPlaneDatabaseConfig {
  if (environment.PLATFORM_DATABASE_CREDENTIAL_CLASS !== "artifact-data-plane") {
    throw new Error("PLATFORM_DATABASE_CREDENTIAL_CLASS_REQUIRED:artifact-data-plane");
  }
  const rawUrl = required(environment, "DATABASE_URL_PLATFORM");
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("PLATFORM_DATABASE_URL_INVALID"); }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("PLATFORM_DATABASE_URL_INVALID");
  }
  const expectedUser = identifier(required(environment, "PLATFORM_DATABASE_ARTIFACT_DATA_PLANE_ROLE"));
  const expectedDatabase = identifier(required(environment, "PLATFORM_DATABASE_EXPECTED_DATABASE"));
  const migratorUser = identifier(required(environment, "PLATFORM_DATABASE_MIGRATOR_ROLE"));
  if (expectedUser === migratorUser) throw new Error("PLATFORM_RUNTIME_ROLE_MUST_DIFFER_FROM_MIGRATOR");
  if (decodeURIComponent(url.username) !== expectedUser) {
    throw new Error("PLATFORM_DATABASE_URL_USER_MISMATCH");
  }
  if (decodeURIComponent(url.pathname.slice(1)) !== expectedDatabase) {
    throw new Error("PLATFORM_DATABASE_URL_NAME_MISMATCH");
  }
  return Object.freeze({ url: rawUrl, expectedUser, expectedDatabase, migratorUser, poolMaximum: 16 });
}

/** Dedicated least-privilege connection host for the binary process. */
export function createArtifactDataPlaneDatabase(
  config: ArtifactDataPlaneDatabaseConfig,
): ArtifactDataPlaneDatabase {
  const pool = new Pool({
    connectionString: config.url,
    max: config.poolMaximum,
    connectionTimeoutMillis: 5_000,
    application_name: "kokoro-platform-artifact-data-plane",
    options: "-c statement_timeout=15000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=10000",
  });
  let connected = false;
  return Object.freeze({
    async connect(): Promise<void> {
      if (connected) throw new Error("ARTIFACT_DATA_PLANE_DATABASE_ALREADY_CONNECTED");
      const client = await pool.connect();
      try {
        await assertRuntimeIdentity(client, config);
        connected = true;
      } finally { client.release(); }
    },
    async checkHealth(): Promise<void> {
      if (!connected) throw new Error("ARTIFACT_DATA_PLANE_DATABASE_NOT_CONNECTED");
      const result = await pool.query(
        `SELECT platform.assert_artifact_delivery_data_plane_role(),
                (SELECT "schemaVersion" FROM platform.platform_foundation WHERE singleton=TRUE)`,
      );
      if (result.rowCount !== 1) throw new Error("ARTIFACT_DATA_PLANE_DATABASE_UNHEALTHY");
    },
    async disconnect(): Promise<void> {
      connected = false;
      await pool.end();
    },
    async transaction<Result>(operation: ArtifactDeliveryDatabaseOperation,
      work: (sql: PlatformSqlTransaction) => Promise<Result>): Promise<Result> {
      if (!connected) throw new Error("ARTIFACT_DATA_PLANE_DATABASE_NOT_CONNECTED");
      if (!ARTIFACT_DATA_PLANE_OPERATIONS.has(operation)) {
        throw new Error("ARTIFACT_DATA_PLANE_DATABASE_OPERATION_FORBIDDEN");
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `SELECT set_config('app.operation',$1,true),
                  set_config('app.workload_kind','platform_artifact_data_plane',true),
                  set_config('app.actor_kind','workload',true),
                  set_config('app.scopes','["artifact:deliver"]',true)`,
          [operation],
        );
        const sql: PlatformSqlTransaction = Object.freeze({
          query: async <Row extends Record<string, unknown>>(statement: string,
            values: readonly unknown[] = []) =>
            (await client.query<Row>(statement, [...values])).rows,
          execute: async (statement: string, values: readonly unknown[] = []) =>
            (await client.query(statement, [...values])).rowCount ?? 0,
        });
        const result = await work(sql);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally { client.release(); }
    },
  });
}

const ARTIFACT_DATA_PLANE_OPERATIONS = new Set<ArtifactDeliveryDatabaseOperation>([
  "artifact.delivery.authorization.read",
  "artifact.delivery.audit.begin",
  "artifact.delivery.audit.complete-stream",
  "artifact.delivery.audit.fail",
]);

async function assertRuntimeIdentity(client: PoolClient, config: ArtifactDataPlaneDatabaseConfig): Promise<void> {
  const result = await client.query<Record<string, unknown>>(
    `SELECT current_user AS "currentUser",current_database() AS "currentDatabase",
      role.rolsuper AS "superuser",role.rolcreatedb AS "createDatabase",
      role.rolcreaterole AS "createRole",role.rolreplication AS replication,
      role.rolbypassrls AS "bypassRls",role.rolinherit AS inherits,
      pg_has_role(current_user,$1,'MEMBER') AS "migratorMember",
      has_schema_privilege(current_user,'platform','USAGE') AS "schemaUsage",
      has_schema_privilege(current_user,'platform','CREATE') AS "schemaCreate",
      has_database_privilege(current_user,current_database(),'CREATE') AS "databaseCreate",
      has_table_privilege(current_user,'platform.platform_foundation','SELECT') AS "foundationRead",
      EXISTS(SELECT 1 FROM information_schema.role_table_grants grant_row
        WHERE grant_row.grantee=current_user AND grant_row.table_schema='platform'
          AND NOT (grant_row.table_name='platform_foundation' AND grant_row.privilege_type='SELECT'))
        AS "unexpectedTableGrant",
      EXISTS(SELECT 1 FROM information_schema.role_routine_grants grant_row
        WHERE grant_row.grantee=current_user AND grant_row.specific_schema='platform'
          AND NOT (grant_row.routine_name=ANY($2::text[]) AND grant_row.privilege_type='EXECUTE'))
        AS "unexpectedRoutineGrant",
      (SELECT count(*)::integer FROM information_schema.role_routine_grants grant_row
        WHERE grant_row.grantee=current_user AND grant_row.specific_schema='platform'
          AND grant_row.routine_name=ANY($2::text[]) AND grant_row.privilege_type='EXECUTE')
        AS "routineGrantCount",
      EXISTS(SELECT 1 FROM pg_class relation JOIN pg_namespace namespace
        ON namespace.oid=relation.relnamespace
        WHERE namespace.nspname='platform' AND relation.relowner=role.oid)
        AS "ownsRelation",
      EXISTS(SELECT 1 FROM pg_proc routine
        WHERE routine.pronamespace=(SELECT oid FROM pg_namespace WHERE nspname='platform')
          AND routine.proowner=role.oid) AS "ownsRoutine"
     FROM pg_roles role WHERE role.rolname=current_user`,
    [config.migratorUser, [...ALLOWED_ROUTINES]],
  );
  const row = result.rows[0];
  if (result.rowCount !== 1 || row === undefined || row.currentUser !== config.expectedUser ||
      row.currentDatabase !== config.expectedDatabase || row.superuser !== false ||
      row.createDatabase !== false || row.createRole !== false || row.replication !== false ||
      row.bypassRls !== false || row.inherits !== false || row.migratorMember !== false ||
      row.schemaUsage !== true || row.schemaCreate !== false || row.databaseCreate !== false ||
      row.foundationRead !== true || row.unexpectedTableGrant !== false ||
      row.unexpectedRoutineGrant !== false || row.routineGrantCount !== ALLOWED_ROUTINES.length ||
      row.ownsRelation !== false || row.ownsRoutine !== false) {
    throw new Error("ARTIFACT_DATA_PLANE_DATABASE_ROLE_INVALID");
  }
  await client.query("SELECT platform.assert_artifact_delivery_data_plane_role()");
}

function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) throw new Error("PLATFORM_DATABASE_ROLE_INVALID");
  return value;
}
