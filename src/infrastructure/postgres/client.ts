import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/platform-prisma/client.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
  type PlatformSqlTransaction,
} from "../../shared/unit-of-work/platform-transaction.js";
import type { PlatformTransactionHost } from "../../shared/unit-of-work/unit-of-work.js";
import { assertVerifiedRequestSecurityContext } from "../../shared/security-context/request-security-context.js";

export type PlatformProcessRole = "api" | "worker" | "migrator";
export type PlatformCredentialClass = "api" | "worker" | "migrator";

const ROLE_DEFAULTS = {
  api: { poolMax: 20, credentialClass: "api", identityEnv: "PLATFORM_DATABASE_API_ROLE" },
  worker: {
    poolMax: 8,
    credentialClass: "worker",
    identityEnv: "PLATFORM_DATABASE_WORKER_ROLE",
  },
  migrator: {
    poolMax: 1,
    credentialClass: "migrator",
    identityEnv: "PLATFORM_DATABASE_MIGRATOR_ROLE",
  },
} as const satisfies Record<
  PlatformProcessRole,
  { poolMax: number; credentialClass: PlatformCredentialClass; identityEnv: string }
>;

export interface PlatformDatabaseConfig {
  readonly url: string;
  readonly role: PlatformProcessRole;
  readonly credentialClass: PlatformCredentialClass;
  readonly authorityMode: "transition-candidate";
  readonly expectedDatabaseUser: string;
  readonly expectedDatabaseName: string;
  readonly migratorDatabaseUser: string;
  readonly applicationName: string;
  readonly safeDatabaseIdentity: string;
  readonly schema: "platform";
  readonly pool: {
    readonly max: number;
    readonly connectionTimeoutMs: number;
  };
  readonly session: {
    readonly statementTimeoutMs: number;
    readonly lockTimeoutMs: number;
    readonly idleTransactionTimeoutMs: number;
  };
  readonly transaction: {
    readonly isolationLevel: "ReadCommitted";
    readonly maxWaitMs: number;
    readonly timeoutMs: number;
  };
  toJSON(): Omit<PlatformDatabaseConfig, "url" | "toJSON">;
}

export interface PlatformDatabaseClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  checkHealth(): Promise<void>;
}

export interface PlatformTransactionalDatabaseClient
  extends PlatformDatabaseClient,
    PlatformTransactionHost {}

