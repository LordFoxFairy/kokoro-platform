import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { loadPlatformDatabaseConfig } from "./client.js";

export const MIGRATION_ADVISORY_LOCK = "kokoro-platform:migrations:v1";

export interface MigrationLockClient {
  connect(): Promise<void>;
  query(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows?: readonly Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export interface RunPlatformMigrationsOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly createLockClient?: (databaseUrl: string) => MigrationLockClient;
  readonly execute?: MigrationCommandExecutor;
}

export type MigrationCommandExecutor = (
  command: string,
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
) => Promise<number>;

const MIGRATOR_ENVIRONMENT_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "PNPM_HOME",
  "COREPACK_HOME",
  "XDG_CACHE_HOME",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CI",
  "NO_COLOR",
] as const;

export async function runPlatformMigrations(
  options: RunPlatformMigrationsOptions = {},
): Promise<void> {
  const environment = options.environment ?? process.env;
  const config = loadPlatformDatabaseConfig("migrator", environment);
  const apiRole = requireRole(environment.PLATFORM_DATABASE_API_ROLE, "PLATFORM_DATABASE_API_ROLE");
  const workerRole = requireRole(
    environment.PLATFORM_DATABASE_WORKER_ROLE,
    "PLATFORM_DATABASE_WORKER_ROLE",
  );
  assertDistinctRoles(config.expectedDatabaseUser, apiRole, workerRole);

  const lockClient = (options.createLockClient ?? defaultLockClient)(config.url);
  const execute = options.execute ?? executeMigrationCommand;
  let connected = false;
  let locked = false;

  try {
    await lockClient.connect();
    connected = true;
    await assertMigratorPreflight(lockClient, {
      migratorRole: config.expectedDatabaseUser,
      expectedDatabase: config.expectedDatabaseName,
      apiRole,
      workerRole,
    });
    await lockClient.query("SELECT pg_advisory_lock(hashtext($1))", [MIGRATION_ADVISORY_LOCK]);
    locked = true;

    const exitCode = await execute(
      process.execPath,
      [
        resolve("node_modules/prisma/build/index.js"),
        "--config",
        resolve("dist/prisma.config.js"),
        "migrate",
        "deploy",
      ],
      buildMigratorEnvironment(environment, config.url),
    );
    if (exitCode !== 0) throw new Error(`PLATFORM_MIGRATION_FAILED:${exitCode}`);

    await grantFoundationPrivileges(lockClient, apiRole, workerRole);
    await assertPostMigrationAuthority(
      lockClient,
      config.expectedDatabaseUser,
      apiRole,
      workerRole,
    );
  } finally {
    try {
      if (locked) {
        await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [
          MIGRATION_ADVISORY_LOCK,
        ]);
      }
    } finally {
      if (connected) await lockClient.end();
    }
  }
}

async function assertMigratorPreflight(
  client: MigrationLockClient,
  expected: {
    migratorRole: string;
    expectedDatabase: string;
    apiRole: string;
    workerRole: string;
  },
): Promise<void> {
  const result = await client.query(MIGRATOR_PREFLIGHT_SQL, [
    expected.apiRole,
    expected.workerRole,
  ]);
  const row = result.rows?.[0];
  const schemaExists = row?.schemaExists === true;
  if (
    row?.serverMajor !== 18 ||
    row.currentUser !== expected.migratorRole ||
    row.currentDatabase !== expected.expectedDatabase ||
    row.databaseOwner !== expected.migratorRole ||
    row.isSuperuser === true ||
    row.canCreateDatabase === true ||
    row.canCreateRole === true ||
    row.canReplicate === true ||
    row.canBypassRls === true ||
    row.inheritsPrivileges !== false ||
    row.hasAnyMembership === true ||
    row.isApiMember === true ||
    row.isWorkerMember === true ||
    row.canCreateDatabaseObject !== true ||
    (schemaExists &&
      (row.schemaOwner !== expected.migratorRole ||
        row.publicCanUseSchema === true ||
        row.publicCanCreateSchema === true))
  ) {
    throw new Error("PLATFORM_MIGRATOR_PREFLIGHT_FAILED");
  }

  const roles = await client.query(RUNTIME_ROLE_PREFLIGHT_SQL, [
    expected.apiRole,
    expected.workerRole,
    expected.migratorRole,
  ]);
  if (roles.rows?.length !== 2 || roles.rows.some((role) => !safeRuntimeRole(role))) {
    throw new Error("PLATFORM_RUNTIME_ROLE_PREFLIGHT_FAILED");
  }
}

