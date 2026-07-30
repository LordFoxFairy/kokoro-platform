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
  const admissionRole = requireRole(
    environment.PLATFORM_DATABASE_ADMISSION_ROLE,
    "PLATFORM_DATABASE_ADMISSION_ROLE",
  );
  const workerRole = requireRole(
    environment.PLATFORM_DATABASE_WORKER_ROLE,
    "PLATFORM_DATABASE_WORKER_ROLE",
  );
  const authorizationRole = requireRole(
    environment.PLATFORM_DATABASE_AUTHORIZATION_ROLE,
    "PLATFORM_DATABASE_AUTHORIZATION_ROLE",
  );
  const assetDataPlaneRole = requireRole(
    environment.PLATFORM_DATABASE_ASSET_DATA_PLANE_ROLE,
    "PLATFORM_DATABASE_ASSET_DATA_PLANE_ROLE",
  );
  const adminRole = requireRole(
    environment.PLATFORM_DATABASE_ADMIN_ROLE,
    "PLATFORM_DATABASE_ADMIN_ROLE",
  );
  const modelGatewayRole = requireRole(
    environment.PLATFORM_DATABASE_MODEL_GATEWAY_ROLE,
    "PLATFORM_DATABASE_MODEL_GATEWAY_ROLE",
  );
  assertDistinctRoles(
    config.expectedDatabaseUser,
    apiRole,
    admissionRole,
    authorizationRole,
    assetDataPlaneRole,
    workerRole,
    adminRole,
    modelGatewayRole,
  );

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
      admissionRole,
      authorizationRole,
      workerRole,
      adminRole,
    });
    await assertModelGatewayRolePreflight(lockClient, modelGatewayRole, config.expectedDatabaseUser);
    await assertAssetDataPlaneRolePreflight(
      lockClient,
      assetDataPlaneRole,
      config.expectedDatabaseUser,
    );
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

    await grantFoundationPrivileges(
      lockClient,
      apiRole,
      admissionRole,
      authorizationRole,
      workerRole,
      adminRole,
    );
    await grantModelGatewayPrivileges(lockClient, modelGatewayRole, admissionRole);
    await grantAssetDataPlanePrivileges(lockClient, assetDataPlaneRole);
    await assertPostMigrationAuthority(
      lockClient,
      config.expectedDatabaseUser,
      apiRole,
      admissionRole,
      authorizationRole,
      workerRole,
      adminRole,
    );
    await assertModelGatewayAuthority(lockClient, modelGatewayRole);
    await assertAssetDataPlaneAuthority(lockClient, assetDataPlaneRole);
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
    admissionRole: string;
    authorizationRole: string;
    workerRole: string;
    adminRole: string;
  },
): Promise<void> {
  const result = await client.query(MIGRATOR_PREFLIGHT_SQL, [
    expected.apiRole,
    expected.admissionRole,
    expected.authorizationRole,
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
    row.isAdmissionMember === true ||
    row.isAuthorizationMember === true ||
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
    expected.admissionRole,
    expected.authorizationRole,
    expected.workerRole,
    expected.adminRole,
    expected.migratorRole,
  ]);
  if (roles.rows?.length !== 5 || roles.rows.some((role) => !safeRuntimeRole(role))) {
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
         pg_has_role(current_user, $2, 'MEMBER') AS "isAdmissionMember",
         pg_has_role(current_user, $3, 'MEMBER') AS "isAuthorizationMember",
         pg_has_role(current_user, $4, 'MEMBER') AS "isWorkerMember",
         pg_has_role(current_user, $5, 'MEMBER') AS "isAdminMember",
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
         pg_has_role(runtime_role.rolname, $6, 'MEMBER') AS "isMigratorMember",
         EXISTS (
           SELECT 1 FROM unnest(ARRAY[$1,$2,$3,$4,$5]::text[]) peer(role_name)
           WHERE peer.role_name <> runtime_role.rolname
             AND pg_has_role(runtime_role.rolname, peer.role_name, 'MEMBER')
         ) AS "isPeerMember"
  FROM pg_roles runtime_role
  WHERE runtime_role.rolname = ANY(ARRAY[$1,$2,$3,$4,$5]::text[])
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

async function assertModelGatewayRolePreflight(
  client: MigrationLockClient,
  modelGatewayRole: string,
  migratorRole: string,
): Promise<void> {
  const result = await client.query(MODEL_GATEWAY_ROLE_PREFLIGHT_SQL, [
    modelGatewayRole,
    migratorRole,
  ]);
  const row = result.rows?.[0];
  if (result.rows?.length !== 1 || !safeRuntimeRole(row ?? {})) {
    throw new Error("PLATFORM_MODEL_GATEWAY_ROLE_PREFLIGHT_FAILED");
  }
}

async function assertAssetDataPlaneRolePreflight(
  client: MigrationLockClient,
  assetDataPlaneRole: string,
  migratorRole: string,
): Promise<void> {
  const result = await client.query(ASSET_DATA_PLANE_ROLE_PREFLIGHT_SQL, [
    assetDataPlaneRole,
    migratorRole,
  ]);
  const row = result.rows?.[0];
  if (result.rows?.length !== 1 || !safeRuntimeRole(row ?? {})) {
    throw new Error("PLATFORM_ASSET_DATA_PLANE_ROLE_PREFLIGHT_FAILED");
  }
}

async function grantModelGatewayPrivileges(
  client: MigrationLockClient,
  modelGatewayRole: string,
  admissionRole: string,
): Promise<void> {
  const gateway = quoteRoleIdentifier(modelGatewayRole);
  const admission = quoteRoleIdentifier(admissionRole);
  await client.query(`REVOKE ALL ON SCHEMA platform FROM ${gateway}`);
  await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA platform FROM ${gateway}`);
  await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA platform FROM ${gateway}`);
  await client.query(`REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA platform FROM ${gateway}`);
  await client.query(`GRANT USAGE ON SCHEMA platform TO ${gateway}`);
  await client.query(`GRANT SELECT ON TABLE platform.platform_foundation TO ${gateway}`);
  await client.query(
    `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ` +
      `ON TABLE platform.platform_foundation FROM ${gateway}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA platform REVOKE ALL ON TABLES FROM ${gateway}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA platform REVOKE ALL ON SEQUENCES FROM ${gateway}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA platform REVOKE ALL ON FUNCTIONS FROM ${gateway}`,
  );
  await client.query(
    `REVOKE ALL ON TABLE platform.model_gateway_execution_authorization FROM ${gateway}`,
  );
  await client.query(
    `GRANT EXECUTE ON FUNCTION platform.resolve_model_gateway_authorization(TEXT,TEXT) TO ${gateway}`,
  );
  await client.query(
    `GRANT EXECUTE ON FUNCTION platform.list_model_gateway_dispatch_candidates(INTEGER) TO ${gateway}`,
  );
  await client.query(
    `GRANT SELECT ON TABLE platform.model_gateway_capacity TO ${gateway}`,
  );
  await client.query(
    `GRANT UPDATE(active_count,queued_count,updated_at) ` +
      `ON TABLE platform.model_gateway_capacity TO ${gateway}`,
  );
  await client.query(
    `GRANT SELECT,INSERT ON TABLE platform.model_gateway_invocation TO ${gateway}`,
  );
  await client.query(
    `GRANT UPDATE(state,response_envelope,evidence_ref,source_digest,owner_evidence_ref,fence_epoch,` +
      `dispatch_owner_ref,dispatch_fence,dispatch_lease_expires_at,last_frame_sequence,last_frame_digest,` +
      `frame_count,total_frame_bytes,updated_at) ` +
      `ON TABLE platform.model_gateway_invocation TO ${gateway}`,
  );
  await client.query(
    `GRANT SELECT,INSERT ON TABLE platform.model_gateway_frame TO ${gateway}`,
  );
  await client.query(
    `GRANT INSERT ON TABLE platform.model_gateway_dispatch_queue TO ${gateway}`,
  );
  await client.query(
    `GRANT UPDATE(state,dispatch_owner_ref,dispatch_lease_expires_at,updated_at) ` +
      `ON TABLE platform.model_gateway_dispatch_queue TO ${gateway}`,
  );
  await client.query(
    `GRANT SELECT,INSERT ON TABLE platform.model_gateway_attempt_usage_fact TO ${gateway}`,
  );
  await client.query(
    `GRANT SELECT,INSERT ON TABLE platform.model_gateway_outbox TO ${gateway}`,
  );
  await client.query(
    `GRANT SELECT ON TABLE platform.credit_rating_policy_revision, platform.credit_rating_snapshot, ` +
      `platform.credit_authorization_segment, platform.credit_budget_allocation, ` +
      `platform.credit_budget_allocation_revision, platform.credit_execution_budget_root, ` +
      `platform.credit_hold TO ${gateway}`,
  );
  await client.query(
    `GRANT SELECT,INSERT ON TABLE platform.credit_usage_command_receipt, ` +
      `platform.credit_attempt_usage_evidence TO ${gateway}`,
  );
  await client.query(
    `GRANT SELECT,INSERT ON TABLE platform.credit_usage_attempt_intent TO ${gateway}`,
  );
  await client.query(
    `GRANT UPDATE(fence_epoch,state,owner_evidence_ref,provisional_customer_amount,updated_at) ` +
      `ON TABLE platform.credit_usage_attempt_intent TO ${gateway}`,
  );
  await client.query(`GRANT INSERT ON TABLE platform.outbox_event TO ${gateway}`);
  await client.query(
    `GRANT INSERT ON TABLE platform.model_gateway_execution_authorization TO ${admission}`,
  );
  await client.query(
    `GRANT SELECT(authorization_handle,state), UPDATE(state,updated_at) ` +
      `ON TABLE platform.model_gateway_execution_authorization TO ${admission}`,
  );
}

async function assertModelGatewayAuthority(
  client: MigrationLockClient,
  modelGatewayRole: string,
): Promise<void> {
  const result = await client.query(MODEL_GATEWAY_POST_AUTHORITY_SQL, [modelGatewayRole]);
  const row = result.rows?.[0];
  if (result.rows?.length !== 1 || row?.modelGatewayAuthorityOk !== true ||
      row?.canReadAuthorizationProjection !== false) {
    throw new Error("PLATFORM_MODEL_GATEWAY_POST_AUTHORITY_INVALID");
  }
}

async function grantAssetDataPlanePrivileges(
  client: MigrationLockClient,
  assetDataPlaneRole: string,
): Promise<void> {
  const dataPlane = quoteRoleIdentifier(assetDataPlaneRole);
  await client.query(`REVOKE ALL ON SCHEMA platform FROM ${dataPlane}`);
  await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA platform FROM ${dataPlane}`);
  await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA platform FROM ${dataPlane}`);
  await client.query(`REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA platform FROM ${dataPlane}`);
  await client.query(`GRANT USAGE ON SCHEMA platform TO ${dataPlane}`);
  await client.query(`GRANT SELECT ON TABLE platform.platform_foundation TO ${dataPlane}`);
  await client.query(
    `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ` +
      `ON TABLE platform.platform_foundation FROM ${dataPlane}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA platform REVOKE ALL ON TABLES FROM ${dataPlane}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA platform REVOKE ALL ON SEQUENCES FROM ${dataPlane}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA platform REVOKE ALL ON FUNCTIONS FROM ${dataPlane}`,
  );
  await client.query(
    `GRANT SELECT ON TABLE platform.authorization_product_binding, ` +
      `platform.authorization_subject, platform.authorization_project, ` +
      `platform.authorization_project_membership, platform.asset_upload_intent, ` +
      `platform.asset_upload_session, platform.asset_multipart_upload, ` +
      `platform.asset_multipart_part TO ${dataPlane}`,
  );
  await client.query(
    `GRANT UPDATE(state,completion_requested_at,expected_version,updated_at) ` +
      `ON TABLE platform.asset_upload_session TO ${dataPlane}`,
  );
  await client.query(
    `GRANT INSERT ON TABLE platform.asset_multipart_upload, ` +
      `platform.asset_multipart_part TO ${dataPlane}`,
  );
  await client.query(
    `GRANT UPDATE(provider_upload_id,state,outcome_operation,expected_version,` +
      `initiation_effect_token,initiation_effect_lease_expires_at,` +
      `completion_idempotency_key,completion_request_digest,completion_receipt_ref,` +
      `completion_effect_token,completion_effect_lease_expires_at,abort_idempotency_key,` +
      `abort_request_digest,abort_receipt_ref,abort_effect_token,abort_effect_lease_expires_at,` +
      `updated_at) ON TABLE platform.asset_multipart_upload TO ${dataPlane}`,
  );
  await client.query(
    `GRANT UPDATE(provider_etag,state,expected_version,effect_token,effect_lease_expires_at,` +
      `updated_at) ON TABLE platform.asset_multipart_part TO ${dataPlane}`,
  );
  await client.query(
    `GRANT EXECUTE ON FUNCTION platform.enqueue_asset_upload_completion_event(` +
      `UUID,TEXT,JSONB,CHAR(64),TEXT,TEXT) TO ${dataPlane}`,
  );
}

async function assertAssetDataPlaneAuthority(
  client: MigrationLockClient,
  assetDataPlaneRole: string,
): Promise<void> {
  const result = await client.query(ASSET_DATA_PLANE_POST_AUTHORITY_SQL, [assetDataPlaneRole]);
  const row = result.rows?.[0];
  if (result.rows?.length !== 1 || row?.assetDataPlaneAuthorityOk !== true ||
      row?.canReadGenericOutbox !== false || row?.canMutateAssetOwnerIntent !== false) {
    throw new Error("PLATFORM_ASSET_DATA_PLANE_POST_AUTHORITY_INVALID");
  }
}