export function loadPlatformDatabaseConfig(
  role: PlatformProcessRole,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PlatformDatabaseConfig {
  if (environment.PLATFORM_DATABASE_AUTHORITY_MODE !== "transition-candidate") {
    throw new Error("PLATFORM_DATABASE_AUTHORITY_MODE_REQUIRED:transition-candidate");
  }

  const value = environment.DATABASE_URL_PLATFORM;
  if (!value) throw new Error("DATABASE_URL_PLATFORM_REQUIRED");

  const url = parsePostgresUrl(value);
  const defaults = ROLE_DEFAULTS[role];
  if (environment.PLATFORM_DATABASE_CREDENTIAL_CLASS !== defaults.credentialClass) {
    throw new Error(`PLATFORM_DATABASE_CREDENTIAL_CLASS_REQUIRED:${defaults.credentialClass}`);
  }

  const expectedDatabaseUser = requireIdentifier(
    environment[defaults.identityEnv],
    defaults.identityEnv,
  );
  const migratorDatabaseUser = requireIdentifier(
    environment.PLATFORM_DATABASE_MIGRATOR_ROLE,
    "PLATFORM_DATABASE_MIGRATOR_ROLE",
  );
  const expectedDatabaseName = requireIdentifier(
    environment.PLATFORM_DATABASE_EXPECTED_DATABASE,
    "PLATFORM_DATABASE_EXPECTED_DATABASE",
  );
  if (decodeURIComponent(url.username) !== expectedDatabaseUser) {
    throw new Error("PLATFORM_DATABASE_URL_USER_MISMATCH");
  }
  if (decodeURIComponent(url.pathname.slice(1)) !== expectedDatabaseName) {
    throw new Error("PLATFORM_DATABASE_URL_NAME_MISMATCH");
  }
  if (role !== "migrator" && expectedDatabaseUser === migratorDatabaseUser) {
    throw new Error("PLATFORM_RUNTIME_ROLE_MUST_DIFFER_FROM_MIGRATOR");
  }

  const safeDatabaseIdentity = `${url.hostname}:${url.port || "5432"}/${expectedDatabaseName}`;
  const publicConfig = {
    role,
    credentialClass: defaults.credentialClass,
    authorityMode: "transition-candidate" as const,
    expectedDatabaseUser,
    expectedDatabaseName,
    migratorDatabaseUser,
    applicationName: `kokoro-platform-${role}`,
    safeDatabaseIdentity,
    schema: "platform" as const,
    pool: { max: defaults.poolMax, connectionTimeoutMs: 5_000 },
    session: {
      statementTimeoutMs: role === "migrator" ? 30_000 : 15_000,
      lockTimeoutMs: role === "migrator" ? 5_000 : 3_000,
      idleTransactionTimeoutMs: role === "migrator" ? 30_000 : 10_000,
    },
    transaction: {
      isolationLevel: "ReadCommitted" as const,
      maxWaitMs: 5_000,
      timeoutMs: 10_000,
    },
  };

  const config = { url: value, ...publicConfig, toJSON: () => publicConfig };
  Object.defineProperty(config, "url", { enumerable: false });
  return config;
}

export function createPlatformDatabaseClient(
  config: PlatformDatabaseConfig,
): PlatformTransactionalDatabaseClient {
  if (config.role === "migrator") {
    throw new Error("PLATFORM_MIGRATOR_CANNOT_CREATE_RUNTIME_CLIENT");
  }

  const adapter = new PrismaPg({
    connectionString: config.url,
    max: config.pool.max,
    connectionTimeoutMillis: config.pool.connectionTimeoutMs,
    application_name: config.applicationName,
    options: sessionOptions(config),
  });
  const prisma = new PrismaClient({
    adapter,
    transactionOptions: {
      isolationLevel: config.transaction.isolationLevel,
      maxWait: config.transaction.maxWaitMs,
      timeout: config.transaction.timeoutMs,
    },
  });

  return {
    connect: async () => {
      await prisma.$connect();
      try {
        const rows = await prisma.$queryRawUnsafe<RuntimeIdentity[]>(
          RUNTIME_IDENTITY_SQL,
          config.migratorDatabaseUser,
        );
        if (!validRuntimeIdentity(rows[0], config)) {
          throw new Error("PLATFORM_RUNTIME_DATABASE_ROLE_INVALID");
        }
        await prisma.$queryRaw`SELECT "schemaVersion" FROM platform.platform_foundation WHERE singleton = TRUE`;
      } catch (error) {
        await prisma.$disconnect();
        throw error;
      }
    },
    disconnect: () => prisma.$disconnect(),
    checkHealth: async () => {
      await prisma.$queryRaw`SELECT "schemaVersion" FROM platform.platform_foundation WHERE singleton = TRUE`;
    },
    transaction: async <Result>(fence: Parameters<PlatformTransactionHost["transaction"]>[0], work: Parameters<PlatformTransactionHost["transaction"]>[1]) =>
      prisma.$transaction(async (databaseTransaction) => {
        const context = fence.context;
        assertVerifiedRequestSecurityContext(context, new Date().toISOString());
        await databaseTransaction.$queryRawUnsafe(
          `SELECT set_config('app.operation', $1, true),
                  set_config('app.site_id', $2, true),
                  set_config('app.workspace_id', $3, true),
                  set_config('app.project_id', $4, true),
                  set_config('app.subject_id', $5, true),
                  set_config('app.subject_generation', $6, true),
                  set_config('app.purpose', $7, true),
                  set_config('app.policy_epoch', $8, true),
                  set_config('app.environment', $9, true),
                  set_config('app.region', $10, true)`,
          fence.operation,
          context.target.siteId ?? "",
          context.target.workspaceId ?? "",
          context.target.projectId ?? "",
          context.actor.subjectId,
          context.actor.subjectGeneration,
          context.target.purpose,
          context.policyEpoch,
          context.environment,
          context.region,
        );
        const sql: PlatformSqlTransaction = {
          query: (statement, values = []) =>
            databaseTransaction.$queryRawUnsafe(statement, ...values),
          execute: (statement, values = []) =>
            databaseTransaction.$executeRawUnsafe(statement, ...values),
        };
        const lease = issuePlatformTransaction(sql);
        try {
          return await work(lease.transaction) as Result;
        } finally {
          revokePlatformTransaction(lease);
        }
      }, {
        isolationLevel: config.transaction.isolationLevel,
        maxWait: config.transaction.maxWaitMs,
        timeout: config.transaction.timeoutMs,
      }),
  };
}

interface RuntimeIdentity {
  currentUser: string;
  currentDatabase: string;
  serverMajor: number;
  databaseOwner: string;
  schemaOwner: string | null;
  foundationOwner: string | null;
  canUseSchema: boolean;
  canCreateSchema: boolean;
  canCreateDatabaseObject: boolean;
  canReadFoundation: boolean;
  canMutateFoundation: boolean;
  isMigratorMember: boolean;
  isSuperuser: boolean;
  canCreateDatabase: boolean;
  canCreateRole: boolean;
  canReplicate: boolean;
  canBypassRls: boolean;
  inheritsPrivileges: boolean;
  hasAnyMembership: boolean;
  ownsPlatformRelation: boolean;
  ownsPlatformFunction: boolean;
  hasUnexpectedPlatformPrivilege: boolean;
}

const RUNTIME_IDENTITY_SQL = `
  SELECT current_user AS "currentUser",
         current_database() AS "currentDatabase",
         current_setting('server_version_num')::int / 10000 AS "serverMajor",
         db_owner.rolname AS "databaseOwner",
         schema_owner.rolname AS "schemaOwner",
         foundation_owner.rolname AS "foundationOwner",
         has_schema_privilege(current_user, 'platform', 'USAGE') AS "canUseSchema",
         has_schema_privilege(current_user, 'platform', 'CREATE') AS "canCreateSchema",
         has_database_privilege(current_user, current_database(), 'CREATE') AS "canCreateDatabaseObject",
         has_table_privilege(current_user, 'platform.platform_foundation', 'SELECT') AS "canReadFoundation",
         has_table_privilege(
           current_user,
           'platform.platform_foundation',
           'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
         ) AS "canMutateFoundation",
         pg_has_role(current_user, $1, 'MEMBER') AS "isMigratorMember",
         runtime_role.rolsuper AS "isSuperuser",
         runtime_role.rolcreatedb AS "canCreateDatabase",
         runtime_role.rolcreaterole AS "canCreateRole",
         runtime_role.rolreplication AS "canReplicate",
         runtime_role.rolbypassrls AS "canBypassRls",
         runtime_role.rolinherit AS "inheritsPrivileges",
         EXISTS (SELECT 1 FROM pg_auth_members membership WHERE membership.member = runtime_role.oid)
           AS "hasAnyMembership",
         EXISTS (
           SELECT 1
           FROM pg_class owned_relation
           JOIN pg_namespace owned_schema ON owned_schema.oid = owned_relation.relnamespace
           WHERE owned_schema.nspname = 'platform'
             AND owned_relation.relowner = runtime_role.oid
         ) AS "ownsPlatformRelation",
         EXISTS (
           SELECT 1 FROM pg_proc owned_function
           WHERE owned_function.pronamespace = platform_schema.oid
             AND owned_function.proowner = runtime_role.oid
         ) AS "ownsPlatformFunction",
         EXISTS (
           SELECT 1 FROM pg_class candidate
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
  FROM pg_database database_row
  JOIN pg_roles db_owner ON db_owner.oid = database_row.datdba
  JOIN pg_roles runtime_role ON runtime_role.rolname = current_user
  LEFT JOIN pg_namespace platform_schema ON platform_schema.nspname = 'platform'
  LEFT JOIN pg_roles schema_owner ON schema_owner.oid = platform_schema.nspowner
  LEFT JOIN pg_class foundation ON foundation.relnamespace = platform_schema.oid
                                AND foundation.relname = 'platform_foundation'
  LEFT JOIN pg_roles foundation_owner ON foundation_owner.oid = foundation.relowner
  WHERE database_row.datname = current_database()
`;

function validRuntimeIdentity(
  identity: RuntimeIdentity | undefined,
  config: PlatformDatabaseConfig,
): boolean {
  return Boolean(
    identity &&
    identity.currentUser === config.expectedDatabaseUser &&
    identity.currentDatabase === config.expectedDatabaseName &&
    identity.serverMajor === 18 &&
    identity.databaseOwner === config.migratorDatabaseUser &&
    identity.schemaOwner === config.migratorDatabaseUser &&
    identity.foundationOwner === config.migratorDatabaseUser &&
    identity.canUseSchema &&
    !identity.canCreateSchema &&
    !identity.canCreateDatabaseObject &&
    identity.canReadFoundation &&
    !identity.canMutateFoundation &&
    !identity.isMigratorMember &&
    !identity.isSuperuser &&
    !identity.canCreateDatabase &&
    !identity.canCreateRole &&
    !identity.canReplicate &&
    !identity.canBypassRls &&
    !identity.inheritsPrivileges &&
    !identity.hasAnyMembership &&
    !identity.ownsPlatformRelation &&
    !identity.ownsPlatformFunction &&
    !identity.hasUnexpectedPlatformPrivilege,
  );
}

function requireIdentifier(value: string | undefined, name: string): string {
  if (!value || !/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) {
    throw new Error(`${name}_REQUIRED`);
  }
  return value;
}

function parsePostgresUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DATABASE_URL_PLATFORM_INVALID");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL_PLATFORM_MUST_BE_POSTGRESQL");
  }
  if (!url.username || !url.hostname || url.pathname.length < 2) {
    throw new Error("DATABASE_URL_PLATFORM_INVALID");
  }
  return url;
}

function sessionOptions(config: PlatformDatabaseConfig): string {
  return [
    `-c search_path=${config.schema}`,
    `-c statement_timeout=${config.session.statementTimeoutMs}`,
    `-c lock_timeout=${config.session.lockTimeoutMs}`,
    `-c idle_in_transaction_session_timeout=${config.session.idleTransactionTimeoutMs}`,
  ].join(" ");
}
