import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/platform-prisma/client.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
  type PlatformTransaction,
  type PlatformSqlTransaction,
} from "../../shared/unit-of-work/platform-transaction.js";
import type { PlatformTransactionHost } from "../../shared/unit-of-work/unit-of-work.js";
import { assertVerifiedRequestSecurityContext } from "../../shared/security-context/request-security-context.js";
import type { SessionAuthenticationPort } from "../../modules/authorization/application/contracts/session-authorization-ports.js";
import type { AuthenticatedUserSession } from "../../modules/authorization/domain/session-access-grant.js";

export type PlatformProcessRole = "api" | "authorization" | "worker" | "admin" | "migrator";
export type PlatformCredentialClass = "api" | "authorization" | "worker" | "admin" | "migrator";

const ROLE_DEFAULTS = {
  api: { poolMax: 20, credentialClass: "api", identityEnv: "PLATFORM_DATABASE_API_ROLE" },
  authorization: {
    poolMax: 8,
    credentialClass: "authorization",
    identityEnv: "PLATFORM_DATABASE_AUTHORIZATION_ROLE",
  },
  worker: {
    poolMax: 8,
    credentialClass: "worker",
    identityEnv: "PLATFORM_DATABASE_WORKER_ROLE",
  },
  admin: {
    poolMax: 4,
    credentialClass: "admin",
    identityEnv: "PLATFORM_DATABASE_ADMIN_ROLE",
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
  extends PlatformDatabaseClient, PlatformTransactionHost, SessionAuthenticationPort {
  internalTransaction<Result>(
    operation: PlatformInternalOperation,
    work: (transaction: PlatformTransaction) => Promise<Result>,
  ): Promise<Result>;
  adminExecutionTransaction<Result>(
    fence: AdminExecutionTransactionFence,
    work: (transaction: PlatformTransaction) => Promise<Result>,
  ): Promise<Result>;
}

export interface AdminExecutionTransactionFence {
  readonly operation: string;
  readonly siteRef: string | null;
  readonly environment: string;
  readonly region: string;
  readonly makerRef: string;
  readonly makerGeneration: bigint;
  readonly makerAuthorizationEpoch: bigint;
  readonly checkerRef: string;
  readonly checkerGeneration: bigint;
  readonly checkerAuthorizationEpoch: bigint;
}

export type PlatformInternalOperation =
  | "authorization.feed.read"
  | "authorization.snapshot.create"
  | "authorization.retention"
  | "commerce.outbox.reconcile"
  | "site.runtime.consume"
  | "admin.execution.claim"
  | "admin.execution.retry"
  | "admin.terminalize";

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
          config.role,
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
    authenticateUserSession: async (input) => {
      const rows = await prisma.$queryRawUnsafe<
        Array<AuthenticatedUserSession & Record<string, unknown>>
      >(
        `SELECT identity_session.session_ref AS "identitySessionRef",
                identity_session.subject_ref AS "subjectRef", identity_session.site_ref AS "siteRef",
                subject.subject_generation::text AS "subjectGeneration",
                identity_session.session_epoch::text AS "identitySessionEpoch",
                subject.restriction_epoch::text AS "restrictionEpoch",
                identity_session.credential_epoch::text AS "credentialEpoch",
                identity_session.authentication_methods AS "authenticationMethods",
                identity_session.authenticated_at AS "authenticatedAt",
                identity_session.expires_at AS "expiresAt"
         FROM platform.authorization_identity_session identity_session
         JOIN platform.authorization_subject subject
           ON subject.subject_ref=identity_session.subject_ref AND subject.site_ref=identity_session.site_ref
         JOIN platform.authorization_site site ON site.site_ref=identity_session.site_ref
         WHERE identity_session.credential_digest=$1 AND identity_session.site_ref=$2
           AND identity_session.state='active' AND identity_session.expires_at>$3::timestamptz
           AND subject.state='active' AND site.state='active'
         LIMIT 1`,
        input.credentialDigest,
        input.siteRef,
        input.now,
      );
      const row = rows[0];
      if (row === undefined) return null;
      const methods = row.authenticationMethods;
      if (
        !Array.isArray(methods) ||
        methods.length < 1 ||
        methods.some((method) => !["password", "totp", "recovery_code"].includes(method))
      )
        return null;
      return Object.freeze({
        ...row,
        authenticationMethods: Object.freeze([...methods]),
        authenticatedAt: new Date(row.authenticatedAt).toISOString(),
        expiresAt: new Date(row.expiresAt).toISOString(),
      });
    },
    internalTransaction: async <Result>(
      operation: PlatformInternalOperation,
      work: (transaction: PlatformTransaction) => Promise<Result>,
    ) => {
      const allowed =
        config.role === "worker"
          ? operation === "authorization.retention" ||
            operation === "commerce.outbox.reconcile" ||
            operation === "site.runtime.consume" ||
            operation === "admin.execution.claim" ||
            operation === "admin.execution.retry" ||
            operation === "admin.terminalize"
          : config.role === "authorization" &&
            (operation === "authorization.feed.read" ||
              operation === "authorization.snapshot.create");
      if (!allowed) throw new Error("PLATFORM_INTERNAL_OPERATION_ROLE_FORBIDDEN");
      return prisma.$transaction(
        async (databaseTransaction) => {
          await databaseTransaction.$queryRawUnsafe(
            `SELECT set_config('app.operation',$1,true),
                  set_config('app.workload_kind',$2,true)`,
            operation,
            config.role === "worker" ? "platform_worker" : "platform_authorization",
          );
          const lease = issuePlatformTransaction({
            query: (statement, values = []) =>
              databaseTransaction.$queryRawUnsafe(statement, ...values),
            execute: (statement, values = []) =>
              databaseTransaction.$executeRawUnsafe(statement, ...values),
          });
          try {
            return await work(lease.transaction);
          } finally {
            revokePlatformTransaction(lease);
          }
        },
        {
          isolationLevel: config.transaction.isolationLevel,
          maxWait: config.transaction.maxWaitMs,
          timeout: config.transaction.timeoutMs,
        },
      );
    },
    adminExecutionTransaction: async <Result>(
      fence: AdminExecutionTransactionFence,
      work: (transaction: PlatformTransaction) => Promise<Result>,
    ) => {
      if (config.role !== "worker") throw new Error("ADMIN_EXECUTION_ROLE_FORBIDDEN");
      assertAdminExecutionFence(fence);
      return prisma.$transaction(
        async (databaseTransaction) => {
          await databaseTransaction.$queryRawUnsafe(
            `SELECT set_config('app.operation',$1,true),
                    set_config('app.site_id',$2,true),
                    set_config('app.environment',$3,true),
                    set_config('app.region',$4,true),
                    set_config('app.workload_kind','platform_worker',true),
                    set_config('app.actor_kind','operator',true),
                    set_config('app.subject_id',$5,true),
                    set_config('app.subject_generation',$6,true),
                    set_config('app.admin_execution','true',true),
                    set_config('app.admin_maker_ref',$7,true),
                    set_config('app.admin_maker_generation',$8,true),
                    set_config('app.admin_maker_authorization_epoch',$9,true),
                    set_config('app.admin_checker_authorization_epoch',$10,true)`,
            fence.operation,
            fence.siteRef ?? "",
            fence.environment,
            fence.region,
            fence.checkerRef,
            fence.checkerGeneration.toString(),
            fence.makerRef,
            fence.makerGeneration.toString(),
            fence.makerAuthorizationEpoch.toString(),
            fence.checkerAuthorizationEpoch.toString(),
          );
          const lease = issuePlatformTransaction({
            query: (statement, values = []) =>
              databaseTransaction.$queryRawUnsafe(statement, ...values),
            execute: (statement, values = []) =>
              databaseTransaction.$executeRawUnsafe(statement, ...values),
          });
          try {
            return await work(lease.transaction);
          } finally {
            revokePlatformTransaction(lease);
          }
        },
        {
          isolationLevel: config.transaction.isolationLevel,
          maxWait: config.transaction.maxWaitMs,
          timeout: config.transaction.timeoutMs,
        },
      );
    },
    transaction: async <Result>(
      fence: Parameters<PlatformTransactionHost["transaction"]>[0],
      work: Parameters<PlatformTransactionHost["transaction"]>[1],
    ) =>
      prisma.$transaction(
        async (databaseTransaction) => {
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
                  set_config('app.region', $10, true),
                  set_config('app.workload_kind', $11, true),
                  set_config('app.actor_kind', $12, true),
                  set_config('app.scopes', $13, true)`,
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
            context.trustedCaller.kind,
            context.actor.kind,
            JSON.stringify(context.target.scopes),
          );
          const sql: PlatformSqlTransaction = {
            query: (statement, values = []) =>
              databaseTransaction.$queryRawUnsafe(statement, ...values),
            execute: (statement, values = []) =>
              databaseTransaction.$executeRawUnsafe(statement, ...values),
          };
          const lease = issuePlatformTransaction(sql);
          try {
            return (await work(lease.transaction)) as Result;
          } finally {
            revokePlatformTransaction(lease);
          }
        },
        {
          isolationLevel: config.transaction.isolationLevel,
          maxWait: config.transaction.maxWaitMs,
          timeout: config.transaction.timeoutMs,
        },
      ),
  };
}

function assertAdminExecutionFence(fence: AdminExecutionTransactionFence): void {
  for (const value of [fence.operation, fence.environment, fence.region, fence.makerRef,
    fence.checkerRef]) {
    if (value.length < 1 || value.length > 128 || hasControlCharacter(value)) {
      throw new Error("ADMIN_EXECUTION_FENCE_INVALID");
    }
  }
  if (fence.siteRef !== null && (fence.siteRef.length < 1 || fence.siteRef.length > 128 ||
    hasControlCharacter(fence.siteRef))) {
    throw new Error("ADMIN_EXECUTION_FENCE_INVALID");
  }
  if (fence.makerRef === fence.checkerRef || fence.makerGeneration < 1n ||
    fence.makerAuthorizationEpoch < 1n || fence.checkerGeneration < 1n ||
    fence.checkerAuthorizationEpoch < 1n) {
    throw new Error("ADMIN_EXECUTION_FENCE_INVALID");
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127;
  });
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
  hasRequiredPlatformWrites: boolean;
  canExecuteModelInventoryImport: boolean;
  canExecuteModelInventoryActivate: boolean;
  canExecuteModelSitePolicyChange: boolean;
  canExecuteModelCandidatesProjection: boolean;
  canExecuteModelDecisionProjection: boolean;
  canExecuteModelAvailabilityReport: boolean;
  canExecuteCreditScopePolicy: boolean;
  canExecuteAdminAuthorityChange: boolean;
  hasRequiredModelOptionFunctions: boolean;
  canSelectModelCatalogTable: boolean;
  canReadModelSensitiveColumn: boolean;
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
         CASE WHEN $2 = 'api' THEN
           has_table_privilege(current_user, 'platform.command_receipt', 'INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.outbox_event', 'INSERT')
           AND has_table_privilege(current_user, 'platform.inbox_delivery', 'INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.model_selection_decision', 'INSERT')
           AND has_table_privilege(current_user, 'platform.authorization_subject', 'SELECT,INSERT')
           AND has_table_privilege(current_user, 'platform.authorization_identity_session', 'SELECT,INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.authorization_project', 'SELECT,INSERT')
           AND has_table_privilege(current_user, 'platform.authorization_project_membership', 'SELECT,INSERT')
           AND has_table_privilege(current_user, 'platform.authorization_product_context', 'SELECT,INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.authorization_session_access_grant', 'SELECT,INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.authorization_stream_state', 'SELECT,UPDATE')
           AND has_table_privilege(current_user, 'platform.authorization_event_log', 'INSERT')
           AND has_table_privilege(current_user, 'platform.identity_account', 'SELECT,INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.identity_verification_transaction', 'SELECT,INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.identity_auth_transaction', 'SELECT,INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.identity_reauthentication_challenge', 'SELECT,INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.identity_totp_authenticator', 'SELECT,INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.identity_recovery_code_set', 'SELECT,INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.identity_recovery_code', 'SELECT,INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.identity_auth_rate_limit', 'SELECT,INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.identity_totp_enrollment_transaction', 'SELECT,INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.identity_totp_enrollment_delivery_claim', 'SELECT,INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.identity_reauthentication_proof', 'SELECT,INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.identity_reauthentication_delivery_claim', 'SELECT,INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.identity_recovery_code_delivery_claim', 'SELECT,INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.identity_security_event', 'SELECT,INSERT')
           AND has_table_privilege(current_user, 'platform.identity_refresh_family', 'SELECT,INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.identity_session_delivery_claim', 'SELECT,INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.identity_personal_bootstrap', 'SELECT,INSERT')
           AND has_table_privilege(current_user, 'platform.commerce_command', 'SELECT,INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.commerce_billing_account', 'SELECT,INSERT')
           AND has_table_privilege(current_user, 'platform.commerce_billing_account_membership', 'SELECT,INSERT')
           AND has_table_privilege(current_user, 'platform.commerce_fulfillment_transaction', 'SELECT,INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.commerce_fulfillment_output_plan', 'SELECT,INSERT')
           AND has_table_privilege(current_user, 'platform.commerce_fulfillment_actual_output', 'SELECT,INSERT')
           AND has_table_privilege(current_user, 'platform.commerce_command_outbox', 'SELECT,INSERT')
           AND has_table_privilege(current_user, 'platform.commerce_audit_entry', 'SELECT,INSERT')
           AND has_table_privilege(current_user, 'platform.credit_account', 'SELECT,INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.credit_grant', 'SELECT,INSERT')
           AND has_table_privilege(current_user, 'platform.credit_hold', 'SELECT,INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.credit_hold_allocation', 'SELECT,INSERT')
           AND has_table_privilege(current_user, 'platform.credit_journal_transaction', 'SELECT,INSERT')
           AND has_table_privilege(current_user, 'platform.credit_journal_entry', 'SELECT,INSERT')
           AND has_table_privilege(current_user, 'platform.credit_execution_budget_root', 'SELECT,INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.credit_budget_allocation', 'SELECT,INSERT')
           AND has_table_privilege(current_user, 'platform.credit_budget_allocation_revision', 'SELECT,INSERT')
           AND has_table_privilege(current_user, 'platform.credit_authorization_segment', 'SELECT,INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.credit_budget_operation_receipt', 'SELECT,INSERT')
         WHEN $2 = 'worker' THEN
           has_table_privilege(current_user, 'platform.outbox_event', 'SELECT,UPDATE')
           AND has_table_privilege(current_user, 'platform.site', 'SELECT')
           AND has_any_column_privilege(current_user, 'platform.site', 'UPDATE')
           AND has_table_privilege(current_user, 'platform.site_project_binding', 'SELECT')
           AND has_table_privilege(current_user, 'platform.site_release', 'SELECT')
           AND has_any_column_privilege(current_user, 'platform.site_release', 'UPDATE')
           AND has_table_privilege(current_user, 'platform.site_deployment_binding', 'SELECT,INSERT')
           AND has_any_column_privilege(current_user, 'platform.site_deployment_binding', 'UPDATE')
           AND has_table_privilege(current_user, 'platform.site_activation_attempt', 'SELECT')
           AND has_any_column_privilege(current_user, 'platform.site_activation_attempt', 'UPDATE')
           AND has_table_privilege(current_user, 'platform.site_deployment_observation', 'SELECT,INSERT')
           AND has_table_privilege(current_user, 'platform.site_traffic_stop_attempt', 'SELECT')
           AND has_any_column_privilege(current_user, 'platform.site_traffic_stop_attempt', 'UPDATE')
           AND has_table_privilege(current_user, 'platform.site_traffic_stop_observation', 'SELECT,INSERT')
           AND has_table_privilege(current_user, 'platform.authorization_site', 'SELECT,INSERT')
           AND has_any_column_privilege(current_user, 'platform.authorization_site', 'UPDATE')
           AND has_table_privilege(current_user, 'platform.authorization_site_release', 'SELECT,INSERT')
           AND has_any_column_privilege(current_user, 'platform.authorization_site_release', 'UPDATE')
           AND has_table_privilege(current_user, 'platform.authorization_product_binding', 'SELECT,INSERT')
           AND has_any_column_privilege(current_user, 'platform.authorization_product_binding', 'UPDATE')
           AND has_table_privilege(current_user, 'platform.command_receipt', 'UPDATE')
           AND has_table_privilege(current_user, 'platform.inbox_delivery', 'INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.authorization_session_access_grant', 'SELECT')
           AND has_table_privilege(current_user, 'platform.admin_operator_authority', 'SELECT')
           AND has_table_privilege(current_user, 'platform.admin_approval', 'SELECT,UPDATE')
           AND has_table_privilege(current_user, 'platform.admin_post_effect_review', 'SELECT,UPDATE')
         WHEN $2 = 'authorization' THEN
           has_table_privilege(current_user, 'platform.authorization_stream_state', 'SELECT')
           AND has_table_privilege(current_user, 'platform.authorization_event_log', 'SELECT')
           AND has_table_privilege(current_user, 'platform.authorization_snapshot', 'SELECT,INSERT')
           AND has_table_privilege(current_user, 'platform.authorization_snapshot_record', 'SELECT,INSERT')
           AND has_table_privilege(current_user, 'platform.authorization_site', 'SELECT')
           AND has_table_privilege(current_user, 'platform.authorization_session_access_grant', 'SELECT')
         ELSE has_table_privilege(current_user, 'platform.command_receipt', 'SELECT,INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.outbox_event', 'SELECT,INSERT')
           AND has_table_privilege(current_user, 'platform.authorization_site', 'SELECT')
           AND has_table_privilege(current_user, 'platform.commerce_billing_account', 'SELECT,INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.commerce_billing_account_membership', 'SELECT,INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.site', 'SELECT,INSERT')
           AND has_any_column_privilege(current_user, 'platform.site', 'UPDATE')
           AND has_table_privilege(current_user, 'platform.site_project_binding', 'SELECT,INSERT')
           AND has_any_column_privilege(current_user, 'platform.site_project_binding', 'UPDATE')
           AND has_table_privilege(current_user, 'platform.site_release', 'SELECT,INSERT')
           AND has_any_column_privilege(current_user, 'platform.site_release', 'UPDATE')
           AND has_table_privilege(current_user, 'platform.site_activation_attempt', 'SELECT,INSERT')
           AND has_table_privilege(current_user, 'platform.site_deployment_binding', 'SELECT')
           AND has_any_column_privilege(current_user, 'platform.site_deployment_binding', 'UPDATE')
           AND has_table_privilege(current_user, 'platform.site_traffic_stop_attempt', 'SELECT,INSERT')
           AND has_table_privilege(current_user, 'platform.site_traffic_stop_observation', 'SELECT')
           AND has_table_privilege(current_user, 'platform.site_effect_approval', 'SELECT,INSERT')
           AND has_any_column_privilege(current_user, 'platform.site_effect_approval', 'UPDATE')
           AND has_any_column_privilege(current_user, 'platform.authorization_site', 'UPDATE')
           AND has_any_column_privilege(current_user, 'platform.authorization_product_binding', 'UPDATE')
           AND has_table_privilege(current_user, 'platform.admin_operator_authority', 'SELECT')
           AND has_table_privilege(current_user, 'platform.admin_command_decision', 'SELECT,INSERT')
           AND has_table_privilege(current_user, 'platform.admin_approval', 'SELECT,INSERT,UPDATE')
           AND has_table_privilege(current_user, 'platform.admin_approval_decision', 'SELECT,INSERT')
           AND has_table_privilege(current_user, 'platform.admin_post_effect_review', 'SELECT,INSERT,UPDATE')
         END AS "hasRequiredPlatformWrites",
         has_function_privilege(current_user, 'platform.import_model_inventory(uuid,text,text,jsonb,jsonb,text)', 'EXECUTE')
           AS "canExecuteModelInventoryImport",
         has_function_privilege(current_user, 'platform.activate_model_inventory(uuid,text,bigint,text)', 'EXECUTE')
           AS "canExecuteModelInventoryActivate",
         has_function_privilege(current_user, 'platform.put_model_site_policy(uuid,text,text,text,bigint)', 'EXECUTE')
           AS "canExecuteModelSitePolicyChange",
         has_function_privilege(current_user, 'platform.resolve_model_candidates(text,text,text)', 'EXECUTE')
           AS "canExecuteModelCandidatesProjection",
         has_function_privilege(current_user, 'platform.find_model_selection_decision(uuid)', 'EXECUTE')
           AS "canExecuteModelDecisionProjection",
         has_function_privilege(current_user, 'platform.report_model_provider_availability(uuid,text,text,text,bigint,text,timestamptz,text)', 'EXECUTE')
           AS "canExecuteModelAvailabilityReport",
         has_function_privilege(current_user, 'platform.valid_credit_scope_policy(jsonb)', 'EXECUTE')
           AS "canExecuteCreditScopePolicy",
         has_function_privilege(current_user, 'platform.apply_admin_authority_change(uuid,jsonb)', 'EXECUTE')
           AS "canExecuteAdminAuthorityChange",
         CASE WHEN $2='api' THEN
           has_function_privilege(current_user,'platform.resolve_product_model_option_catalog(text,text)','EXECUTE')
         WHEN $2='admin' THEN
           has_function_privilege(current_user,'platform.load_model_option_inventory(text)','EXECUTE')
           AND has_function_privilege(current_user,'platform.load_model_option_revisions(text[])','EXECUTE')
           AND has_function_privilege(current_user,'platform.materialize_legacy_model_options(uuid,text,text,text,text,jsonb,jsonb,text)','EXECUTE')
           AND has_function_privilege(current_user,'platform.publish_site_release_model_catalog(uuid,jsonb,text)','EXECUTE')
         ELSE TRUE END AS "hasRequiredModelOptionFunctions",
         EXISTS (
           SELECT 1 FROM pg_class model_relation
           WHERE model_relation.relnamespace=platform_schema.oid
             AND model_relation.relname=ANY(ARRAY[
               'model_inventory_import','model_inventory_activation','model_inventory_pointer','model_provider_snapshot',
               'model_definition_snapshot','model_provider_binding_snapshot','model_product_route_snapshot',
               'model_provider_availability','model_definition_availability','model_provider_availability_report','model_site_policy_revision',
               'model_site_assignment_revision','model_site_policy_pointer','model_selection_decision',
               'model_option_materialization','model_option_revision','model_option_materialized_revision',
               'model_option_role_binding','model_option_materialization_quarantine',
               'site_release_model_catalog_publication','site_release_model_catalog_surface',
               'site_release_model_catalog_option'
             ])
             AND has_table_privilege(current_user,model_relation.oid,'SELECT')
         ) AS "canSelectModelCatalogTable",
         (has_any_column_privilege(current_user,'platform.model_inventory_import','SELECT')
           OR has_any_column_privilege(current_user,'platform.model_provider_snapshot','SELECT'))
           AS "canReadModelSensitiveColumn",
         EXISTS (
           SELECT 1 FROM pg_class candidate
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
                 'authorization_session_access_grant','authorization_stream_state','authorization_event_log',
                 'authorization_snapshot','authorization_snapshot_record','model_option_materialization','model_option_revision',
                 'model_option_materialized_revision','model_option_role_binding',
               'model_option_materialization_quarantine','site_release_model_catalog_publication',
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
               'commerce_subscription_term_revocation','commerce_code_batch','commerce_redeem_code',
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
               'admin_operator_authority','admin_command_decision','admin_approval','admin_approval_decision',
               'admin_authority_bootstrap','admin_post_effect_review'
               ]) AND (
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
                 'authorization_session_access_grant','authorization_stream_state','authorization_event_log',
                 'authorization_snapshot','authorization_snapshot_record','model_option_materialization','model_option_revision',
                 'model_option_materialized_revision','model_option_role_binding',
               'model_option_materialization_quarantine','site_release_model_catalog_publication',
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
               'commerce_subscription_term_revocation','commerce_code_batch','commerce_redeem_code',
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
               'admin_operator_authority','admin_command_decision','admin_approval','admin_approval_decision',
               'admin_authority_bootstrap','admin_post_effect_review'
               ]) AND (
                 (candidate.relname LIKE 'model\\_%' ESCAPE '\\' AND (
                   has_table_privilege(runtime_role.rolname,candidate.oid,'SELECT')
                   OR has_any_column_privilege(runtime_role.rolname,candidate.oid,'SELECT')
                 ))
                 OR
                 ($2 = 'authorization' AND (
                   has_table_privilege(runtime_role.rolname,candidate.oid,'SELECT')
                   OR has_any_column_privilege(runtime_role.rolname,candidate.oid,'SELECT')
                 ) AND candidate.relname <> ALL(ARRAY[
                   'platform_foundation','authorization_stream_state','authorization_event_log',
                   'authorization_snapshot','authorization_snapshot_record','authorization_site',
                   'authorization_session_access_grant'
                 ]))
                 OR
                 ((has_table_privilege(runtime_role.rolname,candidate.oid,'SELECT')
                   OR has_any_column_privilege(runtime_role.rolname,candidate.oid,'SELECT'))
                  AND candidate.relname = ANY(ARRAY[
                    'site','site_project_binding','site_release','site_deployment_binding',
                    'site_activation_attempt','site_deployment_observation','site_traffic_stop_attempt',
                    'site_traffic_stop_observation','site_effect_approval'
                  ]) AND NOT (
                    ($2='worker' AND candidate.relname<>'site_effect_approval') OR $2='admin'
                  ))
                 OR
                 (has_table_privilege(runtime_role.rolname, candidate.oid,
                   'DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') AND NOT (
                   $2 = 'worker' AND candidate.relname = ANY(ARRAY[
                     'authorization_event_log','authorization_snapshot'
                   ])
                 ))
                 OR has_any_column_privilege(runtime_role.rolname, candidate.oid, 'REFERENCES')
                 OR (has_table_privilege(runtime_role.rolname, candidate.oid, 'INSERT') AND NOT (
                   ($2 = 'api' AND candidate.relname = ANY(ARRAY[
                     'command_receipt','outbox_event','inbox_delivery','model_selection_decision',
                     'authorization_product_context','authorization_session_access_grant','authorization_event_log',
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
                   OR ($2 = 'authorization' AND candidate.relname = ANY(ARRAY['authorization_snapshot','authorization_snapshot_record']))
                   OR ($2 = 'worker' AND candidate.relname = ANY(ARRAY[
                     'site_deployment_binding','site_deployment_observation',
                     'site_traffic_stop_observation','authorization_site',
                     'authorization_site_release','authorization_product_binding'
                   ]))
                   OR ($2 = 'admin' AND candidate.relname = ANY(ARRAY[
                     'command_receipt','outbox_event','commerce_billing_account','commerce_billing_account_membership',
                     'site','site_project_binding','site_release','site_activation_attempt',
                     'site_traffic_stop_attempt','site_effect_approval',
                     'admin_command_decision','admin_approval','admin_approval_decision',
                     'admin_post_effect_review'
                   ]))
                 ))
                 OR (has_table_privilege(runtime_role.rolname, candidate.oid, 'UPDATE') AND NOT (
                   ($2 = 'api' AND candidate.relname = ANY(ARRAY[
                     'command_receipt','inbox_delivery','authorization_identity_session','authorization_product_context',
                     'authorization_session_access_grant','authorization_stream_state','authorization_site',
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
                   OR ($2 = 'worker' AND candidate.relname = ANY(ARRAY[
                     'outbox_event','site','site_release','site_deployment_binding',
                     'site_activation_attempt','site_traffic_stop_attempt','authorization_site',
                     'authorization_site_release','authorization_product_binding'
                   ]))
                   OR ($2 = 'worker' AND candidate.relname = ANY(ARRAY[
                     'command_receipt','outbox_event','inbox_delivery','admin_approval',
                     'admin_post_effect_review'
                   ]))
                   OR ($2 = 'admin' AND candidate.relname = ANY(ARRAY[
                     'command_receipt','commerce_billing_account','commerce_billing_account_membership',
                     'site','site_project_binding','site_release','site_deployment_binding',
                     'site_effect_approval','authorization_site','authorization_product_binding',
                     'admin_approval','admin_post_effect_review'
                   ]))
                   OR ($2 = 'admin' AND candidate.relname = 'admin_approval')
                 ))
                 OR (has_any_column_privilege(runtime_role.rolname, candidate.oid, 'INSERT') AND NOT (
                   ($2 = 'api' AND candidate.relname = ANY(ARRAY[
                     'command_receipt','outbox_event','inbox_delivery','model_selection_decision',
                     'authorization_product_context','authorization_session_access_grant','authorization_event_log',
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
                   OR ($2 = 'authorization' AND candidate.relname = ANY(ARRAY['authorization_snapshot','authorization_snapshot_record']))
                   OR ($2 = 'worker' AND candidate.relname = ANY(ARRAY[
                     'site_deployment_binding','site_deployment_observation',
                     'site_traffic_stop_observation','authorization_site',
                     'authorization_site_release','authorization_product_binding'
                   ]))
                   OR ($2 = 'admin' AND candidate.relname = ANY(ARRAY[
                     'command_receipt','outbox_event','commerce_billing_account','commerce_billing_account_membership',
                     'site','site_project_binding','site_release','site_activation_attempt',
                     'site_traffic_stop_attempt','site_effect_approval',
                     'admin_command_decision','admin_approval','admin_approval_decision',
                     'admin_post_effect_review'
                   ]))
                 ))
                 OR (has_any_column_privilege(runtime_role.rolname, candidate.oid, 'UPDATE') AND NOT (
                   ($2 = 'api' AND candidate.relname = ANY(ARRAY[
                     'command_receipt','inbox_delivery','authorization_identity_session','authorization_product_context',
                     'authorization_session_access_grant','authorization_stream_state','authorization_site',
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
                   OR ($2 = 'worker' AND candidate.relname = ANY(ARRAY[
                     'outbox_event','site','site_release','site_deployment_binding',
                     'site_activation_attempt','site_traffic_stop_attempt','authorization_site',
                     'authorization_site_release','authorization_product_binding'
                   ]))
                   OR ($2 = 'worker' AND candidate.relname = ANY(ARRAY[
                     'command_receipt','outbox_event','inbox_delivery','admin_approval',
                     'admin_post_effect_review'
                   ]))
                   OR ($2 = 'admin' AND candidate.relname = ANY(ARRAY[
                     'command_receipt','commerce_billing_account','commerce_billing_account_membership',
                     'site','site_project_binding','site_release','site_deployment_binding',
                     'site_effect_approval','authorization_site','authorization_product_binding',
                     'admin_approval','admin_post_effect_review'
                   ]))
                   OR ($2 = 'admin' AND candidate.relname = 'admin_approval')
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
               ($2 = 'admin' AND candidate_function.oid = ANY(ARRAY[
                 to_regprocedure('platform.import_model_inventory(uuid,text,text,jsonb,jsonb,text)'),
                 to_regprocedure('platform.activate_model_inventory(uuid,text,bigint,text)'),
                 to_regprocedure('platform.put_model_site_policy(uuid,text,text,text,bigint)'),
                 to_regprocedure('platform.load_model_option_inventory(text)'),
                 to_regprocedure('platform.load_model_option_revisions(text[])'),
                 to_regprocedure('platform.materialize_legacy_model_options(uuid,text,text,text,text,jsonb,jsonb,text)'),
                 to_regprocedure('platform.publish_site_release_model_catalog(uuid,jsonb,text)'),
                 to_regprocedure('platform.valid_credit_scope_policy(jsonb)')
               ]))
               OR ($2 = 'api' AND candidate_function.oid = ANY(ARRAY[
                 to_regprocedure('platform.resolve_model_candidates(text,text,text)'),
                 to_regprocedure('platform.find_model_selection_decision(uuid)'),
                 to_regprocedure('platform.resolve_product_model_option_catalog(text,text)'),
                 to_regprocedure('platform.valid_credit_scope_policy(jsonb)')
               ]))
               OR ($2 = 'worker' AND candidate_function.oid = ANY(ARRAY[
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
    identity.hasRequiredPlatformWrites &&
    identity.canExecuteModelInventoryImport === (config.role === "admin") &&
    identity.canExecuteModelInventoryActivate === (config.role === "admin") &&
    identity.canExecuteModelSitePolicyChange === (config.role === "admin") &&
    identity.canExecuteModelCandidatesProjection === (config.role === "api") &&
    identity.canExecuteModelDecisionProjection === (config.role === "api") &&
    identity.canExecuteModelAvailabilityReport === (config.role === "worker") &&
    identity.canExecuteCreditScopePolicy === (config.role === "api" || config.role === "admin") &&
    identity.canExecuteAdminAuthorityChange === (config.role === "worker") &&
    identity.hasRequiredModelOptionFunctions &&
    !identity.canSelectModelCatalogTable &&
    !identity.canReadModelSensitiveColumn &&
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