const MODEL_GATEWAY_ROLE_PREFLIGHT_SQL = `
  SELECT runtime_role.rolname AS "roleName",runtime_role.rolsuper AS "isSuperuser",
    runtime_role.rolcreatedb AS "canCreateDatabase",runtime_role.rolcreaterole AS "canCreateRole",
    runtime_role.rolreplication AS "canReplicate",runtime_role.rolbypassrls AS "canBypassRls",
    runtime_role.rolinherit AS "inheritsPrivileges",
    EXISTS (SELECT 1 FROM pg_auth_members membership WHERE membership.member=runtime_role.oid)
      AS "hasAnyMembership",
    pg_has_role(runtime_role.rolname,$2,'MEMBER') AS "isMigratorMember",
    EXISTS (SELECT 1 FROM pg_auth_members membership WHERE membership.roleid=runtime_role.oid)
      AS "isPeerMember",
    EXISTS (SELECT 1 FROM information_schema.role_table_grants grant_row
      WHERE grant_row.grantee=runtime_role.rolname AND grant_row.table_schema='platform')
      AS "hasAnyPlatformTablePrivilege",
    CASE WHEN to_regnamespace('platform') IS NULL THEN FALSE
      ELSE has_schema_privilege(runtime_role.rolname,'platform','USAGE') END AS "canUsePlatformSchema",
    CASE WHEN to_regnamespace('platform') IS NULL THEN FALSE
      ELSE has_schema_privilege(runtime_role.rolname,'platform','CREATE') END AS "canCreatePlatformSchema"
  FROM pg_roles runtime_role WHERE runtime_role.rolname=$1 /* modelGatewayRolePreflight */`;

const ASSET_DATA_PLANE_ROLE_PREFLIGHT_SQL = `
  SELECT runtime_role.rolname AS "roleName",runtime_role.rolsuper AS "isSuperuser",
    runtime_role.rolcreatedb AS "canCreateDatabase",runtime_role.rolcreaterole AS "canCreateRole",
    runtime_role.rolreplication AS "canReplicate",runtime_role.rolbypassrls AS "canBypassRls",
    runtime_role.rolinherit AS "inheritsPrivileges",
    EXISTS (SELECT 1 FROM pg_auth_members membership WHERE membership.member=runtime_role.oid)
      AS "hasAnyMembership",
    pg_has_role(runtime_role.rolname,$2,'MEMBER') AS "isMigratorMember",
    EXISTS (SELECT 1 FROM pg_auth_members membership WHERE membership.roleid=runtime_role.oid)
      AS "isPeerMember",
    EXISTS (SELECT 1 FROM information_schema.role_table_grants grant_row
      WHERE grant_row.grantee=runtime_role.rolname AND grant_row.table_schema='platform')
      AS "hasAnyPlatformTablePrivilege",
    CASE WHEN to_regnamespace('platform') IS NULL THEN FALSE
      ELSE has_schema_privilege(runtime_role.rolname,'platform','USAGE') END AS "canUsePlatformSchema",
    CASE WHEN to_regnamespace('platform') IS NULL THEN FALSE
      ELSE has_schema_privilege(runtime_role.rolname,'platform','CREATE') END AS "canCreatePlatformSchema"
  FROM pg_roles runtime_role WHERE runtime_role.rolname=$1 /* assetDataPlaneRolePreflight */`;

const MODEL_GATEWAY_POST_AUTHORITY_SQL = `
  SELECT
    has_schema_privilege($1,'platform','USAGE')
      AND NOT has_schema_privilege($1,'platform','CREATE')
      AND has_table_privilege($1,'platform.platform_foundation','SELECT')
      AND NOT has_table_privilege($1,'platform.platform_foundation','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND has_function_privilege($1,'platform.resolve_model_gateway_authorization(TEXT,TEXT)','EXECUTE')
      AND has_function_privilege($1,'platform.list_model_gateway_dispatch_candidates(INTEGER)','EXECUTE')
      AND has_table_privilege($1,'platform.model_gateway_capacity','SELECT')
      AND has_column_privilege($1,'platform.model_gateway_capacity','active_count','UPDATE')
      AND has_column_privilege($1,'platform.model_gateway_capacity','queued_count','UPDATE')
      AND has_column_privilege($1,'platform.model_gateway_capacity','updated_at','UPDATE')
      AND (has_table_privilege($1, 'platform.model_gateway_invocation', 'SELECT') AND has_table_privilege($1, 'platform.model_gateway_invocation', 'INSERT'))
      AND has_column_privilege($1,'platform.model_gateway_invocation','state','UPDATE')
      AND has_column_privilege($1,'platform.model_gateway_invocation','response_envelope','UPDATE')
      AND has_column_privilege($1,'platform.model_gateway_invocation','evidence_ref','UPDATE')
      AND has_column_privilege($1,'platform.model_gateway_invocation','source_digest','UPDATE')
      AND has_column_privilege($1,'platform.model_gateway_invocation','owner_evidence_ref','UPDATE')
      AND has_column_privilege($1,'platform.model_gateway_invocation','fence_epoch','UPDATE')
      AND has_column_privilege($1,'platform.model_gateway_invocation','dispatch_owner_ref','UPDATE')
      AND has_column_privilege($1,'platform.model_gateway_invocation','dispatch_fence','UPDATE')
      AND has_column_privilege($1,'platform.model_gateway_invocation','dispatch_lease_expires_at','UPDATE')
      AND has_column_privilege($1,'platform.model_gateway_invocation','last_frame_sequence','UPDATE')
      AND has_column_privilege($1,'platform.model_gateway_invocation','last_frame_digest','UPDATE')
      AND has_column_privilege($1,'platform.model_gateway_invocation','frame_count','UPDATE')
      AND has_column_privilege($1,'platform.model_gateway_invocation','total_frame_bytes','UPDATE')
      AND has_column_privilege($1,'platform.model_gateway_invocation','updated_at','UPDATE')
      AND (has_table_privilege($1, 'platform.model_gateway_frame', 'SELECT') AND has_table_privilege($1, 'platform.model_gateway_frame', 'INSERT'))
      AND has_table_privilege($1,'platform.model_gateway_dispatch_queue','INSERT')
      AND NOT has_table_privilege($1,'platform.model_gateway_dispatch_queue','SELECT')
      AND has_column_privilege($1,'platform.model_gateway_dispatch_queue','state','UPDATE')
      AND has_column_privilege($1,'platform.model_gateway_dispatch_queue','dispatch_owner_ref','UPDATE')
      AND has_column_privilege($1,'platform.model_gateway_dispatch_queue','dispatch_lease_expires_at','UPDATE')
      AND has_column_privilege($1,'platform.model_gateway_dispatch_queue','updated_at','UPDATE')
      AND (has_table_privilege($1, 'platform.model_gateway_attempt_usage_fact', 'SELECT') AND has_table_privilege($1, 'platform.model_gateway_attempt_usage_fact', 'INSERT'))
      AND (has_table_privilege($1, 'platform.model_gateway_outbox', 'SELECT') AND has_table_privilege($1, 'platform.model_gateway_outbox', 'INSERT'))
      AND (has_table_privilege($1, 'platform.credit_usage_command_receipt', 'SELECT') AND has_table_privilege($1, 'platform.credit_usage_command_receipt', 'INSERT'))
      AND (has_table_privilege($1, 'platform.credit_usage_attempt_intent', 'SELECT') AND has_table_privilege($1, 'platform.credit_usage_attempt_intent', 'INSERT'))
      AND has_column_privilege($1,'platform.credit_usage_attempt_intent','fence_epoch','UPDATE')
      AND has_column_privilege($1,'platform.credit_usage_attempt_intent','state','UPDATE')
      AND has_column_privilege($1,'platform.credit_usage_attempt_intent','owner_evidence_ref','UPDATE')
      AND has_column_privilege($1,'platform.credit_usage_attempt_intent','provisional_customer_amount','UPDATE')
      AND has_column_privilege($1,'platform.credit_usage_attempt_intent','updated_at','UPDATE')
      AND (has_table_privilege($1, 'platform.credit_attempt_usage_evidence', 'SELECT') AND has_table_privilege($1, 'platform.credit_attempt_usage_evidence', 'INSERT'))
      AND has_table_privilege($1,'platform.credit_rating_policy_revision','SELECT')
      AND has_table_privilege($1,'platform.credit_rating_snapshot','SELECT')
      AND has_table_privilege($1,'platform.credit_authorization_segment','SELECT')
      AND has_table_privilege($1,'platform.credit_budget_allocation','SELECT')
      AND has_table_privilege($1,'platform.credit_budget_allocation_revision','SELECT')
      AND has_table_privilege($1,'platform.credit_execution_budget_root','SELECT')
      AND has_table_privilege($1,'platform.credit_hold','SELECT')
      AND has_table_privilege($1,'platform.outbox_event','INSERT') AS "modelGatewayAuthorityOk",
    has_table_privilege($1,'platform.model_gateway_execution_authorization','SELECT')
      AS "canReadAuthorizationProjection"
  /* modelGatewayAuthority */`;

const ASSET_DATA_PLANE_POST_AUTHORITY_SQL = `
  SELECT
    has_schema_privilege($1,'platform','USAGE')
      AND NOT has_schema_privilege($1,'platform','CREATE')
      AND has_table_privilege($1,'platform.platform_foundation','SELECT')
      AND NOT has_table_privilege($1,'platform.platform_foundation','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND has_table_privilege($1,'platform.authorization_product_binding','SELECT')
      AND has_table_privilege($1,'platform.authorization_subject','SELECT')
      AND has_table_privilege($1,'platform.authorization_project','SELECT')
      AND has_table_privilege($1,'platform.authorization_project_membership','SELECT')
      AND has_table_privilege($1,'platform.asset_upload_intent','SELECT')
      AND has_table_privilege($1,'platform.asset_upload_session','SELECT')
      AND has_column_privilege($1,'platform.asset_upload_session','state','UPDATE')
      AND has_column_privilege($1,'platform.asset_upload_session','completion_requested_at','UPDATE')
      AND has_column_privilege($1,'platform.asset_upload_session','expected_version','UPDATE')
      AND has_column_privilege($1,'platform.asset_upload_session','updated_at','UPDATE')
      AND (has_table_privilege($1, 'platform.asset_multipart_upload', 'SELECT') AND has_table_privilege($1, 'platform.asset_multipart_upload', 'INSERT'))
      AND has_column_privilege($1,'platform.asset_multipart_upload','state','UPDATE')
      AND has_column_privilege($1,'platform.asset_multipart_upload','expected_version','UPDATE')
      AND (has_table_privilege($1, 'platform.asset_multipart_part', 'SELECT') AND has_table_privilege($1, 'platform.asset_multipart_part', 'INSERT'))
      AND has_column_privilege($1,'platform.asset_multipart_part','state','UPDATE')
      AND has_column_privilege($1,'platform.asset_multipart_part','expected_version','UPDATE')
      AND has_function_privilege($1,
        'platform.enqueue_asset_upload_completion_event(UUID,TEXT,JSONB,CHAR(64),TEXT,TEXT)',
        'EXECUTE') AS "assetDataPlaneAuthorityOk",
    has_any_column_privilege($1,'platform.outbox_event','SELECT') AS "canReadGenericOutbox",
    (has_any_column_privilege($1,'platform.asset_upload_intent','INSERT,UPDATE')
      OR has_table_privilege($1,'platform.asset_upload_intent','DELETE,TRUNCATE'))
      AS "canMutateAssetOwnerIntent"
  /* assetDataPlaneAuthority */`;