const MIGRATOR_PREFLIGHT_SQL = `
  SELECT current_setting('server_version_num')::int / 10000 AS "serverMajor",
         current_user AS "currentUser",
         current_database() AS "currentDatabase",
         db_owner.rolname AS "databaseOwner",
         migrator.rolsuper AS "isSuperuser",
         migrator.rolcreatedb AS "canCreateDatabase",
         migrator.rolcreaterole AS "canCreateRole",
         migrator.rolreplication AS "canReplicate",
         migrator.rolbypassrls AS "canBypassRls",
         migrator.rolinherit AS "inheritsPrivileges",
         EXISTS (SELECT 1 FROM pg_auth_members membership WHERE membership.member = migrator.oid)
           AS "hasAnyMembership",
         pg_has_role(current_user, $1, 'MEMBER') AS "isApiMember",
         pg_has_role(current_user, $2, 'MEMBER') AS "isWorkerMember",
         has_database_privilege(current_user, current_database(), 'CREATE') AS "canCreateDatabaseObject",
         platform_schema.oid IS NOT NULL AS "schemaExists",
         schema_owner.rolname AS "schemaOwner",
         CASE WHEN platform_schema.oid IS NULL THEN FALSE ELSE EXISTS (
           SELECT 1
           FROM aclexplode(COALESCE(platform_schema.nspacl, acldefault('n', platform_schema.nspowner))) acl
           WHERE acl.grantee = 0 AND acl.privilege_type = 'USAGE'
         ) END AS "publicCanUseSchema",
         CASE WHEN platform_schema.oid IS NULL THEN FALSE ELSE EXISTS (
           SELECT 1
           FROM aclexplode(COALESCE(platform_schema.nspacl, acldefault('n', platform_schema.nspowner))) acl
           WHERE acl.grantee = 0 AND acl.privilege_type = 'CREATE'
         ) END AS "publicCanCreateSchema"
  FROM pg_database database_row
  JOIN pg_roles db_owner ON db_owner.oid = database_row.datdba
  JOIN pg_roles migrator ON migrator.rolname = current_user
  LEFT JOIN pg_namespace platform_schema ON platform_schema.nspname = 'platform'
  LEFT JOIN pg_roles schema_owner ON schema_owner.oid = platform_schema.nspowner
  WHERE database_row.datname = current_database()
`;

const RUNTIME_ROLE_PREFLIGHT_SQL = `
  SELECT runtime_role.rolname AS "roleName",
         runtime_role.rolsuper AS "isSuperuser",
         runtime_role.rolcreatedb AS "canCreateDatabase",
         runtime_role.rolcreaterole AS "canCreateRole",
         runtime_role.rolreplication AS "canReplicate",
         runtime_role.rolbypassrls AS "canBypassRls",
         runtime_role.rolinherit AS "inheritsPrivileges",
         EXISTS (SELECT 1 FROM pg_auth_members membership WHERE membership.member = runtime_role.oid)
           AS "hasAnyMembership",
         pg_has_role(runtime_role.rolname, $3, 'MEMBER') AS "isMigratorMember",
         CASE
           WHEN runtime_role.rolname = $1 THEN pg_has_role(runtime_role.rolname, $2, 'MEMBER')
           ELSE pg_has_role(runtime_role.rolname, $1, 'MEMBER')
         END AS "isPeerMember"
  FROM pg_roles runtime_role
  WHERE runtime_role.rolname = ANY(ARRAY[$1, $2]::text[])
  ORDER BY runtime_role.rolname
`;

