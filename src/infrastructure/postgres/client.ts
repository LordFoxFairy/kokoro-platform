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
import type { AdminQueryPermit } from
  "../../modules/admin/interfaces/connect/admin-query-service.js";
import type { AdminWorkloadAxes } from
  "../../modules/admin/application/services/admin-oidc-service.js";

export type PlatformProcessRole =
  | "api" | "admission" | "authorization" | "asset-data-plane" | "worker" | "admin" | "migrator";
export type PlatformCredentialClass =
  | "api" | "admission" | "authorization" | "asset-data-plane" | "worker" | "admin" | "migrator";

const ROLE_DEFAULTS = {
  api: { poolMax: 20, credentialClass: "api", identityEnv: "PLATFORM_DATABASE_API_ROLE" },
  admission: {
    poolMax: 12,
    credentialClass: "admission",
    identityEnv: "PLATFORM_DATABASE_ADMISSION_ROLE",
  },
  authorization: {
    poolMax: 8,
    credentialClass: "authorization",
    identityEnv: "PLATFORM_DATABASE_AUTHORIZATION_ROLE",
  },
  "asset-data-plane": {
    poolMax: 16,
    credentialClass: "asset-data-plane",
    identityEnv: "PLATFORM_DATABASE_ASSET_DATA_PLANE_ROLE",
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
  internalScopedTransaction<Result>(
    scope: Readonly<{
      operation: PlatformScopedInternalOperation;
      siteRef: string;
      environment: string;
      region: string;
      scopes: readonly ["asset:worker"];
    }>,
    work: (transaction: PlatformTransaction) => Promise<Result>,
  ): Promise<Result>;
  assetDataPlaneTransaction<Result>(
    fence: AssetDataPlaneTransactionFence,
    work: (transaction: PlatformTransaction) => Promise<Result>,
  ): Promise<Result>;
  adminExecutionTransaction<Result>(
    fence: AdminExecutionTransactionFence,
    work: (transaction: PlatformTransaction) => Promise<Result>,
  ): Promise<Result>;
  adminIdentityTransaction<Result>(
    fence: AdminIdentityTransactionFence,
    work: (transaction: PlatformTransaction) => Promise<Result>,
  ): Promise<Result>;
  adminQueryTransaction<Result>(
    permit: AdminQueryPermit,
    work: (transaction: PlatformTransaction) => Promise<Result>,
  ): Promise<Result>;
  adminSiteQueryTransaction<Result>(
    permit: AdminQueryPermit,
    siteRef: string,
    work: (transaction: PlatformTransaction) => Promise<Result>,
  ): Promise<Result>;
  adminAuthenticationTransaction<Result>(
    fence: Readonly<AdminWorkloadAxes & { credentialDigest: string }>,
    work: (transaction: PlatformTransaction) => Promise<Result>,
  ): Promise<Result>;
}

export interface AdminIdentityTransactionFence {
  readonly operation:
    | "admin.identity.begin"
    | "admin.identity.exchange"
    | "admin.identity.delivery.read";
  readonly workloadIdentityRef: string;
  readonly environment: string;
  readonly region: string;
  readonly managedDeviceRef: string;
  readonly audience: string;
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

export interface AssetDataPlaneTransactionFence {
  readonly operation: AssetDataPlaneOperation;
  readonly siteRef: string;
  readonly subjectRef: string;
  readonly subjectGeneration: string;
  readonly projectRef: string;
  readonly purpose: string;
  readonly capabilityEpoch: string;
  readonly expiresAt: string;
}

export type AssetDataPlaneOperation =
  | "asset.multipart.initiate"
  | "asset.multipart.put-part"
  | "asset.multipart.complete"
  | "asset.multipart.abort"
  | "asset.multipart.status";

export type PlatformInternalOperation =
  | "admission.command"
  | "capability.projection"
  | "asset.eligibility.check-active"
  | "asset.eligibility.resolve"
  | "authorization.feed.read"
  | "authorization.snapshot.create"
  | "authorization.retention"
  | "commerce.outbox.reconcile"
  | "identity.outbox.consume"
  | "asset.outbox.consume"
  | "site.runtime.consume"
  | "admin.execution.claim"
  | "admin.execution.retry"
  | "admin.terminalize";
export type PlatformScopedInternalOperation =
  | "asset.upload-completion.observe"
  | "asset.scan.evaluate"
  | "asset.promotion.finalize"
  | "asset.cleanup.delete";

export function loadPlatformDatabaseConfig(
  role: PlatformProcessRole,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PlatformDatabaseConfig {
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
          throw new Error(
            `PLATFORM_RUNTIME_DATABASE_ROLE_INVALID:${JSON.stringify(rows[0] ?? null)}`,
          );
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
      const allowed = config.role === "admission"
        ? operation === "admission.command" || operation === "asset.eligibility.check-active" ||
          operation === "asset.eligibility.resolve"
        : config.role === "worker"
          ? operation === "authorization.retention" ||
            operation === "commerce.outbox.reconcile" ||
            operation === "identity.outbox.consume" ||
            operation === "asset.outbox.consume" ||
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
            config.role === "worker"
              ? "platform_worker"
              : config.role === "admission"
                ? "platform_admission"
                : "platform_authorization",
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
    internalScopedTransaction: async <Result>(scope: Readonly<{
      operation: PlatformScopedInternalOperation;
      siteRef: string;
      environment: string;
      region: string;
      scopes: readonly ["asset:worker"];
    }>, work: (transaction: PlatformTransaction) => Promise<Result>) => {
      if (config.role !== "worker" || !new Set<PlatformScopedInternalOperation>([
        "asset.upload-completion.observe", "asset.scan.evaluate", "asset.promotion.finalize",
        "asset.cleanup.delete",
      ]).has(scope.operation) ||
          scope.scopes.length !== 1 || scope.scopes[0] !== "asset:worker") {
        throw new Error("PLATFORM_SCOPED_INTERNAL_OPERATION_ROLE_FORBIDDEN");
      }
      scopedIdentifier(scope.siteRef, "PLATFORM_INTERNAL_SITE_INVALID");
      scopedIdentifier(scope.environment, "PLATFORM_INTERNAL_ENVIRONMENT_INVALID");
      scopedIdentifier(scope.region, "PLATFORM_INTERNAL_REGION_INVALID");
      return prisma.$transaction(async (databaseTransaction) => {
        await databaseTransaction.$queryRawUnsafe(
          `SELECT set_config('app.operation',$1,true),set_config('app.site_id',$2,true),
                  set_config('app.environment',$3,true),set_config('app.region',$4,true),
                  set_config('app.workload_kind','platform_worker',true),
                  set_config('app.actor_kind','workload',true),
                  set_config('app.subject_id','',true),set_config('app.scopes',$5,true)`,
          scope.operation, scope.siteRef, scope.environment, scope.region,
          JSON.stringify(scope.scopes),
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
      }, {
        isolationLevel: config.transaction.isolationLevel,
        maxWait: config.transaction.maxWaitMs,
        timeout: config.transaction.timeoutMs,
      });
    },
    assetDataPlaneTransaction: async <Result>(
      fence: AssetDataPlaneTransactionFence,
      work: (transaction: PlatformTransaction) => Promise<Result>,
    ) => {
      if (config.role !== "asset-data-plane") throw new Error("ASSET_DATA_PLANE_ROLE_FORBIDDEN");
      assertAssetDataPlaneFence(fence);
      return prisma.$transaction(async (databaseTransaction) => {
        await databaseTransaction.$queryRawUnsafe(
          `SELECT set_config('app.operation',$1,true),set_config('app.site_id',$2,true),
                  set_config('app.subject_id',$3,true),set_config('app.subject_generation',$4,true),
                  set_config('app.project_id',$5,true),set_config('app.purpose',$6,true),
                  set_config('app.policy_epoch',$7,true),
                  set_config('app.workload_kind','site_product',true),
                  set_config('app.actor_kind','user',true),
                  set_config('app.scopes','["asset:upload"]',true)`,
          fence.operation, fence.siteRef, fence.subjectRef, fence.subjectGeneration,
          fence.projectRef, fence.purpose, fence.capabilityEpoch,
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
      }, {
        isolationLevel: config.transaction.isolationLevel,
        maxWait: config.transaction.maxWaitMs,
        timeout: config.transaction.timeoutMs,
      });
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
    adminIdentityTransaction: async <Result>(
      fence: AdminIdentityTransactionFence,
      work: (transaction: PlatformTransaction) => Promise<Result>,
    ) => {
      if (config.role !== "admin") throw new Error("ADMIN_IDENTITY_ROLE_FORBIDDEN");
      assertAdminIdentityFence(fence);
      return prisma.$transaction(
        async (databaseTransaction) => {
          await databaseTransaction.$queryRawUnsafe(
            `SELECT set_config('app.operation',$1,true),
                    set_config('app.workload_identity_ref',$2,true),
                    set_config('app.environment',$3,true),
                    set_config('app.region',$4,true),
                    set_config('app.managed_device_ref',$5,true),
                    set_config('app.audience',$6,true),
                    set_config('app.workload_kind','platform_admin',true),
                    set_config('app.actor_kind','workload',true),
                    set_config('app.site_id','',true),
                    set_config('app.subject_id','',true),
                    set_config('app.scopes','[]',true)`,
            fence.operation,
            fence.workloadIdentityRef,
            fence.environment,
            fence.region,
            fence.managedDeviceRef,
            fence.audience,
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
    adminQueryTransaction: async <Result>(
      permit: AdminQueryPermit,
      work: (transaction: PlatformTransaction) => Promise<Result>,
    ) => {
      if (config.role !== "admin") throw new Error("ADMIN_QUERY_ROLE_FORBIDDEN");
      assertAdminQueryPermit(permit);
      const siteRefs = permit.scope.kind === "site"
        ? permit.scope.siteRefs
        : permit.scope.kind === "breakglass" ? permit.scope.resourceRefs : [];
      return prisma.$transaction(async (databaseTransaction) => {
        await databaseTransaction.$queryRawUnsafe(
          `SELECT set_config('app.operation',$1,true),set_config('app.environment',$2,true),
                  set_config('app.region',$3,true),set_config('app.workload_kind','platform_admin',true),
                  set_config('app.actor_kind','operator',true),set_config('app.subject_id',$4,true),
                  set_config('app.admin_scope_kind',$5,true),
                  set_config('app.admin_site_refs',$6,true),set_config('app.site_id','',true),
                  set_config('app.scopes',$7,true)`,
          permit.operation, permit.environment, permit.region, permit.operatorRef,
          permit.scope.kind, JSON.stringify(siteRefs), JSON.stringify([`admin:${permit.operation}`]),
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
      }, {
        isolationLevel: config.transaction.isolationLevel,
        maxWait: config.transaction.maxWaitMs,
        timeout: config.transaction.timeoutMs,
      });
    },
    adminSiteQueryTransaction: async <Result>(
      permit: AdminQueryPermit,
      siteRef: string,
      work: (transaction: PlatformTransaction) => Promise<Result>,
    ) => {
      if (config.role !== "admin") throw new Error("ADMIN_QUERY_ROLE_FORBIDDEN");
      assertAdminQueryPermit(permit);
      assertAdminSiteQueryPermit(permit, siteRef);
      const siteRefs = permit.scope.kind === "site"
        ? permit.scope.siteRefs
        : permit.scope.kind === "breakglass" ? permit.scope.resourceRefs : [];
      return prisma.$transaction(async (databaseTransaction) => {
        await databaseTransaction.$queryRawUnsafe(
          `SELECT set_config('app.operation',$1,true),set_config('app.environment',$2,true),
                  set_config('app.region',$3,true),set_config('app.workload_kind','platform_admin',true),
                  set_config('app.actor_kind','operator',true),set_config('app.subject_id',$4,true),
                  set_config('app.admin_scope_kind',$5,true),set_config('app.admin_site_refs',$6,true),
                  set_config('app.site_id',$7,true),set_config('app.scopes',$8,true)`,
          permit.operation, permit.environment, permit.region, permit.operatorRef,
          permit.scope.kind, JSON.stringify(siteRefs), siteRef,
          JSON.stringify([`admin:${permit.operation}`]),
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
      }, {
        isolationLevel: config.transaction.isolationLevel,
        maxWait: config.transaction.maxWaitMs,
        timeout: config.transaction.timeoutMs,
      });
    },
    adminAuthenticationTransaction: async <Result>(
      fence: Readonly<AdminWorkloadAxes & { credentialDigest: string }>,
      work: (transaction: PlatformTransaction) => Promise<Result>,
    ) => {
      if (config.role !== "admin") throw new Error("ADMIN_AUTHENTICATION_ROLE_FORBIDDEN");
      assertAdminIdentityFence({ operation: "admin.identity.delivery.read", ...fence });
      if (!/^[a-f0-9]{64}$/u.test(fence.credentialDigest)) {
        throw new Error("ADMIN_AUTHENTICATION_FENCE_INVALID");
      }
      return prisma.$transaction(async (databaseTransaction) => {
        await databaseTransaction.$queryRawUnsafe(
          `SELECT set_config('app.operation','admin.session.authenticate',true),
                  set_config('app.workload_identity_ref',$1,true),
                  set_config('app.environment',$2,true),set_config('app.region',$3,true),
                  set_config('app.managed_device_ref',$4,true),set_config('app.audience',$5,true),
                  set_config('app.workload_kind','platform_admin',true),
                  set_config('app.actor_kind','operator',true),set_config('app.subject_id','',true),
                  set_config('app.site_id','',true),set_config('app.scopes','[]',true)`,
          fence.workloadIdentityRef, fence.environment, fence.region,
          fence.managedDeviceRef, fence.audience,
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
      }, {
        isolationLevel: config.transaction.isolationLevel,
        maxWait: config.transaction.maxWaitMs,
        timeout: config.transaction.timeoutMs,
      });
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

function assertAdminIdentityFence(fence: AdminIdentityTransactionFence): void {
  const operations = new Set<AdminIdentityTransactionFence["operation"]>([
    "admin.identity.begin", "admin.identity.exchange", "admin.identity.delivery.read",
  ]);
  if (!operations.has(fence.operation) || !fence.workloadIdentityRef.startsWith("spiffe://")) {
    throw new Error("ADMIN_IDENTITY_FENCE_INVALID");
  }
  for (const value of [fence.workloadIdentityRef, fence.environment, fence.region,
    fence.managedDeviceRef, fence.audience]) {
    if (value.length < 1 || value.length > 256 || hasControlCharacter(value)) {
      throw new Error("ADMIN_IDENTITY_FENCE_INVALID");
    }
  }
}

function assertAdminQueryPermit(permit: AdminQueryPermit): void {
  if (!new Set<AdminQueryPermit["operation"]>([
    "admin.site.read", "admin.site.list", "admin.user.read", "admin.audit.read",
    "admin.operator.self.read", "admin.operator.read", "admin.operator.list", "admin.approval.list",
    "commerce.credit-program.read", "commerce.entitlement-template.read",
    "commerce.offer.read", "commerce.redemption-program.read", "commerce.code-batch.read",
    "credit.summary.read", "credit.account.read", "credit.grant.read", "credit.hold.read",
    "credit.journal.read", "credit.rated-usage.read",
    "model.inventory.read", "model.option.read", "model.site-policy.read",
    "model.site-release-catalog.read",
  ]).has(permit.operation)) throw new Error("ADMIN_QUERY_PERMIT_INVALID");
  for (const value of [permit.operatorRef, permit.environment, permit.region]) {
    if (value.length < 1 || value.length > 128 || hasControlCharacter(value)) {
      throw new Error("ADMIN_QUERY_PERMIT_INVALID");
    }
  }
  if (permit.scope.kind === "site" && (permit.scope.siteRefs.length < 1 ||
      permit.scope.siteRefs.length > 100 || permit.scope.siteRefs.some((value) =>
        value === "*" || value.length < 1 || value.length > 128 || hasControlCharacter(value)))) {
    throw new Error("ADMIN_QUERY_PERMIT_INVALID");
  }
  if (permit.scope.kind === "breakglass" && permit.scope.resourceRefs.length < 1) {
    throw new Error("ADMIN_QUERY_PERMIT_INVALID");
  }
}

function assertAdminSiteQueryPermit(permit: AdminQueryPermit, siteRef: string): void {
  scopedIdentifier(siteRef, "ADMIN_QUERY_SITE_INVALID");
  if ((permit.scope.kind === "site" && !permit.scope.siteRefs.includes(siteRef)) ||
      (permit.scope.kind === "breakglass" && !permit.scope.resourceRefs.includes(siteRef))) {
    throw new Error("ADMIN_QUERY_SITE_SCOPE_DENIED");
  }
}

function assertAssetDataPlaneFence(value: AssetDataPlaneTransactionFence): void {
  const operations = new Set<AssetDataPlaneOperation>([
    "asset.multipart.initiate", "asset.multipart.put-part", "asset.multipart.complete",
    "asset.multipart.abort", "asset.multipart.status",
  ]);
  if (!operations.has(value.operation) ||
      !/^[1-9][0-9]{0,19}$/u.test(value.subjectGeneration) ||
      !/^[1-9][0-9]{0,19}$/u.test(value.capabilityEpoch) ||
      !Number.isFinite(Date.parse(value.expiresAt)) || Date.now() >= Date.parse(value.expiresAt)) {
    throw new Error("ASSET_DATA_PLANE_FENCE_INVALID");
  }
  for (const field of [value.siteRef, value.subjectRef, value.projectRef, value.purpose]) {
    if (field.length < 1 || field.length > 256 || hasControlCharacter(field)) {
      throw new Error("ASSET_DATA_PLANE_FENCE_INVALID");
    }
  }
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

function scopedIdentifier(value: string, code: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value)) throw new Error(code);
}

function sqlLiterals(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(",");
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
  hasIdentityOutboxConsumerAuthority: boolean;
  canExecuteModelInventoryImport: boolean;
  canExecuteModelInventoryActivate: boolean;
  canExecuteModelSitePolicyChange: boolean;
  canExecuteModelCandidatesProjection: boolean;
  canExecuteModelDecisionProjection: boolean;
  canExecuteModelAvailabilityReport: boolean;
  canExecuteCreditScopePolicy: boolean;
  canExecuteCommerceSafeLabel: boolean;
  canExecuteCommerceIanaZone: boolean;
  canReadCommerceCatalogEpoch: boolean;
  canUpdateCommerceCatalogEpoch: boolean;
  canExecuteAdminAuthorityChange: boolean;
  hasRequiredModelOptionFunctions: boolean;
  canSelectModelCatalogTable: boolean;
  canReadModelSensitiveColumn: boolean;
  unexpectedPlatformRelations: readonly string[];
  unexpectedPlatformFunctions: readonly string[];
}

const ASSET_RELATIONS = [
  "asset_upload_intent", "asset_upload_session", "asset_quota_account",
  "asset_quota_reservation", "asset_multipart_upload", "asset_multipart_part",
  "asset_blob_candidate", "asset_cleanup_group",
  "asset_object_cleanup", "asset_object_cleanup_receipt", "asset_upload_rejection",
  "asset_scan_evaluation", "asset_promotion_intent", "asset_blob", "asset_resource",
  "asset_version", "asset_reference", "asset_eligibility_projection", "asset_promotion_receipt",
] as const;
const ASSET_API_RELATIONS = [
  "asset_upload_intent", "asset_upload_session", "asset_quota_account",
  "asset_quota_reservation", "asset_blob_candidate", "asset_upload_rejection",
  "asset_promotion_intent", "asset_resource", "asset_version", "asset_eligibility_projection",
] as const;
const ASSET_API_MUTABLE_RELATIONS = ASSET_API_RELATIONS.slice(0, 4);
const ASSET_API_OWNER_READ_RELATIONS = ASSET_API_RELATIONS.slice(4);
const ASSET_DATA_PLANE_RELATIONS = [
  "asset_upload_intent", "asset_upload_session", "asset_multipart_upload", "asset_multipart_part",
] as const;
const ASSET_DATA_PLANE_MUTABLE_RELATIONS = [
  "asset_upload_session", "asset_multipart_upload", "asset_multipart_part",
] as const;
const ASSET_WORKER_INSERT_RELATIONS = ASSET_RELATIONS.slice(6);
const ASSET_WORKER_UPDATE_RELATIONS = [
  "asset_upload_intent", "asset_upload_session", "asset_quota_account",
  "asset_quota_reservation", "asset_blob_candidate", "asset_cleanup_group",
  "asset_object_cleanup", "asset_promotion_intent",
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
  "credit_rating_policy_revision", "credit_rating_snapshot", "credit_usage_attempt_intent",
  "credit_attempt_usage_evidence", "credit_usage_segment_closure",
  "credit_usage_closure_evidence", "credit_usage_settlement", "credit_rated_usage",
  "credit_usage_settlement_source", "credit_usage_variance",
  "credit_usage_reconciliation", "credit_usage_command_receipt",
] as const;
const MODEL_GATEWAY_ADMISSION_RELATIONS = ["model_gateway_execution_authorization"] as const;
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
const ASSET_DATA_PLANE_RELATIONS_SQL = sqlLiterals(ASSET_DATA_PLANE_RELATIONS);
const ASSET_DATA_PLANE_MUTABLE_RELATIONS_SQL = sqlLiterals(ASSET_DATA_PLANE_MUTABLE_RELATIONS);
const ASSET_WORKER_INSERT_RELATIONS_SQL = sqlLiterals(ASSET_WORKER_INSERT_RELATIONS);
const ASSET_WORKER_UPDATE_RELATIONS_SQL = sqlLiterals(ASSET_WORKER_UPDATE_RELATIONS);
const ADMISSION_RELATIONS_SQL = sqlLiterals(ADMISSION_RELATIONS);
const ADMISSION_SELECT_RELATIONS_SQL = sqlLiterals(ADMISSION_SELECT_RELATIONS);
const ADMISSION_INSERT_RELATIONS_SQL = sqlLiterals(ADMISSION_INSERT_RELATIONS);
const ADMISSION_UPDATE_RELATIONS_SQL = sqlLiterals(ADMISSION_UPDATE_RELATIONS);
const CREDIT_USAGE_RELATIONS_SQL = sqlLiterals(CREDIT_USAGE_RELATIONS);
const MODEL_GATEWAY_ADMISSION_RELATIONS_SQL = sqlLiterals(MODEL_GATEWAY_ADMISSION_RELATIONS);

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
           (has_table_privilege(current_user, 'platform.command_receipt', 'INSERT') AND has_table_privilege(current_user, 'platform.command_receipt', 'UPDATE'))
           AND has_table_privilege(current_user, 'platform.outbox_event', 'INSERT')
           AND (has_table_privilege(current_user, 'platform.inbox_delivery', 'INSERT') AND has_table_privilege(current_user, 'platform.inbox_delivery', 'UPDATE'))
           AND has_table_privilege(current_user, 'platform.model_selection_decision', 'INSERT')
           AND (has_table_privilege(current_user, 'platform.authorization_subject', 'SELECT') AND has_table_privilege(current_user, 'platform.authorization_subject', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.authorization_identity_session', 'SELECT') AND has_table_privilege(current_user, 'platform.authorization_identity_session', 'INSERT') AND has_table_privilege(current_user, 'platform.authorization_identity_session', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.authorization_project', 'SELECT') AND has_table_privilege(current_user, 'platform.authorization_project', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.authorization_project_membership', 'SELECT') AND has_table_privilege(current_user, 'platform.authorization_project_membership', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.authorization_product_context', 'SELECT') AND has_table_privilege(current_user, 'platform.authorization_product_context', 'INSERT') AND has_table_privilege(current_user, 'platform.authorization_product_context', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.authorization_session_access_grant', 'SELECT') AND has_table_privilege(current_user, 'platform.authorization_session_access_grant', 'INSERT') AND has_table_privilege(current_user, 'platform.authorization_session_access_grant', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.authorization_scoped_stream_state', 'SELECT') AND has_table_privilege(current_user, 'platform.authorization_scoped_stream_state', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.authorization_scoped_site_cursor', 'SELECT') AND has_table_privilege(current_user, 'platform.authorization_scoped_site_cursor', 'INSERT') AND has_table_privilege(current_user, 'platform.authorization_scoped_site_cursor', 'UPDATE'))
           AND has_table_privilege(current_user, 'platform.authorization_scoped_event_log', 'INSERT')
           AND (has_table_privilege(current_user, 'platform.identity_account', 'SELECT') AND has_table_privilege(current_user, 'platform.identity_account', 'INSERT') AND has_table_privilege(current_user, 'platform.identity_account', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.identity_verification_transaction', 'SELECT') AND has_table_privilege(current_user, 'platform.identity_verification_transaction', 'INSERT') AND has_table_privilege(current_user, 'platform.identity_verification_transaction', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.identity_auth_transaction', 'SELECT') AND has_table_privilege(current_user, 'platform.identity_auth_transaction', 'INSERT') AND has_table_privilege(current_user, 'platform.identity_auth_transaction', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.identity_reauthentication_challenge', 'SELECT') AND has_table_privilege(current_user, 'platform.identity_reauthentication_challenge', 'INSERT') AND has_table_privilege(current_user, 'platform.identity_reauthentication_challenge', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.identity_totp_authenticator', 'SELECT') AND has_table_privilege(current_user, 'platform.identity_totp_authenticator', 'INSERT') AND has_table_privilege(current_user, 'platform.identity_totp_authenticator', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.identity_recovery_code_set', 'SELECT') AND has_table_privilege(current_user, 'platform.identity_recovery_code_set', 'INSERT') AND has_table_privilege(current_user, 'platform.identity_recovery_code_set', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.identity_recovery_code', 'SELECT') AND has_table_privilege(current_user, 'platform.identity_recovery_code', 'INSERT') AND has_table_privilege(current_user, 'platform.identity_recovery_code', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.identity_auth_rate_limit', 'SELECT') AND has_table_privilege(current_user, 'platform.identity_auth_rate_limit', 'INSERT') AND has_table_privilege(current_user, 'platform.identity_auth_rate_limit', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.identity_totp_enrollment_transaction', 'SELECT') AND has_table_privilege(current_user, 'platform.identity_totp_enrollment_transaction', 'INSERT') AND has_table_privilege(current_user, 'platform.identity_totp_enrollment_transaction', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.identity_totp_enrollment_delivery_claim', 'SELECT') AND has_table_privilege(current_user, 'platform.identity_totp_enrollment_delivery_claim', 'INSERT') AND has_table_privilege(current_user, 'platform.identity_totp_enrollment_delivery_claim', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.identity_reauthentication_proof', 'SELECT') AND has_table_privilege(current_user, 'platform.identity_reauthentication_proof', 'INSERT') AND has_table_privilege(current_user, 'platform.identity_reauthentication_proof', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.identity_reauthentication_delivery_claim', 'SELECT') AND has_table_privilege(current_user, 'platform.identity_reauthentication_delivery_claim', 'INSERT') AND has_table_privilege(current_user, 'platform.identity_reauthentication_delivery_claim', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.identity_recovery_code_delivery_claim', 'SELECT') AND has_table_privilege(current_user, 'platform.identity_recovery_code_delivery_claim', 'INSERT') AND has_table_privilege(current_user, 'platform.identity_recovery_code_delivery_claim', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.identity_security_event', 'SELECT') AND has_table_privilege(current_user, 'platform.identity_security_event', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.identity_refresh_family', 'SELECT') AND has_table_privilege(current_user, 'platform.identity_refresh_family', 'INSERT') AND has_table_privilege(current_user, 'platform.identity_refresh_family', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.identity_session_delivery_claim', 'SELECT') AND has_table_privilege(current_user, 'platform.identity_session_delivery_claim', 'INSERT') AND has_table_privilege(current_user, 'platform.identity_session_delivery_claim', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.identity_personal_bootstrap', 'SELECT') AND has_table_privilege(current_user, 'platform.identity_personal_bootstrap', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.commerce_command', 'SELECT') AND has_table_privilege(current_user, 'platform.commerce_command', 'INSERT') AND has_table_privilege(current_user, 'platform.commerce_command', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.commerce_billing_account', 'SELECT') AND has_table_privilege(current_user, 'platform.commerce_billing_account', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.commerce_billing_account_membership', 'SELECT') AND has_table_privilege(current_user, 'platform.commerce_billing_account_membership', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.commerce_fulfillment_transaction', 'SELECT') AND has_table_privilege(current_user, 'platform.commerce_fulfillment_transaction', 'INSERT') AND has_table_privilege(current_user, 'platform.commerce_fulfillment_transaction', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.commerce_fulfillment_output_plan', 'SELECT') AND has_table_privilege(current_user, 'platform.commerce_fulfillment_output_plan', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.commerce_fulfillment_actual_output', 'SELECT') AND has_table_privilege(current_user, 'platform.commerce_fulfillment_actual_output', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.commerce_command_outbox', 'SELECT') AND has_table_privilege(current_user, 'platform.commerce_command_outbox', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.commerce_audit_entry', 'SELECT') AND has_table_privilege(current_user, 'platform.commerce_audit_entry', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.credit_account', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_account', 'INSERT') AND has_table_privilege(current_user, 'platform.credit_account', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.credit_grant', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_grant', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.credit_hold', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_hold', 'INSERT') AND has_table_privilege(current_user, 'platform.credit_hold', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.credit_hold_allocation', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_hold_allocation', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.credit_journal_transaction', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_journal_transaction', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.credit_journal_entry', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_journal_entry', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.credit_execution_budget_root', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_execution_budget_root', 'INSERT') AND has_table_privilege(current_user, 'platform.credit_execution_budget_root', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.credit_budget_allocation', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_budget_allocation', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.credit_budget_allocation_revision', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_budget_allocation_revision', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.credit_authorization_segment', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_authorization_segment', 'INSERT') AND has_table_privilege(current_user, 'platform.credit_authorization_segment', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.credit_budget_operation_receipt', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_budget_operation_receipt', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.asset_upload_intent', 'SELECT') AND has_table_privilege(current_user, 'platform.asset_upload_intent', 'INSERT') AND has_table_privilege(current_user, 'platform.asset_upload_intent', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.asset_upload_session', 'SELECT') AND has_table_privilege(current_user, 'platform.asset_upload_session', 'INSERT') AND has_table_privilege(current_user, 'platform.asset_upload_session', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.asset_quota_account', 'SELECT') AND has_table_privilege(current_user, 'platform.asset_quota_account', 'INSERT') AND has_table_privilege(current_user, 'platform.asset_quota_account', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.asset_quota_reservation', 'SELECT') AND has_table_privilege(current_user, 'platform.asset_quota_reservation', 'INSERT') AND has_table_privilege(current_user, 'platform.asset_quota_reservation', 'UPDATE'))
           AND has_column_privilege(current_user, 'platform.asset_blob_candidate', 'site_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_blob_candidate', 'subject_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_blob_candidate', 'subject_generation', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_blob_candidate', 'project_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_blob_candidate', 'intent_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_blob_candidate', 'state', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_blob_candidate', 'updated_at', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_upload_rejection', 'site_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_upload_rejection', 'intent_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_upload_rejection', 'rejection_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_promotion_intent', 'site_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_promotion_intent', 'subject_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_promotion_intent', 'subject_generation', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_promotion_intent', 'project_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_promotion_intent', 'intent_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_promotion_intent', 'state', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_promotion_intent', 'updated_at', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_resource', 'site_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_resource', 'subject_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_resource', 'subject_generation', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_resource', 'project_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_resource', 'asset_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_resource', 'purpose', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_resource', 'state', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_version', 'site_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_version', 'asset_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_version', 'asset_version_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_version', 'source_upload_intent_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_version', 'eligibility_epoch', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_version', 'detected_media_type', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_version', 'size', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_version', 'state', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_eligibility_projection', 'site_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_eligibility_projection', 'asset_version_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_eligibility_projection', 'eligibility_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_eligibility_projection', 'subject_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_eligibility_projection', 'subject_generation', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_eligibility_projection', 'project_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_eligibility_projection', 'purpose', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_eligibility_projection', 'eligibility_epoch', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_eligibility_projection', 'state', 'SELECT')
         WHEN $2 = 'admission' THEN
           (has_table_privilege(current_user, 'platform.admission_command', 'SELECT') AND has_table_privilege(current_user, 'platform.admission_command', 'INSERT') AND has_table_privilege(current_user, 'platform.admission_command', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.capability_projection_command', 'SELECT') AND has_table_privilege(current_user, 'platform.capability_projection_command', 'INSERT'))
           AND has_column_privilege(current_user, 'platform.capability_projection_command', 'state', 'UPDATE')
           AND has_column_privilege(current_user, 'platform.capability_projection_command', 'agent_catalog_ref', 'UPDATE')
           AND has_column_privilege(current_user, 'platform.capability_projection_command', 'updated_at', 'UPDATE')
           AND (has_table_privilege(current_user, 'platform.admission_session_execution_binding', 'SELECT') AND has_table_privilege(current_user, 'platform.admission_session_execution_binding', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.admission_execution_manifest', 'SELECT') AND has_table_privilege(current_user, 'platform.admission_execution_manifest', 'INSERT') AND has_table_privilege(current_user, 'platform.admission_execution_manifest', 'UPDATE'))
           AND has_table_privilege(current_user, 'platform.admission_launch_profile_snapshot', 'SELECT')
           AND (has_table_privilege(current_user, 'platform.admission_capability_catalog_snapshot', 'SELECT') AND has_table_privilege(current_user, 'platform.admission_capability_catalog_snapshot', 'INSERT'))
           AND has_table_privilege(current_user, 'platform.outbox_event', 'INSERT')
           AND has_table_privilege(current_user, 'platform.site', 'SELECT')
           AND has_table_privilege(current_user, 'platform.site_release', 'SELECT')
           AND has_table_privilege(current_user, 'platform.authorization_site', 'SELECT')
           AND has_table_privilege(current_user, 'platform.authorization_site_release', 'SELECT')
           AND has_table_privilege(current_user, 'platform.authorization_product_binding', 'SELECT')
           AND has_table_privilege(current_user, 'platform.authorization_subject', 'SELECT')
           AND has_table_privilege(current_user, 'platform.authorization_identity_session', 'SELECT')
           AND has_table_privilege(current_user, 'platform.authorization_project', 'SELECT')
           AND has_table_privilege(current_user, 'platform.authorization_project_membership', 'SELECT')
           AND has_table_privilege(current_user, 'platform.authorization_session_access_grant', 'SELECT')
           AND has_table_privilege(current_user, 'platform.identity_personal_bootstrap', 'SELECT')
           AND has_table_privilege(current_user, 'platform.identity_execution_space', 'SELECT')
           AND has_table_privilege(current_user, 'platform.identity_namespace_allocation_intent', 'SELECT')
           AND has_table_privilege(current_user, 'platform.commerce_billing_account', 'SELECT')
           AND has_table_privilege(current_user, 'platform.credit_account', 'SELECT')
           AND has_table_privilege(current_user, 'platform.credit_grant', 'SELECT')
           AND (has_table_privilege(current_user, 'platform.credit_hold', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_hold', 'INSERT') AND has_table_privilege(current_user, 'platform.credit_hold', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.credit_hold_allocation', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_hold_allocation', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.credit_journal_transaction', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_journal_transaction', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.credit_journal_entry', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_journal_entry', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.credit_execution_budget_root', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_execution_budget_root', 'INSERT') AND has_table_privilege(current_user, 'platform.credit_execution_budget_root', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.credit_budget_allocation', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_budget_allocation', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.credit_budget_allocation_revision', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_budget_allocation_revision', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.credit_authorization_segment', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_authorization_segment', 'INSERT') AND has_table_privilege(current_user, 'platform.credit_authorization_segment', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.credit_budget_operation_receipt', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_budget_operation_receipt', 'INSERT'))
           AND has_table_privilege(current_user, 'platform.credit_rating_policy_revision', 'SELECT')
           AND (has_table_privilege(current_user, 'platform.credit_rating_snapshot', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_rating_snapshot', 'INSERT'))
           AND has_table_privilege(current_user, 'platform.credit_usage_attempt_intent', 'SELECT')
           AND has_table_privilege(current_user, 'platform.credit_attempt_usage_evidence', 'SELECT')
           AND (has_table_privilege(current_user, 'platform.credit_usage_segment_closure', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_usage_segment_closure', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.credit_usage_closure_evidence', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_usage_closure_evidence', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.credit_usage_settlement', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_usage_settlement', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.credit_rated_usage', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_rated_usage', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.credit_usage_settlement_source', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_usage_settlement_source', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.credit_usage_variance', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_usage_variance', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.credit_usage_reconciliation', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_usage_reconciliation', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.credit_usage_command_receipt', 'SELECT') AND has_table_privilege(current_user, 'platform.credit_usage_command_receipt', 'INSERT'))
           AND has_table_privilege(current_user, 'platform.asset_resource', 'SELECT')
           AND has_table_privilege(current_user, 'platform.asset_version', 'SELECT')
           AND has_table_privilege(current_user, 'platform.asset_eligibility_projection', 'SELECT')
           AND has_table_privilege(current_user, 'platform.model_gateway_execution_authorization', 'INSERT')
           AND has_column_privilege(current_user, 'platform.model_gateway_execution_authorization', 'authorization_handle', 'SELECT')
           AND has_column_privilege(current_user, 'platform.model_gateway_execution_authorization', 'state', 'SELECT')
           AND has_column_privilege(current_user, 'platform.model_gateway_execution_authorization', 'state', 'UPDATE')
           AND has_column_privilege(current_user, 'platform.model_gateway_execution_authorization', 'updated_at', 'UPDATE')
         WHEN $2 = 'asset-data-plane' THEN
           has_table_privilege(current_user, 'platform.authorization_product_binding', 'SELECT')
           AND has_table_privilege(current_user, 'platform.authorization_subject', 'SELECT')
           AND has_table_privilege(current_user, 'platform.authorization_project', 'SELECT')
           AND has_table_privilege(current_user, 'platform.authorization_project_membership', 'SELECT')
           AND has_table_privilege(current_user, 'platform.asset_upload_intent', 'SELECT')
           AND has_table_privilege(current_user, 'platform.asset_upload_session', 'SELECT')
           AND has_column_privilege(current_user, 'platform.asset_upload_session', 'state', 'UPDATE')
           AND has_column_privilege(current_user, 'platform.asset_upload_session', 'completion_requested_at', 'UPDATE')
           AND has_column_privilege(current_user, 'platform.asset_upload_session', 'expected_version', 'UPDATE')
           AND has_column_privilege(current_user, 'platform.asset_upload_session', 'updated_at', 'UPDATE')
           AND has_table_privilege(current_user, 'platform.asset_multipart_upload', 'SELECT')
           AND has_table_privilege(current_user, 'platform.asset_multipart_upload', 'INSERT')
           AND has_column_privilege(current_user, 'platform.asset_multipart_upload', 'state', 'UPDATE')
           AND has_column_privilege(current_user, 'platform.asset_multipart_upload', 'expected_version', 'UPDATE')
           AND has_table_privilege(current_user, 'platform.asset_multipart_part', 'SELECT')
           AND has_table_privilege(current_user, 'platform.asset_multipart_part', 'INSERT')
           AND has_column_privilege(current_user, 'platform.asset_multipart_part', 'state', 'UPDATE')
           AND has_column_privilege(current_user, 'platform.asset_multipart_part', 'expected_version', 'UPDATE')
           AND has_function_privilege(current_user,
             'platform.enqueue_asset_upload_completion_event(uuid,text,jsonb,character,text,text)',
             'EXECUTE')
         WHEN $2 = 'worker' THEN
           (has_table_privilege(current_user, 'platform.outbox_event', 'SELECT') AND has_table_privilege(current_user, 'platform.outbox_event', 'UPDATE'))
           AND has_table_privilege(current_user, 'platform.site', 'SELECT')
           AND has_any_column_privilege(current_user, 'platform.site', 'UPDATE')
           AND has_table_privilege(current_user, 'platform.site_project_binding', 'SELECT')
           AND has_table_privilege(current_user, 'platform.site_release', 'SELECT')
           AND has_any_column_privilege(current_user, 'platform.site_release', 'UPDATE')
           AND (has_table_privilege(current_user, 'platform.site_deployment_binding', 'SELECT') AND has_table_privilege(current_user, 'platform.site_deployment_binding', 'INSERT'))
           AND has_any_column_privilege(current_user, 'platform.site_deployment_binding', 'UPDATE')
           AND has_table_privilege(current_user, 'platform.site_activation_attempt', 'SELECT')
           AND has_any_column_privilege(current_user, 'platform.site_activation_attempt', 'UPDATE')
           AND (has_table_privilege(current_user, 'platform.site_deployment_observation', 'SELECT') AND has_table_privilege(current_user, 'platform.site_deployment_observation', 'INSERT'))
           AND has_table_privilege(current_user, 'platform.site_traffic_stop_attempt', 'SELECT')
           AND has_any_column_privilege(current_user, 'platform.site_traffic_stop_attempt', 'UPDATE')
           AND (has_table_privilege(current_user, 'platform.site_traffic_stop_observation', 'SELECT') AND has_table_privilege(current_user, 'platform.site_traffic_stop_observation', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.authorization_site', 'SELECT') AND has_table_privilege(current_user, 'platform.authorization_site', 'INSERT'))
           AND has_any_column_privilege(current_user, 'platform.authorization_site', 'UPDATE')
           AND (has_table_privilege(current_user, 'platform.authorization_site_release', 'SELECT') AND has_table_privilege(current_user, 'platform.authorization_site_release', 'INSERT'))
           AND has_any_column_privilege(current_user, 'platform.authorization_site_release', 'UPDATE')
           AND (has_table_privilege(current_user, 'platform.authorization_product_binding', 'SELECT') AND has_table_privilege(current_user, 'platform.authorization_product_binding', 'INSERT'))
           AND has_any_column_privilege(current_user, 'platform.authorization_product_binding', 'UPDATE')
           AND has_table_privilege(current_user, 'platform.command_receipt', 'UPDATE')
           AND (has_table_privilege(current_user, 'platform.inbox_delivery', 'INSERT') AND has_table_privilege(current_user, 'platform.inbox_delivery', 'UPDATE'))
           AND has_table_privilege(current_user, 'platform.authorization_session_access_grant', 'SELECT')
           AND has_table_privilege(current_user, 'platform.admin_operator_authority', 'SELECT')
           AND (has_table_privilege(current_user, 'platform.admin_approval', 'SELECT') AND has_table_privilege(current_user, 'platform.admin_approval', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.admin_post_effect_review', 'SELECT') AND has_table_privilege(current_user, 'platform.admin_post_effect_review', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.asset_upload_intent', 'SELECT') AND has_table_privilege(current_user, 'platform.asset_upload_intent', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.asset_upload_session', 'SELECT') AND has_table_privilege(current_user, 'platform.asset_upload_session', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.asset_quota_account', 'SELECT') AND has_table_privilege(current_user, 'platform.asset_quota_account', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.asset_quota_reservation', 'SELECT') AND has_table_privilege(current_user, 'platform.asset_quota_reservation', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.asset_blob_candidate', 'SELECT') AND has_table_privilege(current_user, 'platform.asset_blob_candidate', 'INSERT') AND has_table_privilege(current_user, 'platform.asset_blob_candidate', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.asset_cleanup_group', 'SELECT') AND has_table_privilege(current_user, 'platform.asset_cleanup_group', 'INSERT') AND has_table_privilege(current_user, 'platform.asset_cleanup_group', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.asset_object_cleanup', 'SELECT') AND has_table_privilege(current_user, 'platform.asset_object_cleanup', 'INSERT') AND has_table_privilege(current_user, 'platform.asset_object_cleanup', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.asset_object_cleanup_receipt', 'SELECT') AND has_table_privilege(current_user, 'platform.asset_object_cleanup_receipt', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.asset_upload_rejection', 'SELECT') AND has_table_privilege(current_user, 'platform.asset_upload_rejection', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.asset_scan_evaluation', 'SELECT') AND has_table_privilege(current_user, 'platform.asset_scan_evaluation', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.asset_promotion_intent', 'SELECT') AND has_table_privilege(current_user, 'platform.asset_promotion_intent', 'INSERT') AND has_table_privilege(current_user, 'platform.asset_promotion_intent', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.asset_blob', 'SELECT') AND has_table_privilege(current_user, 'platform.asset_blob', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.asset_resource', 'SELECT') AND has_table_privilege(current_user, 'platform.asset_resource', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.asset_version', 'SELECT') AND has_table_privilege(current_user, 'platform.asset_version', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.asset_reference', 'SELECT') AND has_table_privilege(current_user, 'platform.asset_reference', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.asset_eligibility_projection', 'SELECT') AND has_table_privilege(current_user, 'platform.asset_eligibility_projection', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.asset_promotion_receipt', 'SELECT') AND has_table_privilege(current_user, 'platform.asset_promotion_receipt', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.authorization_scoped_stream_state', 'SELECT') AND has_table_privilege(current_user, 'platform.authorization_scoped_stream_state', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.authorization_scoped_site_cursor', 'SELECT') AND has_table_privilege(current_user, 'platform.authorization_scoped_site_cursor', 'INSERT') AND has_table_privilege(current_user, 'platform.authorization_scoped_site_cursor', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.authorization_scoped_event_log', 'SELECT') AND has_table_privilege(current_user, 'platform.authorization_scoped_event_log', 'INSERT') AND has_table_privilege(current_user, 'platform.authorization_scoped_event_log', 'DELETE'))
           AND (has_table_privilege(current_user, 'platform.authorization_scoped_snapshot', 'SELECT') AND has_table_privilege(current_user, 'platform.authorization_scoped_snapshot', 'DELETE'))
         WHEN $2 = 'authorization' THEN
           has_table_privilege(current_user, 'platform.authorization_scoped_stream_state', 'SELECT')
           AND has_table_privilege(current_user, 'platform.authorization_scoped_site_cursor', 'SELECT')
           AND has_table_privilege(current_user, 'platform.authorization_scoped_event_log', 'SELECT')
           AND (has_table_privilege(current_user, 'platform.authorization_scoped_snapshot', 'SELECT') AND has_table_privilege(current_user, 'platform.authorization_scoped_snapshot', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.authorization_scoped_snapshot_record', 'SELECT') AND has_table_privilege(current_user, 'platform.authorization_scoped_snapshot_record', 'INSERT'))
           AND has_table_privilege(current_user, 'platform.authorization_site', 'SELECT')
           AND has_table_privilege(current_user, 'platform.authorization_subject', 'SELECT')
           AND has_table_privilege(current_user, 'platform.authorization_identity_session', 'SELECT')
           AND has_table_privilege(current_user, 'platform.authorization_project_membership', 'SELECT')
           AND has_table_privilege(current_user, 'platform.authorization_session_access_grant', 'SELECT')
         ELSE (has_table_privilege(current_user, 'platform.command_receipt', 'SELECT') AND has_table_privilege(current_user, 'platform.command_receipt', 'INSERT') AND has_table_privilege(current_user, 'platform.command_receipt', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.outbox_event', 'SELECT') AND has_table_privilege(current_user, 'platform.outbox_event', 'INSERT'))
           AND has_table_privilege(current_user, 'platform.authorization_site', 'SELECT')
           AND has_table_privilege(current_user, 'platform.authorization_subject', 'SELECT')
           AND has_table_privilege(current_user, 'platform.authorization_product_binding', 'SELECT')
           AND (has_table_privilege(current_user, 'platform.commerce_billing_account', 'SELECT') AND has_table_privilege(current_user, 'platform.commerce_billing_account', 'INSERT') AND has_table_privilege(current_user, 'platform.commerce_billing_account', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.commerce_billing_account_membership', 'SELECT') AND has_table_privilege(current_user, 'platform.commerce_billing_account_membership', 'INSERT') AND has_table_privilege(current_user, 'platform.commerce_billing_account_membership', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.site', 'SELECT') AND has_table_privilege(current_user, 'platform.site', 'INSERT'))
           AND has_any_column_privilege(current_user, 'platform.site', 'UPDATE')
           AND (has_table_privilege(current_user, 'platform.site_project_binding', 'SELECT') AND has_table_privilege(current_user, 'platform.site_project_binding', 'INSERT'))
           AND has_any_column_privilege(current_user, 'platform.site_project_binding', 'UPDATE')
           AND (has_table_privilege(current_user, 'platform.site_release', 'SELECT') AND has_table_privilege(current_user, 'platform.site_release', 'INSERT'))
           AND has_any_column_privilege(current_user, 'platform.site_release', 'UPDATE')
           AND (has_table_privilege(current_user, 'platform.site_activation_attempt', 'SELECT') AND has_table_privilege(current_user, 'platform.site_activation_attempt', 'INSERT'))
           AND has_table_privilege(current_user, 'platform.site_deployment_binding', 'SELECT')
           AND has_any_column_privilege(current_user, 'platform.site_deployment_binding', 'UPDATE')
           AND (has_table_privilege(current_user, 'platform.site_traffic_stop_attempt', 'SELECT') AND has_table_privilege(current_user, 'platform.site_traffic_stop_attempt', 'INSERT'))
           AND has_table_privilege(current_user, 'platform.site_traffic_stop_observation', 'SELECT')
           AND (has_table_privilege(current_user, 'platform.site_effect_approval', 'SELECT') AND has_table_privilege(current_user, 'platform.site_effect_approval', 'INSERT'))
           AND has_any_column_privilege(current_user, 'platform.site_effect_approval', 'UPDATE')
           AND has_any_column_privilege(current_user, 'platform.authorization_site', 'UPDATE')
           AND has_any_column_privilege(current_user, 'platform.authorization_product_binding', 'UPDATE')
           AND (has_table_privilege(current_user, 'platform.authorization_scoped_stream_state', 'SELECT') AND has_table_privilege(current_user, 'platform.authorization_scoped_stream_state', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.authorization_scoped_site_cursor', 'SELECT') AND has_table_privilege(current_user, 'platform.authorization_scoped_site_cursor', 'INSERT') AND has_table_privilege(current_user, 'platform.authorization_scoped_site_cursor', 'UPDATE'))
           AND has_table_privilege(current_user, 'platform.authorization_scoped_event_log', 'INSERT')
           AND has_table_privilege(current_user, 'platform.admin_operator_authority', 'SELECT')
           AND has_table_privilege(current_user, 'platform.admin_operator_site_scope', 'SELECT')
           AND has_table_privilege(current_user, 'platform.admin_operator_global_scope_grant', 'SELECT')
           AND has_table_privilege(current_user, 'platform.admin_breakglass_grant', 'SELECT')
           AND has_table_privilege(current_user, 'platform.admin_operator_identity', 'SELECT')
           AND (has_table_privilege(current_user, 'platform.admin_oidc_transaction', 'SELECT') AND has_table_privilege(current_user, 'platform.admin_oidc_transaction', 'INSERT') AND has_table_privilege(current_user, 'platform.admin_oidc_transaction', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.admin_operator_session', 'SELECT') AND has_table_privilege(current_user, 'platform.admin_operator_session', 'INSERT') AND has_table_privilege(current_user, 'platform.admin_operator_session', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.admin_step_up_transaction', 'SELECT') AND has_table_privilege(current_user, 'platform.admin_step_up_transaction', 'INSERT') AND has_table_privilege(current_user, 'platform.admin_step_up_transaction', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.admin_command_decision', 'SELECT') AND has_table_privilege(current_user, 'platform.admin_command_decision', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.admin_approval', 'SELECT') AND has_table_privilege(current_user, 'platform.admin_approval', 'INSERT') AND has_table_privilege(current_user, 'platform.admin_approval', 'UPDATE'))
           AND (has_table_privilege(current_user, 'platform.admin_approval_decision', 'SELECT') AND has_table_privilege(current_user, 'platform.admin_approval_decision', 'INSERT'))
           AND (has_table_privilege(current_user, 'platform.admin_post_effect_review', 'SELECT') AND has_table_privilege(current_user, 'platform.admin_post_effect_review', 'INSERT') AND has_table_privilege(current_user, 'platform.admin_post_effect_review', 'UPDATE'))
           AND has_table_privilege(current_user, 'platform.asset_upload_intent', 'SELECT')
           AND has_table_privilege(current_user, 'platform.asset_upload_session', 'SELECT')
           AND has_table_privilege(current_user, 'platform.asset_quota_account', 'SELECT')
           AND has_table_privilege(current_user, 'platform.asset_quota_reservation', 'SELECT')
           AND has_table_privilege(current_user, 'platform.asset_blob_candidate', 'SELECT')
           AND has_table_privilege(current_user, 'platform.asset_cleanup_group', 'SELECT')
           AND has_table_privilege(current_user, 'platform.asset_object_cleanup', 'SELECT')
           AND has_table_privilege(current_user, 'platform.asset_object_cleanup_receipt', 'SELECT')
           AND has_table_privilege(current_user, 'platform.asset_upload_rejection', 'SELECT')
           AND has_table_privilege(current_user, 'platform.asset_scan_evaluation', 'SELECT')
           AND has_table_privilege(current_user, 'platform.asset_promotion_intent', 'SELECT')
           AND has_table_privilege(current_user, 'platform.asset_blob', 'SELECT')
           AND has_table_privilege(current_user, 'platform.asset_resource', 'SELECT')
           AND has_table_privilege(current_user, 'platform.asset_version', 'SELECT')
           AND has_table_privilege(current_user, 'platform.asset_reference', 'SELECT')
           AND has_table_privilege(current_user, 'platform.asset_eligibility_projection', 'SELECT')
           AND has_table_privilege(current_user, 'platform.asset_promotion_receipt', 'SELECT')
         END AS "hasRequiredPlatformWrites",
         CASE WHEN $2 = 'worker' THEN
           has_column_privilege(current_user, 'platform.identity_verification_transaction', 'site_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.identity_verification_transaction', 'transaction_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.identity_verification_transaction', 'state', 'SELECT')
           AND has_column_privilege(current_user, 'platform.identity_verification_transaction', 'resend_count', 'SELECT')
           AND has_column_privilege(current_user, 'platform.identity_verification_transaction', 'expires_at', 'SELECT')
           AND NOT has_column_privilege(current_user, 'platform.identity_verification_transaction', 'email_normalized', 'SELECT')
           AND NOT has_column_privilege(current_user, 'platform.identity_verification_transaction', 'secret_digest', 'SELECT')
           AND has_column_privilege(current_user, 'platform.identity_verification_delivery', 'event_id', 'SELECT')
           AND has_column_privilege(current_user, 'platform.identity_verification_delivery', 'site_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.identity_verification_delivery', 'transaction_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.identity_verification_delivery', 'credential_revision', 'SELECT')
           AND has_column_privilege(current_user, 'platform.identity_verification_delivery', 'state', 'SELECT')
           AND has_column_privilege(current_user, 'platform.identity_verification_delivery', 'state', 'UPDATE')
           AND has_column_privilege(current_user, 'platform.identity_verification_delivery', 'attempt_count', 'UPDATE')
           AND has_column_privilege(current_user, 'platform.identity_verification_delivery', 'delivered_at', 'UPDATE')
           AND has_column_privilege(current_user, 'platform.identity_verification_delivery', 'failed_at', 'UPDATE')
           AND has_column_privilege(current_user, 'platform.identity_verification_delivery', 'superseded_at', 'UPDATE')
           AND has_column_privilege(current_user, 'platform.identity_verification_delivery', 'last_error_code', 'UPDATE')
           AND has_column_privilege(current_user, 'platform.identity_verification_delivery', 'updated_at', 'UPDATE')
           AND has_column_privilege(current_user, 'platform.identity_personal_bootstrap', 'site_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.identity_personal_bootstrap', 'subject_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.identity_personal_bootstrap', 'workspace_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.identity_personal_bootstrap', 'project_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.identity_personal_bootstrap', 'execution_space_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.identity_personal_bootstrap', 'execution_namespace', 'SELECT')
           AND has_column_privilege(current_user, 'platform.identity_personal_bootstrap', 'namespace_intent_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.identity_execution_space', 'site_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.identity_execution_space', 'execution_space_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.identity_execution_space', 'project_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.identity_execution_space', 'execution_namespace', 'SELECT')
           AND has_column_privilege(current_user, 'platform.identity_execution_space', 'state', 'SELECT')
           AND has_column_privilege(current_user, 'platform.identity_execution_space', 'state', 'UPDATE')
           AND has_column_privilege(current_user, 'platform.identity_execution_space', 'updated_at', 'UPDATE')
           AND has_column_privilege(current_user, 'platform.identity_namespace_allocation_intent', 'intent_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.identity_namespace_allocation_intent', 'event_id', 'SELECT')
           AND has_column_privilege(current_user, 'platform.identity_namespace_allocation_intent', 'site_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.identity_namespace_allocation_intent', 'execution_space_ref', 'SELECT')
           AND has_column_privilege(current_user, 'platform.identity_namespace_allocation_intent', 'execution_namespace', 'SELECT')
           AND has_column_privilege(current_user, 'platform.identity_namespace_allocation_intent', 'state', 'SELECT')
           AND has_column_privilege(current_user, 'platform.identity_namespace_allocation_intent', 'state', 'UPDATE')
           AND has_column_privilege(current_user, 'platform.identity_namespace_allocation_intent', 'attempt_count', 'UPDATE')
           AND has_column_privilege(current_user, 'platform.identity_namespace_allocation_intent', 'last_error_code', 'UPDATE')
           AND has_column_privilege(current_user, 'platform.identity_namespace_allocation_intent', 'updated_at', 'UPDATE')
         ELSE FALSE END AS "hasIdentityOutboxConsumerAuthority",
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
         has_function_privilege(current_user, 'platform.commerce_safe_label_is_valid(text)', 'EXECUTE')
           AS "canExecuteCommerceSafeLabel",
         has_function_privilege(current_user, 'platform.commerce_iana_zone_is_valid(text)', 'EXECUTE')
           AS "canExecuteCommerceIanaZone",
         has_table_privilege(current_user, 'platform.commerce_catalog_epoch_authority', 'SELECT')
           AS "canReadCommerceCatalogEpoch",
         has_table_privilege(current_user, 'platform.commerce_catalog_epoch_authority', 'UPDATE')
           AS "canUpdateCommerceCatalogEpoch",
         has_function_privilege(current_user, 'platform.apply_admin_authority_change(uuid,jsonb)', 'EXECUTE')
           AS "canExecuteAdminAuthorityChange",
         CASE WHEN $2='api' THEN
           has_function_privilege(current_user,'platform.resolve_product_model_option_catalog(text,text)','EXECUTE')
         WHEN $2='admission' THEN
           has_function_privilege(current_user,'platform.resolve_admission_model_owner(text,text,text)','EXECUTE')
         WHEN $2='admin' THEN
           has_function_privilege(current_user,'platform.load_model_option_inventory(text)','EXECUTE')
           AND has_function_privilege(current_user,'platform.load_model_option_revisions(text[])','EXECUTE')
           AND has_function_privilege(current_user,'platform.materialize_model_options(uuid,text,text,text,text,jsonb,text)','EXECUTE')
           AND has_function_privilege(current_user,'platform.publish_site_release_model_catalog(uuid,jsonb,text)','EXECUTE')
         ELSE TRUE END AS "hasRequiredModelOptionFunctions",
         CASE WHEN $2='admin' THEN
           has_column_privilege(current_user,'platform.model_inventory_import','import_id','SELECT')
           AND has_column_privilege(current_user,'platform.model_inventory_import','source_digest','SELECT')
           AND has_column_privilege(current_user,'platform.model_inventory_import','source_reference','SELECT')
           AND has_column_privilege(current_user,'platform.model_inventory_import','counts','SELECT')
           AND has_column_privilege(current_user,'platform.model_inventory_import','imported_at','SELECT')
           AND has_column_privilege(current_user,'platform.model_provider_snapshot','import_id','SELECT')
           AND has_column_privilege(current_user,'platform.model_provider_snapshot','provider_key','SELECT')
           AND has_column_privilege(current_user,'platform.model_provider_snapshot','provider','SELECT')
           AND has_column_privilege(current_user,'platform.model_provider_snapshot','account_key','SELECT')
           AND has_column_privilege(current_user,'platform.model_provider_snapshot','adapter_kind','SELECT')
           AND has_column_privilege(current_user,'platform.model_provider_snapshot','priority','SELECT')
           AND has_table_privilege(current_user,'platform.model_inventory_pointer','SELECT')
           AND has_table_privilege(current_user,'platform.model_definition_snapshot','SELECT')
           AND has_table_privilege(current_user,'platform.model_provider_binding_snapshot','SELECT')
           AND has_table_privilege(current_user,'platform.model_product_route_snapshot','SELECT')
           AND has_table_privilege(current_user,'platform.model_provider_availability','SELECT')
           AND has_table_privilege(current_user,'platform.model_option_revision','SELECT')
           AND has_table_privilege(current_user,'platform.model_site_policy_revision','SELECT')
           AND has_table_privilege(current_user,'platform.model_site_assignment_revision','SELECT')
           AND has_table_privilege(current_user,'platform.model_site_policy_pointer','SELECT')
           AND has_table_privilege(current_user,'platform.site_release_model_catalog_publication','SELECT')
           AND has_table_privilege(current_user,'platform.site_release_model_catalog_surface','SELECT')
         ELSE EXISTS (
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
             AND has_table_privilege(current_user,model_relation.oid,'SELECT')
         ) END AS "canSelectModelCatalogTable",
         (has_column_privilege(current_user,'platform.model_inventory_import','canonical_payload','SELECT')
           OR has_column_privilege(current_user,'platform.model_provider_snapshot','secret_ref','SELECT'))
           AS "canReadModelSensitiveColumn",
         ARRAY(
           SELECT candidate.relname::text FROM pg_class candidate
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
               ,'commerce_command','commerce_catalog_epoch_authority','commerce_billing_account','commerce_billing_account_membership',
               'commerce_fulfillment_transaction','commerce_fulfillment_output_plan',
               'commerce_fulfillment_actual_output','commerce_command_outbox','commerce_audit_entry',
               'commerce_catalog_product','commerce_catalog_plan','commerce_catalog_plan_version',
               'commerce_credit_program_revision','commerce_entitlement_template_revision',
               'commerce_fulfillment_program_revision','commerce_fulfillment_program_output',
               'commerce_catalog_product_version','commerce_redemption_program_revision',
               'commerce_redemption_program_availability','commerce_subscription','commerce_subscription_term',
               'commerce_subscription_term_revocation','commerce_code_batch','commerce_redeem_code',
               'commerce_code_batch_approval','commerce_code_secret_export',
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
               'admin_operator_session','admin_step_up_transaction','admin_command_decision','admin_approval','admin_approval_decision',
               'admin_authority_bootstrap','admin_post_effect_review',
               ${ADMISSION_RELATIONS_SQL},
               ${ASSET_RELATIONS_SQL},
               ${CREDIT_USAGE_RELATIONS_SQL},
               ${MODEL_GATEWAY_ADMISSION_RELATIONS_SQL}
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
               ,'commerce_command','commerce_catalog_epoch_authority','commerce_billing_account','commerce_billing_account_membership',
               'commerce_fulfillment_transaction','commerce_fulfillment_output_plan',
               'commerce_fulfillment_actual_output','commerce_command_outbox','commerce_audit_entry',
               'commerce_catalog_product','commerce_catalog_plan','commerce_catalog_plan_version',
               'commerce_credit_program_revision','commerce_entitlement_template_revision',
               'commerce_fulfillment_program_revision','commerce_fulfillment_program_output',
               'commerce_catalog_product_version','commerce_redemption_program_revision',
               'commerce_redemption_program_availability','commerce_subscription','commerce_subscription_term',
               'commerce_subscription_term_revocation','commerce_code_batch','commerce_redeem_code',
               'commerce_code_batch_approval','commerce_code_secret_export',
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
               'admin_operator_session','admin_step_up_transaction','admin_command_decision','admin_approval','admin_approval_decision',
               'admin_authority_bootstrap','admin_post_effect_review',
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
                 ($2 = 'authorization' AND (
                   has_table_privilege(runtime_role.rolname,candidate.oid,'SELECT')
                   OR has_any_column_privilege(runtime_role.rolname,candidate.oid,'SELECT')
                 ) AND candidate.relname <> ALL(ARRAY[
                   'platform_foundation','authorization_scoped_stream_state','authorization_scoped_site_cursor','authorization_scoped_event_log',
                   'authorization_scoped_snapshot','authorization_scoped_snapshot_record','authorization_site',
                   'authorization_subject','authorization_identity_session','authorization_project_membership',
                   'authorization_session_access_grant'
                 ]))
                 OR
                 ($2='admission' AND (
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
                    ($2='api' AND candidate.relname=ANY(ARRAY['site','site_release']))
                    OR ($2='worker' AND candidate.relname<>'site_effect_approval') OR $2='admin'
                    OR ($2='admission' AND candidate.relname=ANY(ARRAY['site','site_release']))
                  ))
                 OR
                 ((has_table_privilege(runtime_role.rolname,candidate.oid,'SELECT')
                  OR has_any_column_privilege(runtime_role.rolname,candidate.oid,'SELECT'))
                  AND candidate.relname=ANY(ARRAY[${ASSET_RELATIONS_SQL}]) AND NOT (
                    ($2='api' AND candidate.relname=ANY(ARRAY[${ASSET_API_RELATIONS_SQL}]))
                    OR ($2 IN ('worker','admin') AND
                      candidate.relname=ANY(ARRAY[${ASSET_RELATIONS_SQL}]))
                    OR ($2='asset-data-plane' AND
                      candidate.relname=ANY(ARRAY[${ASSET_DATA_PLANE_RELATIONS_SQL}]))
                    OR ($2='admission' AND candidate.relname=ANY(ARRAY[
                      'asset_resource','asset_version','asset_eligibility_projection'
                    ]))
                  ))
                 OR
                 ($2='api' AND candidate.relname=ANY(ARRAY[${ASSET_API_OWNER_READ_RELATIONS_SQL}])
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
                   $2 = 'worker' AND candidate.relname = ANY(ARRAY[
                     'authorization_scoped_event_log','authorization_scoped_snapshot'
                   ])
                 ))
                 OR has_any_column_privilege(runtime_role.rolname, candidate.oid, 'REFERENCES')
                 OR (has_table_privilege(runtime_role.rolname, candidate.oid, 'INSERT') AND NOT (
                   ($2 = 'api' AND candidate.relname = ANY(ARRAY[
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
                   OR ($2 = 'admission' AND
                     candidate.relname=ANY(ARRAY[${ADMISSION_INSERT_RELATIONS_SQL}]))
                   OR ($2 = 'authorization' AND candidate.relname = ANY(ARRAY['authorization_scoped_snapshot','authorization_scoped_snapshot_record']))
                   OR ($2 = 'api' AND candidate.relname=ANY(ARRAY[${ASSET_API_MUTABLE_RELATIONS_SQL}]))
                   OR ($2 = 'asset-data-plane' AND
                     candidate.relname=ANY(ARRAY['asset_multipart_upload','asset_multipart_part']))
                   OR ($2 = 'worker' AND candidate.relname=ANY(ARRAY[${ASSET_WORKER_INSERT_RELATIONS_SQL}]))
                   OR ($2 = 'worker' AND candidate.relname = ANY(ARRAY[
                     'inbox_delivery','outbox_event',
                     'site_deployment_binding','site_deployment_observation',
                     'site_traffic_stop_observation','authorization_scoped_site_cursor','authorization_scoped_event_log','authorization_site',
                     'authorization_site_release','authorization_product_binding'
                   ]))
                   OR ($2 = 'admin' AND candidate.relname = ANY(ARRAY[
                     'command_receipt','outbox_event','commerce_billing_account','commerce_billing_account_membership',
                     'commerce_command','commerce_catalog_product','commerce_catalog_plan','commerce_catalog_plan_version',
                     'commerce_fulfillment_program_revision','commerce_fulfillment_program_output',
                     'commerce_catalog_product_version','commerce_redemption_program_revision',
                     'commerce_redemption_program_availability','commerce_code_batch','commerce_redeem_code',
                     'commerce_code_batch_approval','commerce_code_secret_export','commerce_audit_entry',
                     'site','site_project_binding','site_release','site_activation_attempt',
                     'site_traffic_stop_attempt','site_effect_approval','authorization_scoped_site_cursor','authorization_scoped_event_log',
                     'admin_command_decision','admin_approval','admin_approval_decision',
                     'admin_post_effect_review','admin_oidc_transaction',
                     'admin_operator_session','admin_step_up_transaction',
                     'admission_capability_catalog_snapshot','admission_launch_profile_snapshot'
                   ]))
                 ))
                 OR (has_table_privilege(runtime_role.rolname, candidate.oid, 'UPDATE') AND NOT (
                   ($2 = 'api' AND candidate.relname = ANY(ARRAY[
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
                   OR ($2 = 'admission' AND
                     candidate.relname=ANY(ARRAY[${ADMISSION_UPDATE_RELATIONS_SQL}]))
                   OR ($2 = 'worker' AND candidate.relname = ANY(ARRAY[
                     'outbox_event','site','site_release','site_deployment_binding',
                     'site_activation_attempt','site_traffic_stop_attempt','authorization_scoped_stream_state','authorization_scoped_site_cursor','authorization_site',
                     'authorization_site_release','authorization_product_binding',
                     'identity_verification_delivery','identity_execution_space',
                     'identity_namespace_allocation_intent'
                   ]))
                   OR ($2 = 'api' AND candidate.relname=ANY(ARRAY[${ASSET_API_MUTABLE_RELATIONS_SQL}]))
                   OR ($2 = 'asset-data-plane' AND
                     candidate.relname=ANY(ARRAY[${ASSET_DATA_PLANE_MUTABLE_RELATIONS_SQL}]))
                   OR ($2 = 'worker' AND candidate.relname=ANY(ARRAY[${ASSET_WORKER_UPDATE_RELATIONS_SQL}]))
                   OR ($2 = 'worker' AND candidate.relname = ANY(ARRAY[
                     'command_receipt','outbox_event','inbox_delivery','admin_approval',
                     'admin_post_effect_review'
                   ]))
                   OR ($2 = 'admin' AND candidate.relname = ANY(ARRAY[
                     'command_receipt','commerce_catalog_epoch_authority','commerce_billing_account','commerce_billing_account_membership',
                     'commerce_catalog_product','commerce_catalog_plan','commerce_code_batch',
                     'commerce_redemption_program_availability',
                     'site','site_project_binding','site_release','site_deployment_binding',
                     'site_effect_approval','authorization_scoped_stream_state','authorization_scoped_site_cursor','authorization_site','authorization_product_binding',
                     'admin_approval','admin_post_effect_review','admin_oidc_transaction',
                     'admin_operator_session','admin_step_up_transaction'
                   ]))
                   OR ($2 = 'admin' AND candidate.relname = 'admin_approval')
                 ))
                 OR (has_any_column_privilege(runtime_role.rolname, candidate.oid, 'INSERT') AND NOT (
                   ($2 = 'api' AND candidate.relname = ANY(ARRAY[
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
                   OR ($2 = 'admission' AND
                     candidate.relname=ANY(ARRAY[${ADMISSION_INSERT_RELATIONS_SQL}]))
                   OR ($2 = 'authorization' AND candidate.relname = ANY(ARRAY['authorization_scoped_snapshot','authorization_scoped_snapshot_record']))
                   OR ($2 = 'api' AND candidate.relname=ANY(ARRAY[${ASSET_API_MUTABLE_RELATIONS_SQL}]))
                   OR ($2 = 'asset-data-plane' AND
                     candidate.relname=ANY(ARRAY['asset_multipart_upload','asset_multipart_part']))
                   OR ($2 = 'worker' AND candidate.relname=ANY(ARRAY[${ASSET_WORKER_INSERT_RELATIONS_SQL}]))
                   OR ($2 = 'worker' AND candidate.relname = ANY(ARRAY[
                     'inbox_delivery','outbox_event',
                     'site_deployment_binding','site_deployment_observation',
                     'site_traffic_stop_observation','authorization_scoped_site_cursor','authorization_scoped_event_log','authorization_site',
                     'authorization_site_release','authorization_product_binding'
                   ]))
                   OR ($2 = 'admin' AND candidate.relname = ANY(ARRAY[
                     'command_receipt','outbox_event','commerce_billing_account','commerce_billing_account_membership',
                     'commerce_command','commerce_catalog_product','commerce_catalog_plan','commerce_catalog_plan_version',
                     'commerce_fulfillment_program_revision','commerce_fulfillment_program_output',
                     'commerce_catalog_product_version','commerce_redemption_program_revision',
                     'commerce_redemption_program_availability','commerce_code_batch','commerce_redeem_code',
                     'commerce_code_batch_approval','commerce_code_secret_export','commerce_audit_entry',
                     'site','site_project_binding','site_release','site_activation_attempt',
                     'site_traffic_stop_attempt','site_effect_approval','authorization_scoped_site_cursor','authorization_scoped_event_log',
                     'admin_command_decision','admin_approval','admin_approval_decision',
                     'admin_post_effect_review','admin_oidc_transaction',
                     'admin_operator_session','admin_step_up_transaction',
                     'admission_capability_catalog_snapshot','admission_launch_profile_snapshot'
                   ]))
                 ))
                 OR (has_any_column_privilege(runtime_role.rolname, candidate.oid, 'UPDATE') AND NOT (
                   ($2 = 'api' AND candidate.relname = ANY(ARRAY[
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
                   OR ($2 = 'admission' AND
                     candidate.relname=ANY(ARRAY[${ADMISSION_UPDATE_RELATIONS_SQL}]))
                   OR ($2 = 'worker' AND candidate.relname = ANY(ARRAY[
                     'outbox_event','site','site_release','site_deployment_binding',
                     'site_activation_attempt','site_traffic_stop_attempt','authorization_scoped_stream_state','authorization_scoped_site_cursor','authorization_site',
                     'authorization_site_release','authorization_product_binding',
                     'identity_verification_delivery','identity_execution_space',
                     'identity_namespace_allocation_intent'
                   ]))
                   OR ($2 = 'api' AND candidate.relname=ANY(ARRAY[${ASSET_API_MUTABLE_RELATIONS_SQL}]))
                   OR ($2 = 'asset-data-plane' AND
                     candidate.relname=ANY(ARRAY[${ASSET_DATA_PLANE_MUTABLE_RELATIONS_SQL}]))
                   OR ($2 = 'worker' AND candidate.relname=ANY(ARRAY[${ASSET_WORKER_UPDATE_RELATIONS_SQL}]))
                   OR ($2 = 'worker' AND candidate.relname = ANY(ARRAY[
                     'command_receipt','outbox_event','inbox_delivery','admin_approval',
                     'admin_post_effect_review'
                   ]))
                   OR ($2 = 'admin' AND candidate.relname = ANY(ARRAY[
                     'command_receipt','commerce_catalog_epoch_authority','commerce_billing_account','commerce_billing_account_membership',
                     'commerce_catalog_product','commerce_catalog_plan','commerce_code_batch',
                     'commerce_redemption_program_availability',
                     'site','site_project_binding','site_release','site_deployment_binding',
                     'site_effect_approval','authorization_scoped_stream_state','authorization_scoped_site_cursor','authorization_site','authorization_product_binding',
                     'admin_approval','admin_post_effect_review','admin_oidc_transaction',
                     'admin_operator_session','admin_step_up_transaction'
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
         ) AS "unexpectedPlatformRelations",
         ARRAY(
           SELECT candidate_function.oid::regprocedure::text FROM pg_proc candidate_function
           WHERE candidate_function.pronamespace = platform_schema.oid
             AND has_function_privilege(runtime_role.rolname, candidate_function.oid, 'EXECUTE')
             AND NOT (
               ($2 = 'admin' AND candidate_function.oid = ANY(ARRAY[
                 to_regprocedure('platform.import_model_inventory(uuid,text,text,jsonb,jsonb,text)'),
                 to_regprocedure('platform.activate_model_inventory(uuid,text,bigint,text)'),
                 to_regprocedure('platform.put_model_site_policy(uuid,text,text,text,bigint)'),
                 to_regprocedure('platform.load_model_option_inventory(text)'),
                 to_regprocedure('platform.load_model_option_revisions(text[])'),
                 to_regprocedure('platform.materialize_model_options(uuid,text,text,text,text,jsonb,text)'),
                 to_regprocedure('platform.publish_site_release_model_catalog(uuid,jsonb,text)'),
                 to_regprocedure('platform.valid_credit_scope_policy(jsonb)'),
                 to_regprocedure('platform.commerce_safe_label_is_valid(text)'),
                 to_regprocedure('platform.commerce_iana_zone_is_valid(text)')
               ]))
               OR ($2 = 'api' AND candidate_function.oid = ANY(ARRAY[
                 to_regprocedure('platform.resolve_model_candidates(text,text,text)'),
                 to_regprocedure('platform.find_model_selection_decision(uuid)'),
                 to_regprocedure('platform.resolve_product_model_option_catalog(text,text)'),
                 to_regprocedure('platform.valid_credit_scope_policy(jsonb)'),
                 to_regprocedure('platform.commerce_safe_label_is_valid(text)')
               ]))
               OR ($2 = 'admission' AND candidate_function.oid = ANY(ARRAY[
                 to_regprocedure('platform.resolve_admission_model_owner(text,text,text)'),
                 to_regprocedure('platform.valid_credit_scope_policy(jsonb)')
               ]))
               OR ($2 = 'worker' AND candidate_function.oid = ANY(ARRAY[
                 to_regprocedure('platform.report_model_provider_availability(uuid,text,text,text,bigint,text,timestamptz,text)'),
                 to_regprocedure('platform.apply_admin_authority_change(uuid,jsonb)')
               ]))
               OR ($2 = 'asset-data-plane' AND candidate_function.oid =
                 to_regprocedure('platform.enqueue_asset_upload_completion_event(uuid,text,jsonb,character,text,text)'))
               OR candidate_function.oid = ANY(ARRAY[
                 to_regprocedure('platform.model_identifier_is_valid(text)'),
                 to_regprocedure('platform.model_text_is_valid(text)'),
                 to_regprocedure('platform.model_secret_reference_is_valid(text)'),
                 to_regprocedure('platform.model_identifier_array_is_canonical(text[],boolean)'),
                 to_regprocedure('platform.model_json_identifier_array_is_canonical(jsonb,boolean)')
               ])
             )
         ) AS "unexpectedPlatformFunctions"
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
    identity.hasIdentityOutboxConsumerAuthority === (config.role === "worker") &&
    identity.canExecuteModelInventoryImport === (config.role === "admin") &&
    identity.canExecuteModelInventoryActivate === (config.role === "admin") &&
    identity.canExecuteModelSitePolicyChange === (config.role === "admin") &&
    identity.canExecuteModelCandidatesProjection === (config.role === "api") &&
    identity.canExecuteModelDecisionProjection === (config.role === "api") &&
    identity.canExecuteModelAvailabilityReport === (config.role === "worker") &&
    identity.canExecuteCreditScopePolicy ===
      (config.role === "api" || config.role === "admission" || config.role === "admin") &&
    identity.canExecuteCommerceSafeLabel === (config.role === "api" || config.role === "admin") &&
    identity.canExecuteCommerceIanaZone === (config.role === "admin") &&
    identity.canReadCommerceCatalogEpoch === (config.role === "admin") &&
    identity.canUpdateCommerceCatalogEpoch === (config.role === "admin") &&
    identity.canExecuteAdminAuthorityChange === (config.role === "worker") &&
    identity.hasRequiredModelOptionFunctions &&
    identity.canSelectModelCatalogTable === (config.role === "admin") &&
    !identity.canReadModelSensitiveColumn &&
    identity.unexpectedPlatformRelations.length === 0 &&
    identity.unexpectedPlatformFunctions.length === 0,
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