async function grantFoundationPrivileges(
  client: MigrationLockClient,
  apiRole: string,
  admissionRole: string,
  authorizationRole: string,
  workerRole: string,
  adminRole: string,
): Promise<void> {
  await client.query("REVOKE ALL ON SCHEMA platform FROM PUBLIC");
  for (const role of [apiRole, admissionRole, authorizationRole, workerRole, adminRole]) {
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
    await client.query(`REVOKE ALL ON TABLE ${PLATFORM_RUNTIME_TABLES} FROM ${identifier}`);
    await client.query(
      `REVOKE ALL ON FUNCTION platform.valid_credit_scope_policy(JSONB), platform.import_model_inventory(UUID, TEXT, TEXT, JSONB, JSONB, TEXT), platform.activate_model_inventory(UUID, TEXT, BIGINT, TEXT), platform.put_model_site_policy(UUID, TEXT, TEXT, TEXT, BIGINT), platform.resolve_model_candidates(TEXT, TEXT, TEXT), platform.find_model_selection_decision(UUID), platform.report_model_provider_availability(UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ, TEXT), platform.load_model_option_inventory(TEXT), platform.load_model_option_revisions(TEXT[]), platform.materialize_model_options(UUID, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT), platform.publish_site_release_model_catalog(UUID, JSONB, TEXT), platform.resolve_product_model_option_catalog(TEXT, TEXT), platform.resolve_admission_model_owner(TEXT, TEXT, TEXT) FROM ${identifier}`,
    );
    await client.query(
      `REVOKE ALL ON FUNCTION platform.bootstrap_admin_authorities(JSONB, CHAR(64)), platform.apply_admin_authority_change(UUID, JSONB) FROM ${identifier}`,
    );
    if (role === apiRole) {
      await client.query(
        `GRANT SELECT ON TABLE ${KERNEL_TABLES}, ${AUTHORIZATION_TABLES}, ${IDENTITY_TABLES}, ${COMMERCE_TABLES}, ${ASSET_API_TABLES}, platform.site, platform.site_release TO ${identifier}`,
      );
      await client.query(
        `GRANT SELECT(site_ref,subject_ref,subject_generation,project_ref,intent_ref,state,updated_at) ON TABLE platform.asset_blob_candidate TO ${identifier}`,
      );
      await client.query(
        `GRANT SELECT(site_ref,subject_ref,subject_generation,project_ref,intent_ref,state,updated_at) ON TABLE platform.asset_promotion_intent TO ${identifier}`,
      );
      await client.query(
        `GRANT SELECT(site_ref,intent_ref,rejection_ref) ON TABLE platform.asset_upload_rejection TO ${identifier}`,
      );
      await client.query(
        `GRANT SELECT(site_ref,subject_ref,subject_generation,project_ref,asset_ref,purpose,state) ON TABLE platform.asset_resource TO ${identifier}`,
      );
      await client.query(
        `GRANT SELECT(site_ref,asset_ref,asset_version_ref,source_upload_intent_ref,eligibility_epoch,detected_media_type,size,state) ON TABLE platform.asset_version TO ${identifier}`,
      );
      await client.query(
        `GRANT SELECT(site_ref,asset_version_ref,eligibility_ref,subject_ref,subject_generation,project_ref,purpose,eligibility_epoch,state) ON TABLE platform.asset_eligibility_projection TO ${identifier}`,
      );
      await client.query(
        `GRANT INSERT ON TABLE platform.command_receipt, platform.outbox_event, platform.inbox_delivery, platform.model_selection_decision, platform.authorization_product_context, platform.authorization_session_access_grant TO ${identifier}`,
      );
      await client.query(
        `GRANT UPDATE ON TABLE platform.command_receipt, platform.inbox_delivery, platform.authorization_product_context, platform.authorization_session_access_grant TO ${identifier}`,
      );
      await client.query(
        `GRANT SELECT, UPDATE ON TABLE platform.authorization_scoped_stream_state TO ${identifier}`,
      );
      await client.query(
        `GRANT SELECT, INSERT, UPDATE ON TABLE platform.authorization_scoped_site_cursor TO ${identifier}`,
      );
      await client.query(`GRANT INSERT ON TABLE platform.authorization_scoped_event_log TO ${identifier}`);
      await client.query(
        `GRANT INSERT ON TABLE platform.authorization_subject, platform.authorization_identity_session, platform.authorization_project, platform.authorization_project_membership, ${IDENTITY_TABLES}, platform.commerce_billing_account, platform.commerce_billing_account_membership TO ${identifier}`,
      );
      await client.query(
        `GRANT UPDATE ON TABLE platform.authorization_identity_session, ${IDENTITY_MUTABLE_TABLES} TO ${identifier}`,
      );
      await client.query(
        `GRANT INSERT ON TABLE platform.commerce_command, platform.commerce_subscription, platform.commerce_subscription_term, platform.commerce_subscription_term_revocation, platform.commerce_redemption, platform.commerce_redemption_preview, platform.commerce_redemption_legal_acceptance, platform.commerce_entitlement_grant, platform.commerce_entitlement_revocation, platform.credit_account, platform.credit_grant, platform.credit_program_window_acquisition, platform.credit_hold, platform.credit_hold_allocation, platform.credit_journal_transaction, platform.credit_journal_entry, platform.credit_execution_budget_root, platform.credit_budget_allocation, platform.credit_budget_allocation_revision, platform.credit_allocation_reservation_receipt, platform.credit_allocation_return_receipt, platform.credit_authorization_segment, platform.credit_budget_operation_receipt, platform.commerce_fulfillment_transaction, platform.commerce_fulfillment_output_plan, platform.commerce_fulfillment_actual_output, platform.commerce_command_outbox, platform.commerce_audit_entry TO ${identifier}`,
      );
      await client.query(
        `GRANT UPDATE ON TABLE platform.commerce_command, platform.commerce_subscription, platform.commerce_redeem_code, platform.commerce_redemption, platform.commerce_redemption_preview, platform.credit_account, platform.credit_hold, platform.credit_execution_budget_root, platform.credit_authorization_segment, platform.commerce_fulfillment_transaction TO ${identifier}`,
      );
      await client.query(
        `GRANT INSERT ON TABLE platform.asset_upload_intent, platform.asset_upload_session, platform.asset_quota_account, platform.asset_quota_reservation TO ${identifier}`,
      );
      await client.query(
        `GRANT UPDATE ON TABLE platform.asset_upload_intent, platform.asset_upload_session, platform.asset_quota_account, platform.asset_quota_reservation TO ${identifier}`,
      );
      await client.query(
        `GRANT EXECUTE ON FUNCTION platform.valid_credit_scope_policy(JSONB), platform.resolve_model_candidates(TEXT, TEXT, TEXT), platform.find_model_selection_decision(UUID), platform.resolve_product_model_option_catalog(TEXT, TEXT) TO ${identifier}`,
      );
    } else if (role === admissionRole) {
      await client.query(
        `GRANT SELECT ON TABLE ${ADMISSION_TABLES}, ${ADMISSION_RUNTIME_SNAPSHOT_TABLES}, platform.site, platform.site_release, platform.authorization_site, platform.authorization_site_release, platform.authorization_product_binding, platform.authorization_subject, platform.authorization_identity_session, platform.authorization_project, platform.authorization_project_membership, platform.authorization_session_access_grant, platform.identity_personal_bootstrap, platform.identity_execution_space, platform.identity_namespace_allocation_intent, platform.commerce_billing_account, platform.credit_account, platform.credit_grant, platform.credit_hold, platform.credit_hold_allocation, platform.credit_journal_transaction, platform.credit_journal_entry, platform.credit_execution_budget_root, platform.credit_budget_allocation, platform.credit_budget_allocation_revision, platform.credit_authorization_segment, platform.credit_budget_operation_receipt, platform.asset_resource, platform.asset_version, platform.asset_eligibility_projection TO ${identifier}`,
      );
      await client.query(
        `GRANT INSERT ON TABLE platform.admission_command, platform.admission_session_execution_binding, platform.admission_execution_manifest, platform.admission_capability_catalog_snapshot, platform.capability_projection_command, platform.outbox_event, platform.credit_hold, platform.credit_hold_allocation, platform.credit_journal_transaction, platform.credit_journal_entry, platform.credit_execution_budget_root, platform.credit_budget_allocation, platform.credit_budget_allocation_revision, platform.credit_authorization_segment, platform.credit_budget_operation_receipt TO ${identifier}`,
      );
      await client.query(
        `GRANT UPDATE ON TABLE platform.admission_command, platform.admission_execution_manifest, platform.credit_hold, platform.credit_execution_budget_root, platform.credit_authorization_segment TO ${identifier}`,
      );
      await client.query(
        `GRANT UPDATE(state,agent_catalog_ref,updated_at) ON TABLE platform.capability_projection_command TO ${identifier}`,
      );
      await client.query(
        `GRANT SELECT ON TABLE platform.credit_rating_policy_revision, platform.credit_rating_snapshot, platform.credit_usage_attempt_intent, platform.credit_attempt_usage_evidence, platform.credit_usage_segment_closure, platform.credit_usage_closure_evidence, platform.credit_usage_settlement, platform.credit_rated_usage, platform.credit_usage_settlement_source, platform.credit_usage_variance, platform.credit_usage_reconciliation, platform.credit_usage_command_receipt TO ${identifier}`,
      );
      await client.query(
        `GRANT INSERT ON TABLE platform.credit_rating_snapshot, platform.credit_usage_segment_closure, platform.credit_usage_closure_evidence, platform.credit_usage_settlement, platform.credit_rated_usage, platform.credit_usage_settlement_source, platform.credit_usage_variance, platform.credit_usage_reconciliation, platform.credit_usage_command_receipt TO ${identifier}`,
      );
      await client.query(
        `GRANT EXECUTE ON FUNCTION platform.valid_credit_scope_policy(JSONB), platform.resolve_admission_model_owner(TEXT, TEXT, TEXT) TO ${identifier}`,
      );
    } else if (role === authorizationRole) {
      await client.query(
        `GRANT SELECT ON TABLE platform.authorization_scoped_stream_state, platform.authorization_scoped_site_cursor, platform.authorization_scoped_event_log, platform.authorization_scoped_snapshot, platform.authorization_scoped_snapshot_record, platform.authorization_site, platform.authorization_subject, platform.authorization_identity_session, platform.authorization_project_membership, platform.authorization_session_access_grant TO ${identifier}`,
      );
      await client.query(
        `GRANT INSERT ON TABLE platform.authorization_scoped_snapshot, platform.authorization_scoped_snapshot_record TO ${identifier}`,
      );
    } else if (role === workerRole) {
      await client.query(
        `GRANT SELECT ON TABLE ${KERNEL_TABLES}, ${SITE_RECONCILIATION_TABLES}, platform.authorization_site, platform.authorization_site_release, platform.authorization_product_binding, platform.authorization_scoped_stream_state, platform.authorization_scoped_site_cursor, platform.authorization_scoped_event_log, platform.authorization_scoped_snapshot, platform.authorization_product_context, platform.authorization_session_access_grant, platform.commerce_redemption, platform.commerce_fulfillment_transaction, platform.credit_budget_operation_receipt, platform.credit_authorization_segment, platform.admin_operator_authority, platform.admin_operator_site_scope, platform.admin_operator_global_scope_grant, platform.admin_breakglass_grant, platform.admin_approval, platform.admin_post_effect_review TO ${identifier}`,
      );
      await client.query(
        `GRANT INSERT, UPDATE ON TABLE platform.authorization_scoped_site_cursor TO ${identifier}`,
      );
      await client.query(
        `GRANT UPDATE ON TABLE platform.authorization_scoped_stream_state TO ${identifier}`,
      );
      await client.query(`GRANT INSERT ON TABLE platform.authorization_scoped_event_log TO ${identifier}`);
      await client.query(`GRANT INSERT ON TABLE platform.inbox_delivery TO ${identifier}`);
      await client.query(
        `GRANT INSERT ON TABLE platform.site_deployment_binding, platform.site_deployment_observation, platform.site_traffic_stop_observation, platform.authorization_site, platform.authorization_site_release, platform.authorization_product_binding TO ${identifier}`,
      );
      await client.query(
        `GRANT UPDATE ON TABLE platform.command_receipt, platform.outbox_event, platform.inbox_delivery TO ${identifier}`,
      );
      await client.query(
        `GRANT UPDATE(state,active_release_ref,policy_epoch,revocation_epoch,tombstoned_at,updated_at) ON TABLE platform.site TO ${identifier}`,
      );
      await client.query(
        `GRANT UPDATE(state,updated_at) ON TABLE platform.site_release TO ${identifier}`,
      );
      await client.query(
        `GRANT UPDATE(state,updated_at) ON TABLE platform.site_deployment_binding TO ${identifier}`,
      );
      await client.query(
        `GRANT UPDATE(state,provider_operation_key,deployment_ref,observed_at,failure_code,updated_at) ON TABLE platform.site_activation_attempt TO ${identifier}`,
      );
      await client.query(
        `GRANT UPDATE(state,provider_operation_key,observed_at,failure_code,updated_at) ON TABLE platform.site_traffic_stop_attempt TO ${identifier}`,
      );
      await client.query(
        `GRANT UPDATE(state,security_epoch,policy_epoch,revocation_epoch,updated_at) ON TABLE platform.authorization_site TO ${identifier}`,
      );
      await client.query(
        `GRANT UPDATE(state,updated_at) ON TABLE platform.authorization_site_release TO ${identifier}`,
      );
      await client.query(
        `GRANT UPDATE(workload_identity_id,deployment_ref,release_ref,environment,region,audience,session_contract_revision,binding_epoch,state,updated_at) ON TABLE platform.authorization_product_binding TO ${identifier}`,
      );
      await client.query(
        `GRANT UPDATE ON TABLE platform.admin_approval, platform.admin_post_effect_review TO ${identifier}`,
      );
      await client.query(`GRANT SELECT ON TABLE ${ASSET_TABLES} TO ${identifier}`);
      await client.query(
        `GRANT INSERT ON TABLE platform.outbox_event, platform.asset_blob_candidate, platform.asset_cleanup_group, platform.asset_object_cleanup, platform.asset_object_cleanup_receipt, platform.asset_upload_rejection, platform.asset_scan_evaluation, platform.asset_promotion_intent, platform.asset_blob, platform.asset_resource, platform.asset_version, platform.asset_reference, platform.asset_eligibility_projection, platform.asset_promotion_receipt TO ${identifier}`,
      );
      await client.query(
        `GRANT UPDATE ON TABLE platform.asset_upload_intent, platform.asset_upload_session, platform.asset_quota_account, platform.asset_quota_reservation, platform.asset_blob_candidate, platform.asset_cleanup_group, platform.asset_object_cleanup, platform.asset_promotion_intent TO ${identifier}`,
      );
      await client.query(
        `GRANT SELECT, DELETE ON TABLE platform.authorization_scoped_event_log, platform.authorization_scoped_snapshot TO ${identifier}`,
      );
      await client.query(
        `GRANT EXECUTE ON FUNCTION platform.report_model_provider_availability(UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ, TEXT) TO ${identifier}`,
      );
      await client.query(
        `GRANT EXECUTE ON FUNCTION platform.apply_admin_authority_change(UUID, JSONB) TO ${identifier}`,
      );
    } else {
      await client.query(
        `GRANT SELECT ON TABLE platform.command_receipt, platform.outbox_event, ${ADMISSION_RUNTIME_SNAPSHOT_TABLES}, ${AUTHORIZATION_TABLES}, ${SITE_TABLES} TO ${identifier}`,
      );
      await client.query(
        `GRANT INSERT ON TABLE platform.command_receipt, platform.outbox_event TO ${identifier}`,
      );
      await client.query(`GRANT UPDATE ON TABLE platform.command_receipt TO ${identifier}`);
      await client.query(
        `GRANT INSERT ON TABLE platform.site, platform.site_project_binding, platform.site_release, platform.site_activation_attempt, platform.site_traffic_stop_attempt, platform.site_effect_approval TO ${identifier}`,
      );
      await client.query(
        `GRANT INSERT ON TABLE ${ADMISSION_RUNTIME_SNAPSHOT_TABLES} TO ${identifier}`,
      );
      await client.query(
        `GRANT UPDATE(state,active_release_ref,security_epoch,policy_epoch,revocation_epoch,runtime_binding_epoch,tombstoned_at,updated_at) ON TABLE platform.site TO ${identifier}`,
      );
      await client.query(
        `GRANT UPDATE(state,binding_epoch,updated_at) ON TABLE platform.site_project_binding TO ${identifier}`,
      );
      await client.query(
        `GRANT UPDATE(state,updated_at) ON TABLE platform.site_release TO ${identifier}`,
      );
      await client.query(
        `GRANT UPDATE(state,updated_at) ON TABLE platform.site_deployment_binding TO ${identifier}`,
      );
      await client.query(
        `GRANT UPDATE(state,checker_subject_ref,decided_at,consumed_request_id,consumed_at,updated_at) ON TABLE platform.site_effect_approval TO ${identifier}`,
      );
      await client.query(
        `GRANT UPDATE(state,security_epoch,revocation_epoch,updated_at) ON TABLE platform.authorization_site TO ${identifier}`,
      );
      await client.query(
        `GRANT SELECT, UPDATE ON TABLE platform.authorization_scoped_stream_state TO ${identifier}`,
      );
      await client.query(
        `GRANT SELECT, INSERT, UPDATE ON TABLE platform.authorization_scoped_site_cursor TO ${identifier}`,
      );
      await client.query(`GRANT INSERT ON TABLE platform.authorization_scoped_event_log TO ${identifier}`);
      await client.query(
        `GRANT UPDATE(state,updated_at) ON TABLE platform.authorization_product_binding TO ${identifier}`,
      );
      await client.query(`GRANT SELECT ON TABLE ${COMMERCE_TABLES} TO ${identifier}`);
      await client.query(
        `GRANT INSERT, UPDATE ON TABLE platform.commerce_billing_account, platform.commerce_billing_account_membership TO ${identifier}`,
      );
      await client.query(`GRANT SELECT ON TABLE ${ADMIN_TABLES} TO ${identifier}`);
      await client.query(`GRANT SELECT ON TABLE ${ASSET_TABLES} TO ${identifier}`);
      await client.query(
        `GRANT INSERT ON TABLE platform.admin_command_decision, platform.admin_approval, platform.admin_approval_decision, platform.admin_post_effect_review, platform.admin_oidc_transaction, platform.admin_operator_session, platform.admin_step_up_transaction TO ${identifier}`,
      );
      await client.query(
        `GRANT UPDATE ON TABLE platform.admin_approval, platform.admin_post_effect_review, platform.admin_oidc_transaction, platform.admin_operator_session, platform.admin_step_up_transaction TO ${identifier}`,
      );
      await client.query(
        `GRANT INSERT ON TABLE platform.commerce_command, platform.commerce_catalog_product, platform.commerce_catalog_plan, platform.commerce_catalog_plan_version, platform.commerce_fulfillment_program_revision, platform.commerce_fulfillment_program_output, platform.commerce_catalog_product_version, platform.commerce_redemption_program_revision, platform.commerce_redemption_program_availability, platform.commerce_code_batch, platform.commerce_redeem_code, platform.commerce_code_batch_approval, platform.commerce_code_secret_export, platform.commerce_audit_entry TO ${identifier}`,
      );
      await client.query(
        `GRANT UPDATE ON TABLE platform.commerce_catalog_epoch_authority, platform.commerce_catalog_product, platform.commerce_catalog_plan, platform.commerce_code_batch, platform.commerce_redemption_program_availability TO ${identifier}`,
      );
      await client.query(
        `GRANT EXECUTE ON FUNCTION platform.import_model_inventory(UUID, TEXT, TEXT, JSONB, JSONB, TEXT), platform.activate_model_inventory(UUID, TEXT, BIGINT, TEXT), platform.put_model_site_policy(UUID, TEXT, TEXT, TEXT, BIGINT), platform.load_model_option_inventory(TEXT), platform.load_model_option_revisions(TEXT[]), platform.materialize_model_options(UUID, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT), platform.publish_site_release_model_catalog(UUID, JSONB, TEXT) TO ${identifier}`,
      );
      await client.query(
        `GRANT EXECUTE ON FUNCTION platform.valid_credit_scope_policy(JSONB) TO ${identifier}`,
      );
    }
  }
}