function safeRuntimeRole(role: Readonly<Record<string, unknown>>): boolean {
  return (
    typeof role.roleName === "string" &&
    role.isSuperuser === false &&
    role.canCreateDatabase === false &&
    role.canCreateRole === false &&
    role.canReplicate === false &&
    role.canBypassRls === false &&
    role.inheritsPrivileges === false &&
    role.hasAnyMembership === false &&
    role.isMigratorMember === false &&
    role.isPeerMember === false
  );
}

async function grantFoundationPrivileges(
  client: MigrationLockClient,
  apiRole: string,
  workerRole: string,
): Promise<void> {
  await client.query("REVOKE ALL ON SCHEMA platform FROM PUBLIC");
  for (const role of [apiRole, workerRole]) {
    const identifier = quoteRoleIdentifier(role);
    await client.query(`REVOKE CREATE ON SCHEMA platform FROM ${identifier}`);
    await client.query(`GRANT USAGE ON SCHEMA platform TO ${identifier}`);
    await client.query(
      `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ` +
        `ON TABLE platform.platform_foundation FROM ${identifier}`,
    );
    await client.query(`GRANT SELECT ON TABLE platform.platform_foundation TO ${identifier}`);
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA platform REVOKE ALL ON TABLES FROM ${identifier}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA platform REVOKE ALL ON SEQUENCES FROM ${identifier}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA platform REVOKE ALL ON FUNCTIONS FROM ${identifier}`,
    );
  }
}

async function assertPostMigrationAuthority(
  client: MigrationLockClient,
  migratorRole: string,
  apiRole: string,
  workerRole: string,
): Promise<void> {
  const result = await client.query(POST_MIGRATION_AUTHORITY_SQL, [apiRole, workerRole]);
  if (
    result.rows?.length !== 2 ||
    result.rows.some(
      (row) =>
        row.schemaOwner !== migratorRole ||
        row.foundationOwner !== migratorRole ||
        row.publicCanUseSchema !== false ||
        row.publicCanCreateSchema !== false ||
        row.canUseSchema !== true ||
        row.canCreateSchema !== false ||
        row.canReadFoundation !== true ||
        row.canMutateFoundation !== false ||
        row.ownsPlatformRelation !== false ||
        row.ownsPlatformFunction !== false ||
        row.hasUnexpectedPlatformPrivilege !== false,
    )
  ) {
    throw new Error("PLATFORM_POST_MIGRATION_AUTHORITY_INVALID");
  }
}

const POST_MIGRATION_AUTHORITY_SQL = `
  SELECT runtime_role.rolname AS "roleName",
         schema_owner.rolname AS "schemaOwner",
         foundation_owner.rolname AS "foundationOwner",
         EXISTS (
           SELECT 1
           FROM aclexplode(COALESCE(platform_schema.nspacl, acldefault('n', platform_schema.nspowner))) acl
           WHERE acl.grantee = 0 AND acl.privilege_type = 'USAGE'
         ) AS "publicCanUseSchema",
         EXISTS (
           SELECT 1
           FROM aclexplode(COALESCE(platform_schema.nspacl, acldefault('n', platform_schema.nspowner))) acl
           WHERE acl.grantee = 0 AND acl.privilege_type = 'CREATE'
         ) AS "publicCanCreateSchema",
         has_schema_privilege(runtime_role.rolname, 'platform', 'USAGE') AS "canUseSchema",
         has_schema_privilege(runtime_role.rolname, 'platform', 'CREATE') AS "canCreateSchema",
         has_table_privilege(runtime_role.rolname, 'platform.platform_foundation', 'SELECT') AS "canReadFoundation",
         has_table_privilege(
           runtime_role.rolname,
           'platform.platform_foundation',
           'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
         ) AS "canMutateFoundation",
         EXISTS (
           SELECT 1
           FROM pg_class owned_relation
           WHERE owned_relation.relnamespace = platform_schema.oid
             AND owned_relation.relowner = runtime_role.oid
         ) AS "ownsPlatformRelation"
         ,EXISTS (
           SELECT 1 FROM pg_proc owned_function
           WHERE owned_function.pronamespace = platform_schema.oid
             AND owned_function.proowner = runtime_role.oid
         ) AS "ownsPlatformFunction"
         ,EXISTS (
           SELECT 1
           FROM pg_class candidate
           WHERE candidate.relnamespace = platform_schema.oid
             AND (
               (candidate.relkind = 'S' AND has_sequence_privilege(
                 runtime_role.rolname, candidate.oid, 'USAGE,SELECT,UPDATE'
               ))
               OR (candidate.relkind <> 'S' AND candidate.relname <> 'platform_foundation' AND (
                 has_table_privilege(runtime_role.rolname, candidate.oid,
                   'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
                 OR has_any_column_privilege(runtime_role.rolname, candidate.oid,
                   'SELECT,INSERT,UPDATE,REFERENCES')
               ))
               OR (candidate.relname = 'platform_foundation' AND (
                 has_table_privilege(runtime_role.rolname, candidate.oid,
                   'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
                 OR has_any_column_privilege(runtime_role.rolname, candidate.oid,
                   'INSERT,UPDATE,REFERENCES')
               ))
             )
         ) OR EXISTS (
           SELECT 1 FROM pg_proc candidate_function
           WHERE candidate_function.pronamespace = platform_schema.oid
             AND has_function_privilege(runtime_role.rolname, candidate_function.oid, 'EXECUTE')
         ) AS "hasUnexpectedPlatformPrivilege"
  FROM pg_roles runtime_role
  JOIN pg_namespace platform_schema ON platform_schema.nspname = 'platform'
  JOIN pg_roles schema_owner ON schema_owner.oid = platform_schema.nspowner
  JOIN pg_class foundation ON foundation.relnamespace = platform_schema.oid
                          AND foundation.relname = 'platform_foundation'
  JOIN pg_roles foundation_owner ON foundation_owner.oid = foundation.relowner
  WHERE runtime_role.rolname = ANY(ARRAY[$1, $2]::text[])
  ORDER BY runtime_role.rolname
`;

function assertDistinctRoles(migratorRole: string, apiRole: string, workerRole: string): void {
  if (new Set([migratorRole, apiRole, workerRole]).size !== 3) {
    throw new Error("PLATFORM_DATABASE_ROLES_MUST_BE_DISTINCT");
  }
}

function requireRole(value: string | undefined, name: string): string {
  if (!value || !/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) {
    throw new Error(`${name}_REQUIRED`);
  }
  return value;
}

function quoteRoleIdentifier(value: string): string {
  return `"${value}"`;
}

export function buildMigratorEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  databaseUrl: string,
): Readonly<Record<string, string | undefined>> {
  const sanitized: Record<string, string | undefined> = { DATABASE_URL_PLATFORM: databaseUrl };
  for (const key of MIGRATOR_ENVIRONMENT_ALLOWLIST) {
    if (environment[key] !== undefined) sanitized[key] = environment[key];
  }
  return sanitized;
}

function defaultLockClient(databaseUrl: string): MigrationLockClient {
  return new Client({
    connectionString: databaseUrl,
    application_name: "kokoro-platform-migrator-lock",
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 30_000,
  });
}

function executeMigrationCommand(
  command: string,
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, [...args], {
      cwd: process.cwd(),
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) return reject(new Error(`PLATFORM_MIGRATION_TERMINATED:${signal}`));
      resolveExit(code ?? 1);
    });
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  runPlatformMigrations().catch((error: unknown) => {
    process.exitCode = 1;
    console.error("Platform migration failed", error);
  });
}
