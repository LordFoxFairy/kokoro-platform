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
  const adminRole = requireRole(
    environment.PLATFORM_DATABASE_ADMIN_ROLE,
    "PLATFORM_DATABASE_ADMIN_ROLE",
  );
  assertDistinctRoles(config.expectedDatabaseUser, apiRole, workerRole, adminRole);

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
      adminRole,
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

    await grantFoundationPrivileges(lockClient, apiRole, workerRole, adminRole);
    await assertPostMigrationAuthority(
      lockClient,
      config.expectedDatabaseUser,
      apiRole,
      workerRole,
      adminRole,
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
    adminRole: string;
  },
): Promise<void> {
  const result = await client.query(MIGRATOR_PREFLIGHT_SQL, [
    expected.apiRole,
    expected.workerRole,
    expected.adminRole,
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
    row.isAdminMember === true ||
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
    expected.adminRole,
    expected.migratorRole,
  ]);
  if (roles.rows?.length !== 3 || roles.rows.some((role) => !safeRuntimeRole(role))) {
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
         pg_has_role(current_user, $3, 'MEMBER') AS "isAdminMember",
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
         pg_has_role(runtime_role.rolname, $4, 'MEMBER') AS "isMigratorMember",
         EXISTS (
           SELECT 1 FROM unnest(ARRAY[$1,$2,$3]::text[]) peer(role_name)
           WHERE peer.role_name <> runtime_role.rolname
             AND pg_has_role(runtime_role.rolname, peer.role_name, 'MEMBER')
         ) AS "isPeerMember"
  FROM pg_roles runtime_role
  WHERE runtime_role.rolname = ANY(ARRAY[$1,$2,$3]::text[])
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
  adminRole: string,
): Promise<void> {
  await client.query("REVOKE ALL ON SCHEMA platform FROM PUBLIC");
  for (const role of [apiRole, workerRole, adminRole]) {
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
    await client.query(`REVOKE ALL ON TABLE ${KERNEL_AND_MODEL_TABLES} FROM ${identifier}`);
    await client.query(
      `REVOKE ALL ON FUNCTION platform.import_model_inventory(UUID, TEXT, TEXT, JSONB, JSONB, TEXT), platform.activate_model_inventory(UUID, TEXT, BIGINT, TEXT), platform.put_model_site_policy(UUID, TEXT, TEXT, TEXT, BIGINT), platform.resolve_model_candidates(TEXT, TEXT, TEXT), platform.find_model_selection_decision(UUID), platform.report_model_provider_availability(UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ, TEXT) FROM ${identifier}`,
    );
    if (role === apiRole) {
      await client.query(`GRANT SELECT ON TABLE ${KERNEL_TABLES} TO ${identifier}`);
      await client.query(
        `GRANT INSERT ON TABLE platform.command_receipt, platform.outbox_event, platform.inbox_delivery, platform.model_selection_decision TO ${identifier}`,
      );
      await client.query(
        `GRANT UPDATE ON TABLE platform.command_receipt, platform.inbox_delivery TO ${identifier}`,
      );
      await client.query(
        `GRANT EXECUTE ON FUNCTION platform.resolve_model_candidates(TEXT, TEXT, TEXT), platform.find_model_selection_decision(UUID) TO ${identifier}`,
      );
    } else if (role === workerRole) {
      await client.query(`GRANT SELECT ON TABLE ${KERNEL_TABLES} TO ${identifier}`);
      await client.query(`GRANT INSERT ON TABLE platform.inbox_delivery TO ${identifier}`);
      await client.query(
        `GRANT UPDATE ON TABLE platform.command_receipt, platform.outbox_event, platform.inbox_delivery TO ${identifier}`,
      );
      await client.query(
        `GRANT EXECUTE ON FUNCTION platform.report_model_provider_availability(UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ, TEXT) TO ${identifier}`,
      );
    } else {
      await client.query(
        `GRANT EXECUTE ON FUNCTION platform.import_model_inventory(UUID, TEXT, TEXT, JSONB, JSONB, TEXT), platform.activate_model_inventory(UUID, TEXT, BIGINT, TEXT), platform.put_model_site_policy(UUID, TEXT, TEXT, TEXT, BIGINT) TO ${identifier}`,
      );
    }
  }
}

const KERNEL_TABLES = [
  "platform.command_receipt",
  "platform.outbox_event",
  "platform.inbox_delivery",
].join(", ");

const KERNEL_AND_MODEL_TABLES = [
  "platform.command_receipt",
  "platform.outbox_event",
  "platform.inbox_delivery",
  "platform.model_inventory_import",
  "platform.model_inventory_activation",
  "platform.model_inventory_pointer",
  "platform.model_provider_snapshot",
  "platform.model_definition_snapshot",
  "platform.model_provider_binding_snapshot",
  "platform.model_product_route_snapshot",
  "platform.model_provider_availability",
  "platform.model_definition_availability",
  "platform.model_provider_availability_report",
  "platform.model_site_policy_revision",
  "platform.model_site_assignment_revision",
  "platform.model_site_policy_pointer",
  "platform.model_selection_decision",
].join(", ");

async function assertPostMigrationAuthority(
  client: MigrationLockClient,
  migratorRole: string,
  apiRole: string,
  workerRole: string,
  adminRole: string,
): Promise<void> {
  const result = await client.query(POST_MIGRATION_AUTHORITY_SQL, [apiRole, workerRole, adminRole]);
  if (
    result.rows?.length !== 3 ||
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
        row.hasRequiredPlatformWrites !== true ||
        row.canExecuteModelInventoryImport !== (row.roleName === adminRole) ||
        row.canExecuteModelInventoryActivate !== (row.roleName === adminRole) ||
        row.canExecuteModelSitePolicyChange !== (row.roleName === adminRole) ||
        row.canExecuteModelCandidatesProjection !== (row.roleName === apiRole) ||
        row.canExecuteModelDecisionProjection !== (row.roleName === apiRole) ||
        row.canExecuteModelAvailabilityReport !== (row.roleName === workerRole) ||
        row.canSelectModelCatalogTable !== false ||
        row.canReadModelSensitiveColumn !== false ||
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
         ,CASE WHEN runtime_role.rolname = $1 THEN
           has_table_privilege(runtime_role.rolname, 'platform.command_receipt', 'INSERT,UPDATE')
           AND has_table_privilege(runtime_role.rolname, 'platform.outbox_event', 'INSERT')
           AND has_table_privilege(runtime_role.rolname, 'platform.inbox_delivery', 'INSERT,UPDATE')
           AND has_table_privilege(runtime_role.rolname, 'platform.model_selection_decision', 'INSERT')
         WHEN runtime_role.rolname = $2 THEN
           has_table_privilege(runtime_role.rolname, 'platform.command_receipt', 'UPDATE')
           AND has_table_privilege(runtime_role.rolname, 'platform.outbox_event', 'UPDATE')
           AND has_table_privilege(runtime_role.rolname, 'platform.inbox_delivery', 'INSERT,UPDATE')
         ELSE TRUE
         END AS "hasRequiredPlatformWrites"
         ,has_function_privilege(runtime_role.rolname, 'platform.import_model_inventory(uuid,text,text,jsonb,jsonb,text)', 'EXECUTE')
           AS "canExecuteModelInventoryImport"
         ,has_function_privilege(runtime_role.rolname, 'platform.activate_model_inventory(uuid,text,bigint,text)', 'EXECUTE')
           AS "canExecuteModelInventoryActivate"
         ,has_function_privilege(runtime_role.rolname, 'platform.put_model_site_policy(uuid,text,text,text,bigint)', 'EXECUTE')
           AS "canExecuteModelSitePolicyChange"
         ,has_function_privilege(runtime_role.rolname, 'platform.resolve_model_candidates(text,text,text)', 'EXECUTE')
           AS "canExecuteModelCandidatesProjection"
         ,has_function_privilege(runtime_role.rolname, 'platform.find_model_selection_decision(uuid)', 'EXECUTE')
           AS "canExecuteModelDecisionProjection"
         ,has_function_privilege(runtime_role.rolname, 'platform.report_model_provider_availability(uuid,text,text,text,bigint,text,timestamptz,text)', 'EXECUTE')
           AS "canExecuteModelAvailabilityReport"
         ,EXISTS (
           SELECT 1 FROM pg_class model_relation
           WHERE model_relation.relnamespace=platform_schema.oid
             AND model_relation.relname=ANY(ARRAY[
               'model_inventory_import','model_inventory_activation','model_inventory_pointer','model_provider_snapshot',
               'model_definition_snapshot','model_provider_binding_snapshot','model_product_route_snapshot',
               'model_provider_availability','model_definition_availability','model_provider_availability_report','model_site_policy_revision',
               'model_site_assignment_revision','model_site_policy_pointer','model_selection_decision'
             ])
             AND has_table_privilege(runtime_role.rolname,model_relation.oid,'SELECT')
         ) AS "canSelectModelCatalogTable"
         ,(has_any_column_privilege(runtime_role.rolname,'platform.model_inventory_import','SELECT')
           OR has_any_column_privilege(runtime_role.rolname,'platform.model_provider_snapshot','SELECT'))
           AS "canReadModelSensitiveColumn"
         ,EXISTS (
           SELECT 1
           FROM pg_class candidate
           WHERE candidate.relnamespace = platform_schema.oid
             AND (
               (candidate.relkind = 'S' AND has_sequence_privilege(
                 runtime_role.rolname, candidate.oid, 'USAGE,SELECT,UPDATE'
               ))
               OR (candidate.relkind <> 'S' AND candidate.relname <> ALL(ARRAY[
                 'platform_foundation','command_receipt','outbox_event','inbox_delivery',
                 'model_inventory_import','model_inventory_activation','model_inventory_pointer','model_provider_snapshot',
                 'model_definition_snapshot','model_provider_binding_snapshot','model_product_route_snapshot','model_provider_availability',
                 'model_definition_availability','model_provider_availability_report','model_site_policy_revision',
                 'model_site_assignment_revision','model_site_policy_pointer','model_selection_decision'
               ]) AND (
                 (candidate.relname LIKE 'model\\_%' ESCAPE '\\' AND (
                   has_table_privilege(runtime_role.rolname,candidate.oid,'SELECT')
                   OR has_any_column_privilege(runtime_role.rolname,candidate.oid,'SELECT')
                 ))
                 OR
                 has_table_privilege(runtime_role.rolname, candidate.oid,
                   'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
                 OR has_any_column_privilege(runtime_role.rolname, candidate.oid,
                   'SELECT,INSERT,UPDATE,REFERENCES')
               ))
               OR (candidate.relname = ANY(ARRAY[
                 'command_receipt','outbox_event','inbox_delivery','model_inventory_import','model_inventory_activation',
                 'model_inventory_pointer','model_provider_snapshot','model_definition_snapshot','model_provider_binding_snapshot',
                 'model_product_route_snapshot','model_provider_availability',
                 'model_definition_availability','model_provider_availability_report','model_site_policy_revision',
                 'model_site_assignment_revision','model_site_policy_pointer','model_selection_decision'
               ]) AND (
                 has_table_privilege(runtime_role.rolname, candidate.oid,
                   'DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
                 OR has_any_column_privilege(runtime_role.rolname, candidate.oid, 'REFERENCES')
                 OR (has_table_privilege(runtime_role.rolname, candidate.oid, 'INSERT') AND NOT (
                   (runtime_role.rolname = $1 AND candidate.relname = ANY(ARRAY['command_receipt','outbox_event','inbox_delivery','model_selection_decision']))
                   OR (runtime_role.rolname = $2 AND candidate.relname = 'inbox_delivery')
                 ))
                 OR (has_table_privilege(runtime_role.rolname, candidate.oid, 'UPDATE') AND NOT (
                   (runtime_role.rolname = $1 AND candidate.relname = ANY(ARRAY['command_receipt','inbox_delivery']))
                   OR (runtime_role.rolname = $2 AND candidate.relname = ANY(ARRAY['command_receipt','outbox_event','inbox_delivery']))
                 ))
                 OR (has_any_column_privilege(runtime_role.rolname, candidate.oid, 'INSERT') AND NOT (
                   (runtime_role.rolname = $1 AND candidate.relname = ANY(ARRAY['command_receipt','outbox_event','inbox_delivery','model_selection_decision']))
                   OR (runtime_role.rolname = $2 AND candidate.relname = 'inbox_delivery')
                 ))
                 OR (has_any_column_privilege(runtime_role.rolname, candidate.oid, 'UPDATE') AND NOT (
                   (runtime_role.rolname = $1 AND candidate.relname = ANY(ARRAY['command_receipt','inbox_delivery']))
                   OR (runtime_role.rolname = $2 AND candidate.relname = ANY(ARRAY['command_receipt','outbox_event','inbox_delivery']))
                 ))
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
             AND NOT (
               (runtime_role.rolname = $3 AND candidate_function.oid = ANY(ARRAY[
                 to_regprocedure('platform.import_model_inventory(uuid,text,text,jsonb,jsonb,text)'),
                 to_regprocedure('platform.activate_model_inventory(uuid,text,bigint,text)'),
                 to_regprocedure('platform.put_model_site_policy(uuid,text,text,text,bigint)')
               ]))
               OR (runtime_role.rolname = $1 AND candidate_function.oid = ANY(ARRAY[
                 to_regprocedure('platform.resolve_model_candidates(text,text,text)'),
                 to_regprocedure('platform.find_model_selection_decision(uuid)')
               ]))
               OR (runtime_role.rolname = $2 AND candidate_function.oid =
                 to_regprocedure('platform.report_model_provider_availability(uuid,text,text,text,bigint,text,timestamptz,text)'))
             )
         ) AS "hasUnexpectedPlatformPrivilege"
  FROM pg_roles runtime_role
  JOIN pg_namespace platform_schema ON platform_schema.nspname = 'platform'
  JOIN pg_roles schema_owner ON schema_owner.oid = platform_schema.nspowner
  JOIN pg_class foundation ON foundation.relnamespace = platform_schema.oid
                          AND foundation.relname = 'platform_foundation'
  JOIN pg_roles foundation_owner ON foundation_owner.oid = foundation.relowner
  WHERE runtime_role.rolname = ANY(ARRAY[$1,$2,$3]::text[])
  ORDER BY runtime_role.rolname
`;

function assertDistinctRoles(
  migratorRole: string,
  apiRole: string,
  workerRole: string,
  adminRole: string,
): void {
  if (new Set([migratorRole, apiRole, workerRole, adminRole]).size !== 4) {
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