const KERNEL_TABLES = [
  "platform.command_receipt",
  "platform.outbox_event",
  "platform.inbox_delivery",
].join(", ");

const ADMISSION_TABLES = [
  "platform.admission_command",
  "platform.capability_projection_command",
  "platform.admission_session_execution_binding",
  "platform.admission_execution_manifest",
].join(", ");

const ADMISSION_RUNTIME_SNAPSHOT_TABLES = [
  "platform.admission_launch_profile_snapshot",
  "platform.admission_capability_catalog_snapshot",
].join(", ");

const AUTHORIZATION_TABLES = [
  "platform.authorization_site",
  "platform.authorization_site_release",
  "platform.authorization_product_binding",
  "platform.authorization_subject",
  "platform.authorization_identity_session",
  "platform.authorization_project",
  "platform.authorization_project_membership",
  "platform.authorization_product_context",
  "platform.authorization_session_access_grant",
].join(", ");

const COMMERCE_TABLES = [
  "platform.commerce_command",
  "platform.commerce_catalog_epoch_authority",
  "platform.commerce_billing_account",
  "platform.commerce_billing_account_membership",
  "platform.commerce_catalog_product",
  "platform.commerce_catalog_plan",
  "platform.commerce_catalog_plan_version",
  "platform.commerce_credit_program_revision",
  "platform.commerce_entitlement_template_revision",
  "platform.commerce_fulfillment_program_revision",
  "platform.commerce_fulfillment_program_output",
  "platform.commerce_catalog_product_version",
  "platform.commerce_redemption_program_revision",
  "platform.commerce_redemption_program_availability",
  "platform.commerce_subscription",
  "platform.commerce_subscription_term",
  "platform.commerce_subscription_term_revocation",
  "platform.commerce_code_batch",
  "platform.commerce_redeem_code",
  "platform.commerce_code_batch_approval",
  "platform.commerce_code_secret_export",
  "platform.commerce_redemption",
  "platform.commerce_redemption_preview",
  "platform.commerce_redemption_legal_acceptance",
  "platform.commerce_entitlement_grant",
  "platform.commerce_entitlement_revocation",
  "platform.credit_account",
  "platform.credit_grant",
  "platform.credit_program_window_acquisition",
  "platform.credit_hold",
  "platform.credit_hold_allocation",
  "platform.credit_journal_transaction",
  "platform.credit_journal_entry",
  "platform.credit_execution_budget_root",
  "platform.credit_budget_allocation",
  "platform.credit_budget_allocation_revision",
  "platform.credit_allocation_reservation_receipt",
  "platform.credit_allocation_return_receipt",
  "platform.credit_authorization_segment",
  "platform.credit_budget_operation_receipt",
  "platform.commerce_fulfillment_transaction",
  "platform.commerce_fulfillment_output_plan",
  "platform.commerce_fulfillment_actual_output",
  "platform.commerce_command_outbox",
  "platform.commerce_audit_entry",
].join(", ");

const ASSET_RELATIONS = [
  "asset_upload_intent",
  "asset_upload_session",
  "asset_quota_account",
  "asset_quota_reservation",
  "asset_multipart_upload",
  "asset_multipart_part",
  "asset_blob_candidate",
  "asset_cleanup_group",
  "asset_object_cleanup",
  "asset_object_cleanup_receipt",
  "asset_upload_rejection",
  "asset_scan_evaluation",
  "asset_promotion_intent",
  "asset_blob",
  "asset_resource",
  "asset_version",
  "asset_reference",
  "asset_eligibility_projection",
  "asset_promotion_receipt",
] as const;
const ASSET_API_MUTABLE_RELATIONS = [
  "asset_upload_intent",
  "asset_upload_session",
  "asset_quota_account",
  "asset_quota_reservation",
] as const;
const ASSET_API_OWNER_READ_RELATIONS = [
  "asset_blob_candidate",
  "asset_upload_rejection",
  "asset_promotion_intent",
  "asset_resource",
  "asset_version",
  "asset_eligibility_projection",
] as const;
const ASSET_API_RELATIONS = [
  ...ASSET_API_MUTABLE_RELATIONS,
  ...ASSET_API_OWNER_READ_RELATIONS,
] as const;
const ASSET_WORKER_INSERT_RELATIONS = ASSET_RELATIONS.slice(6);
const ASSET_WORKER_UPDATE_RELATIONS = [
  "asset_upload_intent",
  "asset_upload_session",
  "asset_quota_account",
  "asset_quota_reservation",
  "asset_blob_candidate",
  "asset_cleanup_group",
  "asset_object_cleanup",
  "asset_promotion_intent",
] as const;
const ADMISSION_RELATIONS = [
  "admission_command",
  "capability_projection_command",
  "admission_session_execution_binding",
  "admission_execution_manifest",
  "admission_launch_profile_snapshot",
  "admission_capability_catalog_snapshot",
] as const;
const CREDIT_USAGE_RELATIONS = [
  "credit_rating_policy_revision",
  "credit_rating_snapshot",
  "credit_usage_attempt_intent",
  "credit_attempt_usage_evidence",
  "credit_usage_segment_closure",
  "credit_usage_closure_evidence",
  "credit_usage_settlement",
  "credit_rated_usage",
  "credit_usage_settlement_source",
  "credit_usage_variance",
  "credit_usage_reconciliation",
  "credit_usage_command_receipt",
] as const;
const MODEL_GATEWAY_ADMISSION_RELATIONS = [
  "model_gateway_execution_authorization",
] as const;
const ADMISSION_SELECT_RELATIONS = [
  ...ADMISSION_RELATIONS,
  ...CREDIT_USAGE_RELATIONS,
  ...MODEL_GATEWAY_ADMISSION_RELATIONS,
  "site",
  "site_release",
  "authorization_site",
  "authorization_site_release",
  "authorization_product_binding",
  "authorization_subject",
  "authorization_identity_session",
  "authorization_project",
  "authorization_project_membership",
  "authorization_session_access_grant",
  "identity_personal_bootstrap",
  "identity_execution_space",
  "identity_namespace_allocation_intent",
  "commerce_billing_account",
  "credit_account",
  "credit_grant",
  "credit_hold",
  "credit_hold_allocation",
  "credit_journal_transaction",
  "credit_journal_entry",
  "credit_execution_budget_root",
  "credit_budget_allocation",
  "credit_budget_allocation_revision",
  "credit_authorization_segment",
  "credit_budget_operation_receipt",
  "asset_resource",
  "asset_version",
  "asset_eligibility_projection",
] as const;
const ADMISSION_INSERT_RELATIONS = [
  "admission_command",
  "capability_projection_command",
  "admission_session_execution_binding",
  "admission_execution_manifest",
  "admission_capability_catalog_snapshot",
  "outbox_event",
  "credit_hold",
  "credit_hold_allocation",
  "credit_journal_transaction",
  "credit_journal_entry",
  "credit_execution_budget_root",
  "credit_budget_allocation",
  "credit_budget_allocation_revision",
  "credit_authorization_segment",
  "credit_budget_operation_receipt",
  "credit_rating_snapshot",
  "credit_usage_segment_closure",
  "credit_usage_closure_evidence",
  "credit_usage_settlement",
  "credit_rated_usage",
  "credit_usage_settlement_source",
  "credit_usage_variance",
  "credit_usage_reconciliation",
  "credit_usage_command_receipt",
  "model_gateway_execution_authorization",
] as const;
const ADMISSION_UPDATE_RELATIONS = [
  "admission_command",
  "capability_projection_command",
  "admission_execution_manifest",
  "credit_hold",
  "credit_execution_budget_root",
  "credit_authorization_segment",
  "model_gateway_execution_authorization",
] as const;
const ASSET_TABLES = ASSET_RELATIONS.map((name) => `platform.${name}`).join(", ");
const ASSET_API_TABLES = ASSET_API_MUTABLE_RELATIONS.map((name) => `platform.${name}`).join(", ");
const ASSET_RELATIONS_SQL = sqlLiterals(ASSET_RELATIONS);
const ASSET_API_RELATIONS_SQL = sqlLiterals(ASSET_API_RELATIONS);
const ASSET_API_MUTABLE_RELATIONS_SQL = sqlLiterals(ASSET_API_MUTABLE_RELATIONS);
const ASSET_API_OWNER_READ_RELATIONS_SQL = sqlLiterals(ASSET_API_OWNER_READ_RELATIONS);
const ASSET_API_OWNER_READ_COLUMN_ALLOWLIST_SQL = `
  (candidate.relname='asset_blob_candidate' AND candidate_column.attname=ANY(ARRAY[
    'site_ref','subject_ref','subject_generation','project_ref','intent_ref','state','updated_at'
  ])) OR
  (candidate.relname='asset_promotion_intent' AND candidate_column.attname=ANY(ARRAY[
    'site_ref','subject_ref','subject_generation','project_ref','intent_ref','state','updated_at'
  ])) OR
  (candidate.relname='asset_upload_rejection' AND candidate_column.attname=ANY(ARRAY[
    'site_ref','intent_ref','rejection_ref'
  ])) OR
  (candidate.relname='asset_resource' AND candidate_column.attname=ANY(ARRAY[
    'site_ref','subject_ref','subject_generation','project_ref','asset_ref','purpose','state'
  ])) OR
  (candidate.relname='asset_version' AND candidate_column.attname=ANY(ARRAY[
    'site_ref','asset_ref','asset_version_ref','source_upload_intent_ref','eligibility_epoch',
    'detected_media_type','size','state'
  ])) OR
  (candidate.relname='asset_eligibility_projection' AND candidate_column.attname=ANY(ARRAY[
    'site_ref','asset_version_ref','eligibility_ref','subject_ref','subject_generation','project_ref',
    'purpose','eligibility_epoch','state'
  ]))`;
const ASSET_WORKER_INSERT_RELATIONS_SQL = sqlLiterals(ASSET_WORKER_INSERT_RELATIONS);
const ASSET_WORKER_UPDATE_RELATIONS_SQL = sqlLiterals(ASSET_WORKER_UPDATE_RELATIONS);
const ADMISSION_RELATIONS_SQL = sqlLiterals(ADMISSION_RELATIONS);
const ADMISSION_SELECT_RELATIONS_SQL = sqlLiterals(ADMISSION_SELECT_RELATIONS);
const ADMISSION_INSERT_RELATIONS_SQL = sqlLiterals(ADMISSION_INSERT_RELATIONS);
const ADMISSION_UPDATE_RELATIONS_SQL = sqlLiterals(ADMISSION_UPDATE_RELATIONS);
const CREDIT_USAGE_RELATIONS_SQL = sqlLiterals(CREDIT_USAGE_RELATIONS);
const MODEL_GATEWAY_ADMISSION_RELATIONS_SQL = sqlLiterals(MODEL_GATEWAY_ADMISSION_RELATIONS);

const SITE_TABLES = [
  "platform.site",
  "platform.site_project_binding",
  "platform.site_release",
  "platform.site_deployment_binding",
  "platform.site_activation_attempt",
  "platform.site_deployment_observation",
  "platform.site_traffic_stop_attempt",
  "platform.site_traffic_stop_observation",
  "platform.site_effect_approval",
].join(", ");

const SITE_RECONCILIATION_TABLES = [
  "platform.site",
  "platform.site_project_binding",
  "platform.site_release",
  "platform.site_deployment_binding",
  "platform.site_activation_attempt",
  "platform.site_deployment_observation",
  "platform.site_traffic_stop_attempt",
  "platform.site_traffic_stop_observation",
].join(", ");

const ADMIN_TABLES = [
  "platform.admin_operator_authority",
  "platform.admin_operator_site_scope",
  "platform.admin_operator_global_scope_grant",
  "platform.admin_breakglass_grant",
  "platform.admin_operator_identity",
  "platform.admin_oidc_transaction",
  "platform.admin_operator_session",
  "platform.admin_step_up_transaction",
  "platform.admin_command_decision",
  "platform.admin_approval",
  "platform.admin_approval_decision",
  "platform.admin_authority_bootstrap",
  "platform.admin_post_effect_review",
].join(", ");

const IDENTITY_TABLES = [
  "platform.identity_account",
  "platform.identity_password_credential",
  "platform.identity_login_identifier",
  "platform.identity_verification_transaction",
  "platform.identity_verification_legal_acceptance",
  "platform.identity_verification_delivery",
  "platform.identity_totp_authenticator",
  "platform.identity_recovery_code_set",
  "platform.identity_recovery_code",
  "platform.identity_auth_rate_limit",
  "platform.identity_auth_transaction",
  "platform.identity_reauthentication_challenge",
  "platform.identity_totp_enrollment_transaction",
  "platform.identity_totp_enrollment_delivery_claim",
  "platform.identity_reauthentication_proof",
  "platform.identity_reauthentication_delivery_claim",
  "platform.identity_recovery_code_delivery_claim",
  "platform.identity_security_event",
  "platform.identity_refresh_family",
  "platform.identity_refresh_credential",
  "platform.identity_session_delivery_claim",
  "platform.identity_receipt_recovery_capability",
  "platform.identity_personal_workspace",
  "platform.identity_workspace_membership",
  "platform.identity_execution_space",
  "platform.identity_namespace_allocation_intent",
  "platform.identity_personal_bootstrap",
].join(", ");

const IDENTITY_MUTABLE_TABLES = [
  "platform.identity_account",
  "platform.identity_password_credential",
  "platform.identity_login_identifier",
  "platform.identity_verification_transaction",
  "platform.identity_verification_delivery",
  "platform.identity_totp_authenticator",
  "platform.identity_recovery_code_set",
  "platform.identity_recovery_code",
  "platform.identity_auth_rate_limit",
  "platform.identity_auth_transaction",
  "platform.identity_reauthentication_challenge",
  "platform.identity_totp_enrollment_transaction",
  "platform.identity_totp_enrollment_delivery_claim",
  "platform.identity_reauthentication_proof",
  "platform.identity_reauthentication_delivery_claim",
  "platform.identity_recovery_code_delivery_claim",
  "platform.identity_refresh_family",
  "platform.identity_refresh_credential",
  "platform.identity_session_delivery_claim",
  "platform.identity_receipt_recovery_capability",
  "platform.identity_execution_space",
  "platform.identity_namespace_allocation_intent",
].join(", ");

const PLATFORM_RUNTIME_TABLES = [
  "platform.command_receipt",
  "platform.outbox_event",
  "platform.inbox_delivery",
  ADMISSION_TABLES,
  ADMISSION_RUNTIME_SNAPSHOT_TABLES,
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
  "platform.model_option_materialization",
  "platform.model_option_revision",
  "platform.model_option_materialized_revision",
  "platform.model_option_role_binding",
  "platform.site_release_model_catalog_publication",
  "platform.site_release_model_catalog_surface",
  "platform.site_release_model_catalog_option",
  SITE_TABLES,
  AUTHORIZATION_TABLES,
  IDENTITY_TABLES,
  "platform.authorization_scoped_stream_state",
  "platform.authorization_scoped_site_cursor",
  "platform.authorization_scoped_event_log",
  "platform.authorization_scoped_snapshot",
  "platform.authorization_scoped_snapshot_record",
  COMMERCE_TABLES,
  ADMIN_TABLES,
  ASSET_TABLES,
].join(", ");

async function assertPostMigrationAuthority(
  client: MigrationLockClient,
  migratorRole: string,
  apiRole: string,
  admissionRole: string,
  authorizationRole: string,
  workerRole: string,
  adminRole: string,
): Promise<void> {
  const result = await client.query(POST_MIGRATION_AUTHORITY_SQL, [
    apiRole,
    authorizationRole,
    workerRole,
    adminRole,
    admissionRole,
  ]);
  const invalidRows = result.rows?.filter(
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
      row.canExecuteCreditScopePolicy !==
        (row.roleName === apiRole || row.roleName === admissionRole || row.roleName === adminRole) ||
      row.canExecuteAdminAuthorityChange !== (row.roleName === workerRole) ||
      row.hasRequiredModelOptionFunctions !== true ||
      row.canSelectModelCatalogTable !== false ||
      row.canReadModelSensitiveColumn !== false ||
      row.hasUnexpectedPlatformPrivilege !== false,
  ) ?? [];
  if (
    result.rows?.length !== 5 ||
    invalidRows.length > 0
  ) {
    throw new Error(
      `PLATFORM_POST_MIGRATION_AUTHORITY_INVALID:${JSON.stringify(invalidRows)}`,
    );
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
           (has_table_privilege(runtime_role.rolname, 'platform.command_receipt', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.command_receipt', 'UPDATE'))
           AND has_table_privilege(runtime_role.rolname, 'platform.outbox_event', 'INSERT')
           AND (has_table_privilege(runtime_role.rolname, 'platform.inbox_delivery', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.inbox_delivery', 'UPDATE'))
           AND has_table_privilege(runtime_role.rolname, 'platform.model_selection_decision', 'INSERT')
           AND (has_table_privilege(runtime_role.rolname, 'platform.authorization_subject', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.authorization_subject', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.authorization_identity_session', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.authorization_identity_session', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.authorization_identity_session', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.authorization_project', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.authorization_project', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.authorization_project_membership', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.authorization_project_membership', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.authorization_product_context', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.authorization_product_context', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.authorization_product_context', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.authorization_session_access_grant', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.authorization_session_access_grant', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.authorization_session_access_grant', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_stream_state', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_stream_state', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_site_cursor', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_site_cursor', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_site_cursor', 'UPDATE'))
           AND has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_event_log', 'INSERT')
           AND (has_table_privilege(runtime_role.rolname, 'platform.identity_account', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_account', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_account', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.identity_verification_transaction', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_verification_transaction', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_verification_transaction', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.identity_auth_transaction', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_auth_transaction', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_auth_transaction', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.identity_reauthentication_challenge', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_reauthentication_challenge', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_reauthentication_challenge', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.identity_totp_authenticator', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_totp_authenticator', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_totp_authenticator', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.identity_recovery_code_set', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_recovery_code_set', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_recovery_code_set', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.identity_recovery_code', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_recovery_code', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_recovery_code', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.identity_auth_rate_limit', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_auth_rate_limit', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_auth_rate_limit', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.identity_totp_enrollment_transaction', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_totp_enrollment_transaction', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_totp_enrollment_transaction', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.identity_totp_enrollment_delivery_claim', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_totp_enrollment_delivery_claim', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_totp_enrollment_delivery_claim', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.identity_reauthentication_proof', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_reauthentication_proof', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_reauthentication_proof', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.identity_reauthentication_delivery_claim', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_reauthentication_delivery_claim', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_reauthentication_delivery_claim', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.identity_recovery_code_delivery_claim', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_recovery_code_delivery_claim', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_recovery_code_delivery_claim', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.identity_security_event', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_security_event', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.identity_refresh_family', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_refresh_family', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_refresh_family', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.identity_session_delivery_claim', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_session_delivery_claim', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_session_delivery_claim', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.identity_personal_bootstrap', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.identity_personal_bootstrap', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.commerce_command', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.commerce_command', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.commerce_command', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.commerce_billing_account', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.commerce_billing_account', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.commerce_billing_account_membership', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.commerce_billing_account_membership', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.commerce_subscription', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.commerce_subscription', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.commerce_subscription', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.commerce_subscription_term', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.commerce_subscription_term', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.commerce_subscription_term_revocation', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.commerce_subscription_term_revocation', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.commerce_redeem_code', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.commerce_redeem_code', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.commerce_redemption', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.commerce_redemption', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.commerce_redemption', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.commerce_redemption_preview', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.commerce_redemption_preview', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.commerce_redemption_preview', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.commerce_redemption_legal_acceptance', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.commerce_redemption_legal_acceptance', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.commerce_entitlement_grant', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.commerce_entitlement_grant', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.commerce_entitlement_revocation', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.commerce_entitlement_revocation', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.credit_account', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_account', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_account', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.credit_grant', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_grant', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.credit_program_window_acquisition', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_program_window_acquisition', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.credit_hold', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_hold', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_hold', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.credit_hold_allocation', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_hold_allocation', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.credit_journal_transaction', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_journal_transaction', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.credit_journal_entry', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_journal_entry', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.credit_execution_budget_root', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_execution_budget_root', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_execution_budget_root', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.credit_budget_allocation', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_budget_allocation', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.credit_budget_allocation_revision', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_budget_allocation_revision', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.credit_allocation_reservation_receipt', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_allocation_reservation_receipt', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.credit_allocation_return_receipt', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_allocation_return_receipt', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.credit_authorization_segment', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_authorization_segment', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_authorization_segment', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.credit_budget_operation_receipt', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_budget_operation_receipt', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.commerce_fulfillment_transaction', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.commerce_fulfillment_transaction', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.commerce_fulfillment_transaction', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.commerce_fulfillment_output_plan', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.commerce_fulfillment_output_plan', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.commerce_fulfillment_actual_output', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.commerce_fulfillment_actual_output', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.commerce_command_outbox', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.commerce_command_outbox', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.commerce_audit_entry', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.commerce_audit_entry', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.asset_upload_intent', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_upload_intent', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_upload_intent', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.asset_upload_session', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_upload_session', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_upload_session', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.asset_quota_account', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_quota_account', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_quota_account', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.asset_quota_reservation', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_quota_reservation', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_quota_reservation', 'UPDATE'))
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_blob_candidate', 'site_ref', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_blob_candidate', 'subject_ref', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_blob_candidate', 'subject_generation', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_blob_candidate', 'project_ref', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_blob_candidate', 'intent_ref', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_blob_candidate', 'state', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_blob_candidate', 'updated_at', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_promotion_intent', 'site_ref', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_promotion_intent', 'subject_ref', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_promotion_intent', 'subject_generation', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_promotion_intent', 'project_ref', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_promotion_intent', 'intent_ref', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_promotion_intent', 'state', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_promotion_intent', 'updated_at', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_upload_rejection', 'site_ref', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_upload_rejection', 'intent_ref', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_upload_rejection', 'rejection_ref', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_resource', 'site_ref', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_resource', 'subject_ref', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_resource', 'subject_generation', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_resource', 'project_ref', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_resource', 'asset_ref', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_resource', 'purpose', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_resource', 'state', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_version', 'site_ref', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_version', 'asset_ref', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_version', 'asset_version_ref', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_version', 'source_upload_intent_ref', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_version', 'eligibility_epoch', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_version', 'detected_media_type', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_version', 'size', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_version', 'state', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_eligibility_projection', 'site_ref', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_eligibility_projection', 'asset_version_ref', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_eligibility_projection', 'eligibility_ref', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_eligibility_projection', 'subject_ref', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_eligibility_projection', 'subject_generation', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_eligibility_projection', 'project_ref', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_eligibility_projection', 'purpose', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_eligibility_projection', 'eligibility_epoch', 'SELECT')
           AND has_column_privilege(runtime_role.rolname, 'platform.asset_eligibility_projection', 'state', 'SELECT')
         WHEN runtime_role.rolname = $5 THEN
           (has_table_privilege(runtime_role.rolname, 'platform.admission_command', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.admission_command', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.admission_command', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.capability_projection_command', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.capability_projection_command', 'INSERT'))
           AND has_column_privilege(runtime_role.rolname, 'platform.capability_projection_command', 'state', 'UPDATE')
           AND has_column_privilege(runtime_role.rolname, 'platform.capability_projection_command', 'agent_catalog_ref', 'UPDATE')
           AND has_column_privilege(runtime_role.rolname, 'platform.capability_projection_command', 'updated_at', 'UPDATE')
           AND (has_table_privilege(runtime_role.rolname, 'platform.admission_session_execution_binding', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.admission_session_execution_binding', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.admission_execution_manifest', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.admission_execution_manifest', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.admission_execution_manifest', 'UPDATE'))
           AND has_table_privilege(runtime_role.rolname, 'platform.admission_launch_profile_snapshot', 'SELECT')
           AND (has_table_privilege(runtime_role.rolname, 'platform.admission_capability_catalog_snapshot', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.admission_capability_catalog_snapshot', 'INSERT'))
           AND has_table_privilege(runtime_role.rolname, 'platform.outbox_event', 'INSERT')
           AND has_table_privilege(runtime_role.rolname, 'platform.site', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.site_release', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.authorization_site', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.authorization_site_release', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.authorization_product_binding', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.authorization_subject', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.authorization_identity_session', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.authorization_project', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.authorization_project_membership', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.authorization_session_access_grant', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.identity_personal_bootstrap', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.identity_execution_space', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.identity_namespace_allocation_intent', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.commerce_billing_account', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.credit_account', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.credit_grant', 'SELECT')
           AND (has_table_privilege(runtime_role.rolname, 'platform.credit_hold', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_hold', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_hold', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.credit_hold_allocation', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_hold_allocation', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.credit_journal_transaction', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_journal_transaction', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.credit_journal_entry', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_journal_entry', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.credit_execution_budget_root', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_execution_budget_root', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_execution_budget_root', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.credit_budget_allocation', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_budget_allocation', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.credit_budget_allocation_revision', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_budget_allocation_revision', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.credit_authorization_segment', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_authorization_segment', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_authorization_segment', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.credit_budget_operation_receipt', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.credit_budget_operation_receipt', 'INSERT'))
           AND has_table_privilege(runtime_role.rolname, 'platform.asset_resource', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.asset_version', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.asset_eligibility_projection', 'SELECT')
         WHEN runtime_role.rolname = $3 THEN
           (has_table_privilege(runtime_role.rolname, 'platform.outbox_event', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.outbox_event', 'UPDATE'))
           AND has_table_privilege(runtime_role.rolname, 'platform.command_receipt', 'UPDATE')
           AND (has_table_privilege(runtime_role.rolname, 'platform.inbox_delivery', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.inbox_delivery', 'UPDATE'))
           AND has_table_privilege(runtime_role.rolname, 'platform.commerce_redemption', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.commerce_fulfillment_transaction', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.credit_budget_operation_receipt', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.credit_authorization_segment', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.site', 'SELECT')
           AND has_any_column_privilege(runtime_role.rolname, 'platform.site', 'UPDATE')
           AND has_table_privilege(runtime_role.rolname, 'platform.site_project_binding', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.site_release', 'SELECT')
           AND has_any_column_privilege(runtime_role.rolname, 'platform.site_release', 'UPDATE')
           AND (has_table_privilege(runtime_role.rolname, 'platform.site_deployment_binding', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.site_deployment_binding', 'INSERT'))
           AND has_any_column_privilege(runtime_role.rolname, 'platform.site_deployment_binding', 'UPDATE')
           AND has_table_privilege(runtime_role.rolname, 'platform.site_activation_attempt', 'SELECT')
           AND has_any_column_privilege(runtime_role.rolname, 'platform.site_activation_attempt', 'UPDATE')
           AND (has_table_privilege(runtime_role.rolname, 'platform.site_deployment_observation', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.site_deployment_observation', 'INSERT'))
           AND has_table_privilege(runtime_role.rolname, 'platform.site_traffic_stop_attempt', 'SELECT')
           AND has_any_column_privilege(runtime_role.rolname, 'platform.site_traffic_stop_attempt', 'UPDATE')
           AND (has_table_privilege(runtime_role.rolname, 'platform.site_traffic_stop_observation', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.site_traffic_stop_observation', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.authorization_site', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.authorization_site', 'INSERT'))
           AND has_any_column_privilege(runtime_role.rolname, 'platform.authorization_site', 'UPDATE')
           AND (has_table_privilege(runtime_role.rolname, 'platform.authorization_site_release', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.authorization_site_release', 'INSERT'))
           AND has_any_column_privilege(runtime_role.rolname, 'platform.authorization_site_release', 'UPDATE')
           AND (has_table_privilege(runtime_role.rolname, 'platform.authorization_product_binding', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.authorization_product_binding', 'INSERT'))
           AND has_any_column_privilege(runtime_role.rolname, 'platform.authorization_product_binding', 'UPDATE')
           AND has_table_privilege(runtime_role.rolname, 'platform.authorization_session_access_grant', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.admin_operator_authority', 'SELECT')
           AND (has_table_privilege(runtime_role.rolname, 'platform.admin_approval', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.admin_approval', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.admin_post_effect_review', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.admin_post_effect_review', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.asset_upload_intent', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_upload_intent', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.asset_upload_session', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_upload_session', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.asset_quota_account', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_quota_account', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.asset_quota_reservation', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_quota_reservation', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.asset_blob_candidate', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_blob_candidate', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_blob_candidate', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.asset_cleanup_group', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_cleanup_group', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_cleanup_group', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.asset_object_cleanup', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_object_cleanup', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_object_cleanup', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.asset_object_cleanup_receipt', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_object_cleanup_receipt', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.asset_upload_rejection', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_upload_rejection', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.asset_scan_evaluation', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_scan_evaluation', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.asset_promotion_intent', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_promotion_intent', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_promotion_intent', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.asset_blob', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_blob', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.asset_resource', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_resource', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.asset_version', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_version', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.asset_reference', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_reference', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.asset_eligibility_projection', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_eligibility_projection', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.asset_promotion_receipt', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.asset_promotion_receipt', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_stream_state', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_stream_state', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_site_cursor', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_site_cursor', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_site_cursor', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_event_log', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_event_log', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_event_log', 'DELETE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_snapshot', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_snapshot', 'DELETE'))
         WHEN runtime_role.rolname = $2 THEN
           has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_stream_state', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_site_cursor', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_event_log', 'SELECT')
           AND (has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_snapshot', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_snapshot', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_snapshot_record', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_snapshot_record', 'INSERT'))
           AND has_table_privilege(runtime_role.rolname, 'platform.authorization_site', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.authorization_subject', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.authorization_identity_session', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.authorization_project_membership', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.authorization_session_access_grant', 'SELECT')
         ELSE (has_table_privilege(runtime_role.rolname, 'platform.command_receipt', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.command_receipt', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.command_receipt', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.outbox_event', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.outbox_event', 'INSERT'))
           AND has_table_privilege(runtime_role.rolname, 'platform.authorization_site', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.authorization_subject', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.authorization_product_binding', 'SELECT')
           AND (has_table_privilege(runtime_role.rolname, 'platform.commerce_billing_account', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.commerce_billing_account', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.commerce_billing_account', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.commerce_billing_account_membership', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.commerce_billing_account_membership', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.commerce_billing_account_membership', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.site', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.site', 'INSERT'))
           AND has_any_column_privilege(runtime_role.rolname, 'platform.site', 'UPDATE')
           AND (has_table_privilege(runtime_role.rolname, 'platform.site_project_binding', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.site_project_binding', 'INSERT'))
           AND has_any_column_privilege(runtime_role.rolname, 'platform.site_project_binding', 'UPDATE')
           AND (has_table_privilege(runtime_role.rolname, 'platform.site_release', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.site_release', 'INSERT'))
           AND has_any_column_privilege(runtime_role.rolname, 'platform.site_release', 'UPDATE')
           AND (has_table_privilege(runtime_role.rolname, 'platform.site_activation_attempt', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.site_activation_attempt', 'INSERT'))
           AND has_table_privilege(runtime_role.rolname, 'platform.site_deployment_binding', 'SELECT')
           AND has_any_column_privilege(runtime_role.rolname, 'platform.site_deployment_binding', 'UPDATE')
           AND (has_table_privilege(runtime_role.rolname, 'platform.site_traffic_stop_attempt', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.site_traffic_stop_attempt', 'INSERT'))
           AND has_table_privilege(runtime_role.rolname, 'platform.site_traffic_stop_observation', 'SELECT')
           AND (has_table_privilege(runtime_role.rolname, 'platform.site_effect_approval', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.site_effect_approval', 'INSERT'))
           AND has_any_column_privilege(runtime_role.rolname, 'platform.site_effect_approval', 'UPDATE')
           AND has_any_column_privilege(runtime_role.rolname, 'platform.authorization_site', 'UPDATE')
           AND has_any_column_privilege(runtime_role.rolname, 'platform.authorization_product_binding', 'UPDATE')
           AND (has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_stream_state', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_stream_state', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_site_cursor', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_site_cursor', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_site_cursor', 'UPDATE'))
           AND has_table_privilege(runtime_role.rolname, 'platform.authorization_scoped_event_log', 'INSERT')
           AND has_table_privilege(runtime_role.rolname, 'platform.admin_operator_authority', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.admin_operator_site_scope', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.admin_operator_global_scope_grant', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.admin_breakglass_grant', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.admin_operator_identity', 'SELECT')
           AND (has_table_privilege(runtime_role.rolname, 'platform.admin_oidc_transaction', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.admin_oidc_transaction', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.admin_oidc_transaction', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.admin_operator_session', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.admin_operator_session', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.admin_operator_session', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.admin_step_up_transaction', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.admin_step_up_transaction', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.admin_step_up_transaction', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.admin_command_decision', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.admin_command_decision', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.admin_approval', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.admin_approval', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.admin_approval', 'UPDATE'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.admin_approval_decision', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.admin_approval_decision', 'INSERT'))
           AND (has_table_privilege(runtime_role.rolname, 'platform.admin_post_effect_review', 'SELECT') AND has_table_privilege(runtime_role.rolname, 'platform.admin_post_effect_review', 'INSERT') AND has_table_privilege(runtime_role.rolname, 'platform.admin_post_effect_review', 'UPDATE'))
           AND has_table_privilege(runtime_role.rolname, 'platform.asset_upload_intent', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.asset_upload_session', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.asset_quota_account', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.asset_quota_reservation', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.asset_blob_candidate', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.asset_cleanup_group', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.asset_object_cleanup', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.asset_object_cleanup_receipt', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.asset_upload_rejection', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.asset_scan_evaluation', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.asset_promotion_intent', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.asset_blob', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.asset_resource', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.asset_version', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.asset_reference', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.asset_eligibility_projection', 'SELECT')
           AND has_table_privilege(runtime_role.rolname, 'platform.asset_promotion_receipt', 'SELECT')
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
         ,has_function_privilege(runtime_role.rolname, 'platform.valid_credit_scope_policy(jsonb)', 'EXECUTE')
           AS "canExecuteCreditScopePolicy"
         ,has_function_privilege(runtime_role.rolname, 'platform.apply_admin_authority_change(uuid,jsonb)', 'EXECUTE')
           AS "canExecuteAdminAuthorityChange"
         ,CASE WHEN runtime_role.rolname=$1 THEN
            has_function_privilege(runtime_role.rolname,'platform.resolve_product_model_option_catalog(text,text)','EXECUTE')
          WHEN runtime_role.rolname=$5 THEN
            has_function_privilege(runtime_role.rolname,'platform.resolve_admission_model_owner(text,text,text)','EXECUTE')
          WHEN runtime_role.rolname=$4 THEN
            has_function_privilege(runtime_role.rolname,'platform.load_model_option_inventory(text)','EXECUTE')
            AND has_function_privilege(runtime_role.rolname,'platform.load_model_option_revisions(text[])','EXECUTE')
            AND has_function_privilege(runtime_role.rolname,'platform.materialize_model_options(uuid,text,text,text,text,jsonb,text)','EXECUTE')
            AND has_function_privilege(runtime_role.rolname,'platform.publish_site_release_model_catalog(uuid,jsonb,text)','EXECUTE')
          ELSE TRUE END AS "hasRequiredModelOptionFunctions"
         ,EXISTS (
           SELECT 1 FROM pg_class model_relation
           WHERE model_relation.relnamespace=platform_schema.oid
             AND model_relation.relname=ANY(ARRAY[
               'model_inventory_import','model_inventory_activation','model_inventory_pointer','model_provider_snapshot',
               'model_definition_snapshot','model_provider_binding_snapshot','model_product_route_snapshot',
               'model_provider_availability','model_definition_availability','model_provider_availability_report','model_site_policy_revision',
               'model_site_assignment_revision','model_site_policy_pointer','model_selection_decision',
               'model_option_materialization','model_option_revision','model_option_materialized_revision',
               'model_option_role_binding',
               'site_release_model_catalog_publication','site_release_model_catalog_surface',
               'site_release_model_catalog_option'
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
                 'model_site_assignment_revision','model_site_policy_pointer','model_selection_decision',
                 'authorization_site','authorization_site_release','authorization_product_binding',
                 'authorization_subject','authorization_identity_session','authorization_project',
                 'authorization_project_membership','authorization_product_context',
               'authorization_session_access_grant','authorization_scoped_stream_state','authorization_scoped_site_cursor','authorization_scoped_event_log',
               'authorization_scoped_snapshot','authorization_scoped_snapshot_record','model_option_materialization','model_option_revision',
               'model_option_materialized_revision','model_option_role_binding',
               'site_release_model_catalog_publication',
               'site_release_model_catalog_surface','site_release_model_catalog_option'
               ,'identity_account','identity_password_credential','identity_login_identifier',
               'identity_verification_transaction','identity_verification_legal_acceptance','identity_verification_delivery',
               'identity_totp_authenticator','identity_recovery_code_set','identity_recovery_code',
               'identity_auth_rate_limit','identity_auth_transaction','identity_reauthentication_challenge',
               'identity_totp_enrollment_transaction','identity_totp_enrollment_delivery_claim',
               'identity_reauthentication_proof','identity_reauthentication_delivery_claim',
               'identity_recovery_code_delivery_claim','identity_security_event',
               'identity_refresh_family','identity_refresh_credential','identity_session_delivery_claim',
               'identity_receipt_recovery_capability','identity_personal_workspace','identity_workspace_membership',
               'identity_execution_space','identity_namespace_allocation_intent','identity_personal_bootstrap'
               ,'commerce_command','commerce_billing_account','commerce_billing_account_membership',
               'commerce_fulfillment_transaction','commerce_fulfillment_output_plan',
               'commerce_fulfillment_actual_output','commerce_command_outbox','commerce_audit_entry',
               'commerce_catalog_product','commerce_catalog_plan','commerce_catalog_plan_version',
               'commerce_credit_program_revision','commerce_entitlement_template_revision',
               'commerce_fulfillment_program_revision','commerce_fulfillment_program_output',
               'commerce_catalog_product_version','commerce_redemption_program_revision',
               'commerce_redemption_program_availability','commerce_subscription','commerce_subscription_term',
               'commerce_subscription_term_revocation','commerce_code_batch','commerce_redeem_code','commerce_code_batch_approval','commerce_code_secret_export',
               'commerce_redemption','commerce_redemption_preview','commerce_redemption_legal_acceptance',
               'commerce_entitlement_grant','commerce_entitlement_revocation','credit_account','credit_grant',
               'credit_program_window_acquisition','credit_hold','credit_hold_allocation',
               'credit_journal_transaction','credit_journal_entry','credit_execution_budget_root',
               'credit_budget_allocation','credit_budget_allocation_revision',
               'credit_allocation_reservation_receipt','credit_allocation_return_receipt',
               'credit_authorization_segment','credit_budget_operation_receipt',
               'site','site_project_binding','site_release','site_deployment_binding',
               'site_activation_attempt','site_deployment_observation','site_traffic_stop_attempt',
               'site_traffic_stop_observation','site_effect_approval',
               'admin_operator_authority','admin_operator_site_scope','admin_operator_global_scope_grant',
               'admin_breakglass_grant','admin_operator_identity','admin_oidc_transaction',
               'admin_operator_session','admin_step_up_transaction','admin_command_decision','admin_approval',
               'admin_approval_decision','admin_authority_bootstrap','admin_post_effect_review',
               ${ADMISSION_RELATIONS_SQL},
               ${ASSET_RELATIONS_SQL},
               ${CREDIT_USAGE_RELATIONS_SQL},
               ${MODEL_GATEWAY_ADMISSION_RELATIONS_SQL}
               ]) AND (
                 (candidate.relname LIKE 'model\\_%' ESCAPE '\\'
                   AND candidate.relname<>'model_gateway_execution_authorization' AND (
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
                 'model_site_assignment_revision','model_site_policy_pointer','model_selection_decision',
                 'authorization_site','authorization_site_release','authorization_product_binding',
                 'authorization_subject','authorization_identity_session','authorization_project',
                 'authorization_project_membership','authorization_product_context',
                 'authorization_session_access_grant','authorization_scoped_stream_state','authorization_scoped_site_cursor','authorization_scoped_event_log',
                 'authorization_scoped_snapshot','authorization_scoped_snapshot_record','model_option_materialization','model_option_revision',
                 'model_option_materialized_revision','model_option_role_binding',
               'site_release_model_catalog_publication',
               'site_release_model_catalog_surface','site_release_model_catalog_option'
               ,'identity_account','identity_password_credential','identity_login_identifier',
               'identity_verification_transaction','identity_verification_legal_acceptance','identity_verification_delivery',
               'identity_totp_authenticator','identity_recovery_code_set','identity_recovery_code',
               'identity_auth_rate_limit','identity_auth_transaction','identity_reauthentication_challenge',
               'identity_totp_enrollment_transaction','identity_totp_enrollment_delivery_claim',
               'identity_reauthentication_proof','identity_reauthentication_delivery_claim',
               'identity_recovery_code_delivery_claim','identity_security_event',
               'identity_refresh_family','identity_refresh_credential','identity_session_delivery_claim',
               'identity_receipt_recovery_capability','identity_personal_workspace','identity_workspace_membership',
               'identity_execution_space','identity_namespace_allocation_intent','identity_personal_bootstrap'
               ,'commerce_command','commerce_billing_account','commerce_billing_account_membership',
               'commerce_fulfillment_transaction','commerce_fulfillment_output_plan',
               'commerce_fulfillment_actual_output','commerce_command_outbox','commerce_audit_entry',
               'commerce_catalog_product','commerce_catalog_plan','commerce_catalog_plan_version',
               'commerce_credit_program_revision','commerce_entitlement_template_revision',
               'commerce_fulfillment_program_revision','commerce_fulfillment_program_output',
               'commerce_catalog_product_version','commerce_redemption_program_revision',
               'commerce_redemption_program_availability','commerce_subscription','commerce_subscription_term',
               'commerce_subscription_term_revocation','commerce_code_batch','commerce_redeem_code','commerce_code_batch_approval','commerce_code_secret_export',
               'commerce_redemption','commerce_redemption_preview','commerce_redemption_legal_acceptance',
               'commerce_entitlement_grant','commerce_entitlement_revocation','credit_account','credit_grant',
               'credit_program_window_acquisition','credit_hold','credit_hold_allocation',
               'credit_journal_transaction','credit_journal_entry','credit_execution_budget_root',
               'credit_budget_allocation','credit_budget_allocation_revision',
               'credit_allocation_reservation_receipt','credit_allocation_return_receipt',
               'credit_authorization_segment','credit_budget_operation_receipt',
               'site','site_project_binding','site_release','site_deployment_binding',
               'site_activation_attempt','site_deployment_observation','site_traffic_stop_attempt',
               'site_traffic_stop_observation','site_effect_approval',
               'admin_operator_authority','admin_operator_site_scope','admin_operator_global_scope_grant',
               'admin_breakglass_grant','admin_operator_identity','admin_oidc_transaction',
               'admin_operator_session','admin_step_up_transaction','admin_command_decision','admin_approval',
               'admin_approval_decision','admin_authority_bootstrap','admin_post_effect_review',
               ${ADMISSION_RELATIONS_SQL},
               ${ASSET_RELATIONS_SQL},
               ${CREDIT_USAGE_RELATIONS_SQL},
               ${MODEL_GATEWAY_ADMISSION_RELATIONS_SQL}
               ]) AND (
                 (runtime_role.rolname = $2 AND (
                   has_table_privilege(runtime_role.rolname,candidate.oid,'SELECT')
                   OR has_any_column_privilege(runtime_role.rolname,candidate.oid,'SELECT')
                 ) AND candidate.relname <> ALL(ARRAY[
                   'platform_foundation','authorization_scoped_stream_state','authorization_scoped_site_cursor','authorization_scoped_event_log',
                   'authorization_scoped_snapshot','authorization_scoped_snapshot_record','authorization_site',
                   'authorization_subject','authorization_identity_session','authorization_project_membership',
                   'authorization_session_access_grant'
                 ]))
                 OR
                 (runtime_role.rolname=$5 AND (
                   has_table_privilege(runtime_role.rolname,candidate.oid,'SELECT')
                   OR has_any_column_privilege(runtime_role.rolname,candidate.oid,'SELECT')
                 ) AND candidate.relname <> ALL(ARRAY[${ADMISSION_SELECT_RELATIONS_SQL}]))
                 OR
                 ((has_table_privilege(runtime_role.rolname,candidate.oid,'SELECT')
                   OR has_any_column_privilege(runtime_role.rolname,candidate.oid,'SELECT'))
                  AND candidate.relname = ANY(ARRAY[
                    'site','site_project_binding','site_release','site_deployment_binding',
                    'site_activation_attempt','site_deployment_observation','site_traffic_stop_attempt',
                    'site_traffic_stop_observation','site_effect_approval'
                  ]) AND NOT (
                    (runtime_role.rolname=$1 AND
                      candidate.relname=ANY(ARRAY['site','site_release']))
                    OR (runtime_role.rolname=$3 AND candidate.relname<>'site_effect_approval')
                    OR runtime_role.rolname=$4
                    OR (runtime_role.rolname=$5 AND
                      candidate.relname=ANY(ARRAY['site','site_release']))
                 ))
                 OR
                 ((has_table_privilege(runtime_role.rolname,candidate.oid,'SELECT')
                   OR has_any_column_privilege(runtime_role.rolname,candidate.oid,'SELECT'))
                  AND candidate.relname=ANY(ARRAY[${ASSET_RELATIONS_SQL}]) AND NOT (
                    (runtime_role.rolname=$1 AND
                      candidate.relname=ANY(ARRAY[${ASSET_API_RELATIONS_SQL}]))
                    OR (runtime_role.rolname IN ($3,$4))
                    OR (runtime_role.rolname=$5 AND candidate.relname=ANY(ARRAY[
                      'asset_resource','asset_version','asset_eligibility_projection'
                    ]))
                  ))
                 OR
                 (runtime_role.rolname=$1
                  AND candidate.relname=ANY(ARRAY[${ASSET_API_OWNER_READ_RELATIONS_SQL}])
                  AND (has_table_privilege(runtime_role.rolname,candidate.oid,'SELECT') OR EXISTS (
                    SELECT 1 FROM pg_attribute candidate_column
                    WHERE candidate_column.attrelid=candidate.oid
                      AND candidate_column.attnum>0 AND NOT candidate_column.attisdropped
                      AND has_column_privilege(
                        runtime_role.rolname,candidate.oid,candidate_column.attnum,'SELECT'
                      )
                      AND NOT (${ASSET_API_OWNER_READ_COLUMN_ALLOWLIST_SQL})
                  )))
                 OR
                 (has_table_privilege(runtime_role.rolname, candidate.oid,
                   'DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') AND NOT (
                   runtime_role.rolname = $3 AND candidate.relname = ANY(ARRAY[
                     'authorization_scoped_event_log','authorization_scoped_snapshot'
                   ])
                 ))
                 OR has_any_column_privilege(runtime_role.rolname, candidate.oid, 'REFERENCES')
                 OR (has_table_privilege(runtime_role.rolname, candidate.oid, 'INSERT') AND NOT (
                   (runtime_role.rolname = $1 AND candidate.relname = ANY(ARRAY[
                     'command_receipt','outbox_event','inbox_delivery','model_selection_decision',
                     'authorization_product_context','authorization_session_access_grant','authorization_scoped_site_cursor','authorization_scoped_event_log',
                     'authorization_subject','authorization_identity_session','authorization_project','authorization_project_membership',
                     'identity_account','identity_password_credential','identity_login_identifier',
                     'identity_verification_transaction','identity_verification_legal_acceptance','identity_verification_delivery',
                     'identity_totp_authenticator','identity_recovery_code_set','identity_recovery_code',
                     'identity_auth_rate_limit','identity_auth_transaction','identity_reauthentication_challenge',
               'identity_totp_enrollment_transaction','identity_totp_enrollment_delivery_claim',
               'identity_reauthentication_proof','identity_reauthentication_delivery_claim',
               'identity_recovery_code_delivery_claim','identity_security_event',
                     'identity_refresh_family','identity_refresh_credential','identity_session_delivery_claim',
                     'identity_receipt_recovery_capability','identity_personal_workspace','identity_workspace_membership',
                     'identity_execution_space','identity_namespace_allocation_intent','identity_personal_bootstrap',
                     'commerce_command','commerce_billing_account','commerce_billing_account_membership',
                     'commerce_fulfillment_transaction','commerce_fulfillment_output_plan',
                     'commerce_fulfillment_actual_output','commerce_command_outbox','commerce_audit_entry',
                     'commerce_subscription','commerce_subscription_term','commerce_subscription_term_revocation',
                     'commerce_redemption','commerce_redemption_preview','commerce_redemption_legal_acceptance',
                     'commerce_entitlement_grant','commerce_entitlement_revocation','credit_account','credit_grant',
                     'credit_program_window_acquisition','credit_hold','credit_hold_allocation',
                     'credit_journal_transaction','credit_journal_entry','credit_execution_budget_root',
                     'credit_budget_allocation','credit_budget_allocation_revision',
                     'credit_allocation_reservation_receipt','credit_allocation_return_receipt',
                     'credit_authorization_segment','credit_budget_operation_receipt'
                   ]))
                   OR (runtime_role.rolname = $5 AND
                     candidate.relname=ANY(ARRAY[${ADMISSION_INSERT_RELATIONS_SQL}]))
                   OR (runtime_role.rolname = $2 AND candidate.relname = ANY(ARRAY['authorization_scoped_snapshot','authorization_scoped_snapshot_record']))
                   OR (runtime_role.rolname = $1 AND candidate.relname=ANY(ARRAY[${ASSET_API_MUTABLE_RELATIONS_SQL}]))
                   OR (runtime_role.rolname = $3 AND candidate.relname=ANY(ARRAY[${ASSET_WORKER_INSERT_RELATIONS_SQL}]))
                   OR (runtime_role.rolname = $3 AND candidate.relname = ANY(ARRAY[
                     'inbox_delivery','outbox_event',
                     'site_deployment_binding','site_deployment_observation',
                     'site_traffic_stop_observation','authorization_scoped_site_cursor','authorization_scoped_event_log','authorization_site',
                     'authorization_site_release','authorization_product_binding'
                   ]))
                   OR (runtime_role.rolname = $4 AND candidate.relname = ANY(ARRAY[
                     'command_receipt','outbox_event','commerce_billing_account','commerce_billing_account_membership',
                     'commerce_command','commerce_catalog_product','commerce_catalog_plan','commerce_catalog_plan_version',
                     'commerce_fulfillment_program_revision','commerce_fulfillment_program_output','commerce_catalog_product_version',
                     'commerce_redemption_program_revision','commerce_redemption_program_availability',
                     'commerce_code_batch','commerce_redeem_code','commerce_code_batch_approval',
                     'commerce_code_secret_export','commerce_audit_entry',
                     'site','site_project_binding','site_release','site_activation_attempt',
                     'site_traffic_stop_attempt','site_effect_approval','authorization_scoped_site_cursor','authorization_scoped_event_log',
                     'admin_command_decision','admin_approval','admin_approval_decision','admin_post_effect_review',
                     'admin_oidc_transaction','admin_operator_session','admin_step_up_transaction',
                     'admission_capability_catalog_snapshot','admission_launch_profile_snapshot'
                   ]))
                 ))
                 OR (has_table_privilege(runtime_role.rolname, candidate.oid, 'UPDATE') AND NOT (
                   (runtime_role.rolname = $1 AND candidate.relname = ANY(ARRAY[
                     'command_receipt','inbox_delivery','authorization_identity_session','authorization_product_context',
                     'authorization_session_access_grant','authorization_scoped_stream_state','authorization_scoped_site_cursor','authorization_site',
                     'identity_account','identity_password_credential','identity_login_identifier',
                     'identity_verification_transaction','identity_verification_delivery',
                     'identity_totp_authenticator','identity_recovery_code_set','identity_recovery_code',
                     'identity_auth_rate_limit','identity_auth_transaction','identity_reauthentication_challenge',
               'identity_totp_enrollment_transaction','identity_totp_enrollment_delivery_claim',
               'identity_reauthentication_proof','identity_reauthentication_delivery_claim',
               'identity_recovery_code_delivery_claim','identity_refresh_family',
                     'identity_refresh_credential','identity_session_delivery_claim','identity_receipt_recovery_capability',
                     'identity_execution_space','identity_namespace_allocation_intent',
                     'commerce_command','commerce_subscription','commerce_redeem_code','commerce_redemption',
                     'commerce_redemption_preview','credit_account','credit_hold',
                     'credit_execution_budget_root','credit_authorization_segment','commerce_fulfillment_transaction'
                   ]))
                   OR (runtime_role.rolname = $5 AND
                     candidate.relname=ANY(ARRAY[${ADMISSION_UPDATE_RELATIONS_SQL}]))
                   OR (runtime_role.rolname = $1 AND candidate.relname=ANY(ARRAY[${ASSET_API_MUTABLE_RELATIONS_SQL}]))
                   OR (runtime_role.rolname = $3 AND candidate.relname=ANY(ARRAY[${ASSET_WORKER_UPDATE_RELATIONS_SQL}]))
                   OR (runtime_role.rolname = $3 AND candidate.relname = ANY(ARRAY[
                     'outbox_event','site','site_release','site_deployment_binding',
                     'site_activation_attempt','site_traffic_stop_attempt','authorization_scoped_stream_state','authorization_scoped_site_cursor','authorization_site',
                     'authorization_site_release','authorization_product_binding'
                   ]))
                   OR (runtime_role.rolname = $3 AND candidate.relname = ANY(ARRAY[
                     'command_receipt','outbox_event','inbox_delivery','admin_approval','admin_post_effect_review'
                   ]))
                   OR (runtime_role.rolname = $4 AND candidate.relname = ANY(ARRAY[
                     'command_receipt','commerce_billing_account','commerce_billing_account_membership',
                     'commerce_catalog_product','commerce_catalog_plan','commerce_code_batch','commerce_redemption_program_availability',
                     'site','site_project_binding','site_release','site_deployment_binding',
                     'site_effect_approval','authorization_scoped_stream_state','authorization_scoped_site_cursor','authorization_site','authorization_product_binding',
                     'admin_approval','admin_post_effect_review','admin_oidc_transaction',
                     'admin_operator_session','admin_step_up_transaction'
                   ]))
                   OR (runtime_role.rolname = $4 AND candidate.relname = 'admin_approval')
                 ))
                 OR (has_any_column_privilege(runtime_role.rolname, candidate.oid, 'INSERT') AND NOT (
                   (runtime_role.rolname = $1 AND candidate.relname = ANY(ARRAY[
                     'command_receipt','outbox_event','inbox_delivery','model_selection_decision',
                     'authorization_product_context','authorization_session_access_grant','authorization_scoped_site_cursor','authorization_scoped_event_log',
                     'authorization_subject','authorization_identity_session','authorization_project','authorization_project_membership',
                     'identity_account','identity_password_credential','identity_login_identifier',
                     'identity_verification_transaction','identity_verification_legal_acceptance','identity_verification_delivery',
                     'identity_totp_authenticator','identity_recovery_code_set','identity_recovery_code',
                     'identity_auth_rate_limit','identity_auth_transaction','identity_reauthentication_challenge',
               'identity_totp_enrollment_transaction','identity_totp_enrollment_delivery_claim',
               'identity_reauthentication_proof','identity_reauthentication_delivery_claim',
               'identity_recovery_code_delivery_claim','identity_security_event',
                     'identity_refresh_family','identity_refresh_credential','identity_session_delivery_claim',
                     'identity_receipt_recovery_capability','identity_personal_workspace','identity_workspace_membership',
                     'identity_execution_space','identity_namespace_allocation_intent','identity_personal_bootstrap',
                     'commerce_command','commerce_billing_account','commerce_billing_account_membership',
                     'commerce_fulfillment_transaction','commerce_fulfillment_output_plan',
                     'commerce_fulfillment_actual_output','commerce_command_outbox','commerce_audit_entry',
                     'commerce_subscription','commerce_subscription_term','commerce_subscription_term_revocation',
                     'commerce_redemption','commerce_redemption_preview','commerce_redemption_legal_acceptance',
                     'commerce_entitlement_grant','commerce_entitlement_revocation','credit_account','credit_grant',
                     'credit_program_window_acquisition','credit_hold','credit_hold_allocation',
                     'credit_journal_transaction','credit_journal_entry','credit_execution_budget_root',
                     'credit_budget_allocation','credit_budget_allocation_revision',
                     'credit_allocation_reservation_receipt','credit_allocation_return_receipt',
                     'credit_authorization_segment','credit_budget_operation_receipt'
                   ]))
                   OR (runtime_role.rolname = $5 AND
                     candidate.relname=ANY(ARRAY[${ADMISSION_INSERT_RELATIONS_SQL}]))
                   OR (runtime_role.rolname = $2 AND candidate.relname = ANY(ARRAY['authorization_scoped_snapshot','authorization_scoped_snapshot_record']))
                   OR (runtime_role.rolname = $1 AND candidate.relname=ANY(ARRAY[${ASSET_API_MUTABLE_RELATIONS_SQL}]))
                   OR (runtime_role.rolname = $3 AND candidate.relname=ANY(ARRAY[${ASSET_WORKER_INSERT_RELATIONS_SQL}]))
                   OR (runtime_role.rolname = $3 AND candidate.relname = ANY(ARRAY[
                     'inbox_delivery','outbox_event',
                     'site_deployment_binding','site_deployment_observation',
                     'site_traffic_stop_observation','authorization_scoped_site_cursor','authorization_scoped_event_log','authorization_site',
                     'authorization_site_release','authorization_product_binding'
                   ]))
                   OR (runtime_role.rolname = $4 AND candidate.relname = ANY(ARRAY[
                     'command_receipt','outbox_event','commerce_billing_account','commerce_billing_account_membership',
                     'commerce_command','commerce_catalog_product','commerce_catalog_plan','commerce_catalog_plan_version',
                     'commerce_fulfillment_program_revision','commerce_fulfillment_program_output','commerce_catalog_product_version',
                     'commerce_redemption_program_revision','commerce_redemption_program_availability',
                     'commerce_code_batch','commerce_redeem_code','commerce_code_batch_approval',
                     'commerce_code_secret_export','commerce_audit_entry',
                     'site','site_project_binding','site_release','site_activation_attempt',
                     'site_traffic_stop_attempt','site_effect_approval','authorization_scoped_site_cursor','authorization_scoped_event_log',
                     'admin_command_decision','admin_approval','admin_approval_decision','admin_post_effect_review',
                     'admin_oidc_transaction','admin_operator_session','admin_step_up_transaction',
                     'admission_capability_catalog_snapshot','admission_launch_profile_snapshot'
                   ]))
                 ))
                 OR (has_any_column_privilege(runtime_role.rolname, candidate.oid, 'UPDATE') AND NOT (
                   (runtime_role.rolname = $1 AND candidate.relname = ANY(ARRAY[
                     'command_receipt','inbox_delivery','authorization_identity_session','authorization_product_context',
                     'authorization_session_access_grant','authorization_scoped_stream_state','authorization_scoped_site_cursor','authorization_site',
                     'identity_account','identity_password_credential','identity_login_identifier',
                     'identity_verification_transaction','identity_verification_delivery',
                     'identity_totp_authenticator','identity_recovery_code_set','identity_recovery_code',
                     'identity_auth_rate_limit','identity_auth_transaction','identity_reauthentication_challenge',
               'identity_totp_enrollment_transaction','identity_totp_enrollment_delivery_claim',
               'identity_reauthentication_proof','identity_reauthentication_delivery_claim',
               'identity_recovery_code_delivery_claim','identity_refresh_family',
                     'identity_refresh_credential','identity_session_delivery_claim','identity_receipt_recovery_capability',
                     'identity_execution_space','identity_namespace_allocation_intent',
                     'commerce_command','commerce_subscription','commerce_redeem_code','commerce_redemption',
                     'commerce_redemption_preview','credit_account','credit_hold',
                     'credit_execution_budget_root','credit_authorization_segment','commerce_fulfillment_transaction'
                   ]))
                   OR (runtime_role.rolname = $5 AND
                     candidate.relname=ANY(ARRAY[${ADMISSION_UPDATE_RELATIONS_SQL}]))
                   OR (runtime_role.rolname = $1 AND candidate.relname=ANY(ARRAY[${ASSET_API_MUTABLE_RELATIONS_SQL}]))
                   OR (runtime_role.rolname = $3 AND candidate.relname=ANY(ARRAY[${ASSET_WORKER_UPDATE_RELATIONS_SQL}]))
                   OR (runtime_role.rolname = $3 AND candidate.relname = ANY(ARRAY[
                     'outbox_event','site','site_release','site_deployment_binding',
                     'site_activation_attempt','site_traffic_stop_attempt','authorization_scoped_stream_state','authorization_scoped_site_cursor','authorization_site',
                     'authorization_site_release','authorization_product_binding'
                   ]))
                   OR (runtime_role.rolname = $3 AND candidate.relname = ANY(ARRAY[
                     'command_receipt','outbox_event','inbox_delivery','admin_approval','admin_post_effect_review'
                   ]))
                   OR (runtime_role.rolname = $4 AND candidate.relname = ANY(ARRAY[
                     'command_receipt','commerce_billing_account','commerce_billing_account_membership',
                     'commerce_catalog_product','commerce_catalog_plan','commerce_code_batch','commerce_redemption_program_availability',
                     'site','site_project_binding','site_release','site_deployment_binding',
                     'site_effect_approval','authorization_scoped_stream_state','authorization_scoped_site_cursor','authorization_site','authorization_product_binding',
                     'admin_approval','admin_post_effect_review','admin_oidc_transaction',
                     'admin_operator_session','admin_step_up_transaction'
                   ]))
                   OR (runtime_role.rolname = $4 AND candidate.relname = 'admin_approval')
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
               (runtime_role.rolname = $4 AND candidate_function.oid = ANY(ARRAY[
                 to_regprocedure('platform.import_model_inventory(uuid,text,text,jsonb,jsonb,text)'),
                 to_regprocedure('platform.activate_model_inventory(uuid,text,bigint,text)'),
                 to_regprocedure('platform.put_model_site_policy(uuid,text,text,text,bigint)'),
                 to_regprocedure('platform.load_model_option_inventory(text)'),
                 to_regprocedure('platform.load_model_option_revisions(text[])'),
                 to_regprocedure('platform.materialize_model_options(uuid,text,text,text,text,jsonb,text)'),
                 to_regprocedure('platform.publish_site_release_model_catalog(uuid,jsonb,text)'),
                 to_regprocedure('platform.valid_credit_scope_policy(jsonb)')
               ]))
               OR (runtime_role.rolname = $1 AND candidate_function.oid = ANY(ARRAY[
                 to_regprocedure('platform.resolve_model_candidates(text,text,text)'),
                 to_regprocedure('platform.find_model_selection_decision(uuid)'),
                 to_regprocedure('platform.resolve_product_model_option_catalog(text,text)'),
                 to_regprocedure('platform.valid_credit_scope_policy(jsonb)')
               ]))
               OR (runtime_role.rolname = $5 AND candidate_function.oid = ANY(ARRAY[
                 to_regprocedure('platform.resolve_admission_model_owner(text,text,text)'),
                 to_regprocedure('platform.valid_credit_scope_policy(jsonb)')
               ]))
               OR (runtime_role.rolname = $3 AND candidate_function.oid = ANY(ARRAY[
                 to_regprocedure('platform.report_model_provider_availability(uuid,text,text,text,bigint,text,timestamptz,text)'),
                 to_regprocedure('platform.apply_admin_authority_change(uuid,jsonb)')
               ]))
               OR candidate_function.oid = ANY(ARRAY[
                 to_regprocedure('platform.model_identifier_is_valid(text)'),
                 to_regprocedure('platform.model_text_is_valid(text)'),
                 to_regprocedure('platform.model_secret_reference_is_valid(text)'),
                 to_regprocedure('platform.model_identifier_array_is_canonical(text[],boolean)'),
                 to_regprocedure('platform.model_json_identifier_array_is_canonical(jsonb,boolean)')
               ])
             )
         ) AS "hasUnexpectedPlatformPrivilege"
  FROM pg_roles runtime_role
  JOIN pg_namespace platform_schema ON platform_schema.nspname = 'platform'
  JOIN pg_roles schema_owner ON schema_owner.oid = platform_schema.nspowner
  JOIN pg_class foundation ON foundation.relnamespace = platform_schema.oid
                          AND foundation.relname = 'platform_foundation'
  JOIN pg_roles foundation_owner ON foundation_owner.oid = foundation.relowner
  WHERE runtime_role.rolname = ANY(ARRAY[$1,$2,$3,$4,$5]::text[])
  ORDER BY runtime_role.rolname
`;

function assertDistinctRoles(
  migratorRole: string,
  apiRole: string,
  admissionRole: string,
  authorizationRole: string,
  assetDataPlaneRole: string,
  workerRole: string,
  adminRole: string,
  modelGatewayRole: string,
): void {
  if (
    new Set([
      migratorRole,
      apiRole,
      admissionRole,
      authorizationRole,
      assetDataPlaneRole,
      workerRole,
      adminRole,
      modelGatewayRole,
    ]).size !== 8
  ) {
    throw new Error("PLATFORM_DATABASE_ROLES_MUST_BE_DISTINCT");
  }
}

function sqlLiterals(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(",");
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
