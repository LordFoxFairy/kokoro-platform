import { Client, type QueryResult } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPlatformDatabaseClient,
  loadPlatformDatabaseConfig,
  PLATFORM_WORKER_DATABASE_AUTHORITY,
  type PlatformDatabaseClient,
  type PlatformTransactionalDatabaseClient,
  type PlatformWorkerAuthorityRole,
} from "../../src/infrastructure/postgres/client.js";
import { runPlatformMigrations } from "../../src/infrastructure/postgres/migrator.js";
import { lockCreditFinancialAuthority } from
  "../../src/modules/credit/infrastructure/postgres/credit-financial-lock.js";
import { creditJournalEntriesDigest } from
  "../../src/modules/credit/infrastructure/postgres/credit-journal-digest.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
  type PlatformTransaction,
  type PlatformSqlTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";
import {
  canonicalRelationAuthority,
  SPLIT_WORKER_EXACT_AUTHORITY_SQL,
  SPLIT_WORKER_RELATION_AUTHORITY,
  SPLIT_WORKER_ROUTINE_AUTHORITY,
} from "../../src/infrastructure/postgres/split-worker-authority.js";
import {
  createPostgresModelGatewayDatabase,
  loadModelGatewayDatabaseConfig,
} from "../../src/modules/model-gateway/infrastructure/postgres/model-gateway-database.js";
import { createAdminWorkerAuthorityRepository } from
  "../../src/modules/admin-control/infrastructure/postgres/admin-worker-composition.js";
import {
  createAssetWorkerCompletionService,
  createAssetWorkerUnitOfWork,
} from "../../src/process/asset-worker-composition.js";
import { digestAssetCommand } from "../../src/modules/asset/application/asset-digest.js";
import { createPostgresAssetEffectEventQueue } from
  "../../src/modules/asset/infrastructure/postgres/asset-outbox-consumer.js";
import {
  OUTBOX_ROUTE_CATALOG,
  OutboxRepository,
  type OutboxOwner,
} from "../../src/shared/outbox-inbox/outbox.js";
import { PostgresAdminQueryReader } from
  "../../src/modules/admin/infrastructure/postgres/admin-query-reader.js";
import type { AdminQueryPermit } from
  "../../src/modules/admin/interfaces/connect/admin-query-service.js";

const migratorDatabaseUrl = requireLeasedDatabaseUrl(
  process.env.DATABASE_URL_PLATFORM_MIGRATOR_TEST,
);
const bootstrapDatabaseUrl = requireLeasedDatabaseUrl(
  process.env.DATABASE_URL_PLATFORM_BOOTSTRAP_TEST,
);
const apiDatabaseUrl = requireLeasedDatabaseUrl(process.env.DATABASE_URL_PLATFORM_API_TEST);
const admissionDatabaseUrl = requireLeasedDatabaseUrl(
  process.env.DATABASE_URL_PLATFORM_ADMISSION_TEST,
);
const assetDataPlaneDatabaseUrl = requireLeasedDatabaseUrl(
  process.env.DATABASE_URL_PLATFORM_ASSET_DATA_PLANE_TEST,
);
const artifactDataPlaneDatabaseUrl = requireLeasedDatabaseUrl(
  process.env.DATABASE_URL_PLATFORM_ARTIFACT_DATA_PLANE_TEST,
);
const workerDatabaseUrls = {
  "commerce-worker": requireLeasedDatabaseUrl(
    process.env.DATABASE_URL_PLATFORM_COMMERCE_WORKER_TEST,
  ),
  "site-worker": requireLeasedDatabaseUrl(process.env.DATABASE_URL_PLATFORM_SITE_WORKER_TEST),
  "asset-worker": requireLeasedDatabaseUrl(process.env.DATABASE_URL_PLATFORM_ASSET_WORKER_TEST),
  "admin-worker": requireLeasedDatabaseUrl(process.env.DATABASE_URL_PLATFORM_ADMIN_WORKER_TEST),
  "identity-worker": requireLeasedDatabaseUrl(
    process.env.DATABASE_URL_PLATFORM_IDENTITY_WORKER_TEST,
  ),
  "authorization-maintenance": requireLeasedDatabaseUrl(
    process.env.DATABASE_URL_PLATFORM_AUTHORIZATION_MAINTENANCE_TEST,
  ),
} as const satisfies Record<PlatformWorkerAuthorityRole, string>;
const adminDatabaseUrl = requireLeasedDatabaseUrl(process.env.DATABASE_URL_PLATFORM_ADMIN_TEST);
const modelGatewayDatabaseUrl = requireLeasedDatabaseUrl(
  process.env.DATABASE_URL_PLATFORM_MODEL_GATEWAY_TEST,
);
const memoryDatabaseUrls = Object.freeze({
  public: requireLeasedDatabaseUrl(process.env.DATABASE_URL_PLATFORM_MEMORY_PUBLIC_TEST),
  runtime: requireLeasedDatabaseUrl(process.env.DATABASE_URL_PLATFORM_MEMORY_RUNTIME_TEST),
  worker: requireLeasedDatabaseUrl(process.env.DATABASE_URL_PLATFORM_MEMORY_WORKER_TEST),
});

  it("projects owner-qualified approvals through exact RLS and microsecond pagination", async () => {
    await runPlatformMigrations({ environment: platformMigrationEnvironment() });
    const suffix = randomUUID();
    const ownSiteRef = `site-approval-own-${suffix}`;
    const foreignSiteRef = `site-approval-foreign-${suffix}`;
    const operatorRef = `operator:approval:${suffix}`;
    const checkerRef = `operator:approval-checker:${suffix}`;
    const sharedApprovalRef = randomUUID();
    const globalApprovalRef = randomUUID();
    const microsecondApprovalRef = randomUUID();
    const foreignLifecycleApprovalRef = randomUUID();
    const crossRegionApprovalRef = randomUUID();
    const policyApprovalRef = randomUUID();
    const genericCommandId = randomUUID();
    const globalCommandId = randomUUID();
    const bootstrap = new Client({ connectionString: bootstrapDatabaseUrl });
    const admin = new Client({ connectionString: adminDatabaseUrl });
    await Promise.all([bootstrap.connect(), admin.connect()]);

    const setOwnerContext = async (
      operation: string,
      subjectRef: string,
      region = "us-east-1",
      environment = "staging",
    ): Promise<void> => {
      await admin.query(
        `SELECT set_config('app.operation',$1,true),set_config('app.site_id',$2,true),
                set_config('app.environment',$5,true),set_config('app.region',$3,true),
                set_config('app.workload_kind','admin_workload',true),
                set_config('app.actor_kind','operator',true),set_config('app.subject_id',$4,true)`,
        [operation, ownSiteRef, region, subjectRef, environment],
      );
    };

    const cleanup = async (): Promise<void> => {
      try {
        await bootstrap.query("BEGIN");
        await bootstrap.query("SET LOCAL session_replication_role='replica'");
        await bootstrap.query(
          `DELETE FROM platform.site_effect_approval WHERE approval_ref=ANY($1::uuid[])`,
          [[sharedApprovalRef, microsecondApprovalRef, foreignLifecycleApprovalRef,
            crossRegionApprovalRef, policyApprovalRef]],
        );
        await bootstrap.query(
          `DELETE FROM platform.admin_approval WHERE approval_ref=ANY($1::uuid[])`,
          [[sharedApprovalRef, globalApprovalRef]],
        );
        await bootstrap.query(
          `DELETE FROM platform.command_receipt WHERE command_id=ANY($1::text[])`,
          [[genericCommandId, globalCommandId]],
        );
        await bootstrap.query(
          `DELETE FROM platform.admin_operator_authority WHERE operator_ref=ANY($1::text[])`,
          [[operatorRef, checkerRef]],
        );
        await bootstrap.query(
          `DELETE FROM platform.site WHERE site_ref=ANY($1::text[])`,
          [[ownSiteRef, foreignSiteRef]],
        );
        await bootstrap.query("COMMIT");
      } catch (error) {
        await bootstrap.query("ROLLBACK");
        throw error;
      }
    };

    const host = {
      adminQueryTransaction: async <Result>(
        permit: AdminQueryPermit,
        work: (transaction: PlatformTransaction) => Promise<Result>,
      ): Promise<Result> => {
        await admin.query("BEGIN");
        const siteRefs = permit.scope.kind === "site" ? permit.scope.siteRefs
          : permit.scope.kind === "breakglass" ? permit.scope.resourceRefs : [];
        await admin.query(
          `SELECT set_config('app.operation',$1,true),set_config('app.environment',$2,true),
                  set_config('app.region',$3,true),set_config('app.workload_kind','platform_admin',true),
                  set_config('app.actor_kind','operator',true),set_config('app.subject_id',$4,true),
                  set_config('app.admin_scope_kind',$5,true),set_config('app.admin_site_refs',$6,true),
                  set_config('app.site_id','',true)`,
          [permit.operation, permit.environment, permit.region, permit.operatorRef,
            permit.scope.kind, JSON.stringify(siteRefs)],
        );
        const lease = issuePlatformTransaction({
          query: async <Row extends Record<string, unknown>>(
            statement: string,
            values: readonly unknown[] = [],
          ) => {
            const result = await admin.query<Row>(statement, [...values]);
            return result.rows;
          },
          execute: async (statement: string, values: readonly unknown[] = []) => {
            const result = await admin.query(statement, [...values]);
            return result.rowCount ?? 0;
          },
        });
        try {
          return await work(lease.transaction);
        } finally {
          revokePlatformTransaction(lease);
          await admin.query("ROLLBACK");
        }
      },
    };

    try {
      await bootstrap.query(
        `INSERT INTO platform.site(site_ref,site_key,state) VALUES
         ($1,$2,'preview_ready'),($3,$4,'preview_ready')`,
        [ownSiteRef, `approval-own-${suffix.slice(0, 12)}`,
          foreignSiteRef, `approval-foreign-${suffix.slice(0, 12)}`],
      );
      await bootstrap.query(
        `INSERT INTO platform.admin_operator_authority
         (operator_ref,operator_generation,state,permissions,operator_security_epoch,
          authorization_epoch,expires_at)
         VALUES
         ($1,1,'active',ARRAY['admin.approval.list'],1,1,clock_timestamp()+INTERVAL '1 hour'),
         ($2,1,'active',ARRAY['admin.approval.list'],1,1,clock_timestamp()+INTERVAL '1 hour')`,
        [operatorRef, checkerRef],
      );
      for (const [commandId, idempotencyKey] of [
        [genericCommandId, `generic-${suffix}`],
        [globalCommandId, `global-${suffix}`],
      ] as const) {
        await bootstrap.query(
          `INSERT INTO platform.command_receipt
           (command_id,environment,region,caller_identity,operation,idempotency_key,request_digest)
           VALUES ($1,'staging','us-east-1',$2,'admin.authority.change',$3,repeat('1',64))`,
          [commandId, operatorRef, idempotencyKey],
        );
      }
      await bootstrap.query(
        `INSERT INTO platform.admin_approval
         (approval_ref,command_id,request_digest,payload,payload_digest,operation,maker_ref,
          maker_generation,maker_authorization_epoch,target_site_ref,environment,region,effect_class,
          approval_policy,operator_reason,admitted_at,expires_at)
         VALUES
         ($1,$2,repeat('1',64),'{}',repeat('2',64),'admin.authority.change',$3,1,1,$4,
          'staging','us-east-1','dangerous','pre_effect','generic change',
          '2099-08-08T12:00:00.123456Z','2100-08-08T12:00:00.000000Z'),
         ($5,$6,repeat('1',64),'{}',repeat('2',64),'admin.authority.change',$3,1,1,NULL,
          'staging','us-east-1','dangerous','pre_effect','global change',
          '2099-08-08T11:59:00.000000Z','2100-08-08T12:00:00.000000Z')`,
        [sharedApprovalRef, genericCommandId, operatorRef, ownSiteRef,
          globalApprovalRef, globalCommandId],
      );
      for (const [approvalRef, siteRef, region, requestedAt] of [
        [sharedApprovalRef, ownSiteRef, "us-east-1", "2099-08-08T12:00:00.123456Z"],
        [microsecondApprovalRef, ownSiteRef, "us-east-1", "2099-08-08T12:00:00.123123Z"],
        [foreignLifecycleApprovalRef, foreignSiteRef, "us-east-1", "2099-08-08T11:58:00.000001Z"],
        [crossRegionApprovalRef, ownSiteRef, "us-west-2", "2099-08-08T11:57:00.000001Z"],
      ] as const) {
        await bootstrap.query(
          `INSERT INTO platform.site_effect_approval
           (approval_ref,site_ref,environment,region,operation,effect_digest,reason,command_id,
            idempotency_key,request_digest,state,maker_subject_ref,requested_at,expires_at)
           VALUES ($1,$2,'staging',$3,'site.activation.begin',repeat('3',64),
                   'activate release',$4,$5,repeat('4',64),'pending',$6,$7::timestamptz,
                   '2100-08-08T12:00:00.000000Z')`,
          [approvalRef, siteRef, region, randomUUID(), `lifecycle-${approvalRef}`, operatorRef,
            requestedAt],
        );
      }

      await admin.query("BEGIN");
      await setOwnerContext("site.approval.request", operatorRef);
      await admin.query(
        `INSERT INTO platform.site_effect_approval
         (approval_ref,site_ref,environment,region,operation,effect_digest,reason,command_id,
          idempotency_key,request_digest,state,maker_subject_ref,requested_at,expires_at)
         VALUES ($1,$2,'staging','us-east-1','site.activation.begin',repeat('5',64),
                 'policy transition',$3,$4,repeat('6',64),'pending',$5,
                 '2099-08-08T10:00:00.000001Z','2100-08-08T10:00:00.000001Z')`,
        [policyApprovalRef, ownSiteRef, randomUUID(), `policy-${policyApprovalRef}`, operatorRef],
      );
      await admin.query("COMMIT");

      for (const [environment, region] of [
        ["production", "us-east-1"],
        ["staging", "us-west-2"],
      ] as const) {
        await admin.query("BEGIN");
        await setOwnerContext("site.approval.approve", checkerRef, region, environment);
        expect((await admin.query(
          `UPDATE platform.site_effect_approval
           SET state='approved',checker_subject_ref=$2,decided_at='2099-08-08T10:00:30.000002Z',
               updated_at='2099-08-08T10:00:30.000002Z'
           WHERE approval_ref=$1::uuid`,
          [policyApprovalRef, checkerRef],
        )).rowCount).toBe(0);
        await admin.query("ROLLBACK");
      }

      await admin.query("BEGIN");
      await setOwnerContext("site.approval.approve", checkerRef);
      expect((await admin.query(
        `UPDATE platform.site_effect_approval
         SET state='approved',checker_subject_ref=$2,decided_at='2099-08-08T10:01:00.000002Z',
             updated_at='2099-08-08T10:01:00.000002Z'
         WHERE approval_ref=$1::uuid`,
        [policyApprovalRef, checkerRef],
      )).rowCount).toBe(1);
      await admin.query("COMMIT");

      await expect(bootstrap.query(
        `UPDATE platform.site_effect_approval SET checker_subject_ref=$2
         WHERE approval_ref=$1::uuid`,
        [policyApprovalRef, `${checkerRef}:rewrite`],
      )).rejects.toThrow("SITE_EFFECT_APPROVAL_CHECKER_EVIDENCE_IMMUTABLE");
      await expect(bootstrap.query(
        `UPDATE platform.site_effect_approval SET decided_at=decided_at+INTERVAL '1 microsecond'
         WHERE approval_ref=$1::uuid`,
        [policyApprovalRef],
      )).rejects.toThrow("SITE_EFFECT_APPROVAL_CHECKER_EVIDENCE_IMMUTABLE");

      await admin.query("BEGIN");
      await setOwnerContext("site.traffic-stop.suspend", checkerRef);
      expect((await admin.query(
        `UPDATE platform.site_effect_approval
         SET state='consumed',consumed_request_id=$2,
             consumed_at='2099-08-08T10:01:30.000003Z',updated_at='2099-08-08T10:01:30.000003Z'
         WHERE approval_ref=$1::uuid`,
        [policyApprovalRef, `request:${suffix}:wrong-operation`],
      )).rowCount).toBe(0);
      await admin.query("ROLLBACK");

      await admin.query("BEGIN");
      await setOwnerContext("site.activation.begin", checkerRef);
      expect((await admin.query(
        `UPDATE platform.site_effect_approval
         SET state='consumed',consumed_request_id=$2,
             consumed_at='2099-08-08T10:02:00.000003Z',updated_at='2099-08-08T10:02:00.000003Z'
         WHERE approval_ref=$1::uuid`,
        [policyApprovalRef, `request:${suffix}`],
      )).rowCount).toBe(1);
      await admin.query("COMMIT");

      await expect(bootstrap.query(
        `UPDATE platform.site_effect_approval SET consumed_request_id=$2
         WHERE approval_ref=$1::uuid`,
        [policyApprovalRef, `request:${suffix}:rewrite`],
      )).rejects.toThrow("SITE_EFFECT_APPROVAL_CONSUMPTION_EVIDENCE_IMMUTABLE");
      await expect(bootstrap.query(
        `UPDATE platform.site_effect_approval SET consumed_at=consumed_at+INTERVAL '1 microsecond'
         WHERE approval_ref=$1::uuid`,
        [policyApprovalRef],
      )).rejects.toThrow("SITE_EFFECT_APPROVAL_CONSUMPTION_EVIDENCE_IMMUTABLE");

      const reader = new PostgresAdminQueryReader(host);
      const basePermit = {
        operatorRef,
        environment: "staging",
        region: "us-east-1",
        operation: "admin.approval.list",
        authorityBindingDigest: "a".repeat(64),
      } as const;
      const siteRows = await reader.listPendingApprovals({ ...basePermit,
        scope: { kind: "site", siteRefs: [ownSiteRef] } },
      { siteRef: null, before: null, limit: 100 });
      expect(siteRows.map(({ owner, approvalRef }) => `${owner}:${approvalRef}`).sort()).toEqual(
        [
          `generic_admin:${sharedApprovalRef}`,
          `site_lifecycle:${sharedApprovalRef}`,
          `site_lifecycle:${microsecondApprovalRef}`,
        ].sort(),
      );

      const globalRows = await reader.listPendingApprovals({ ...basePermit,
        scope: { kind: "global", grantRef: randomUUID() } },
      { siteRef: null, before: null, limit: 100 });
      expect(globalRows.map(({ owner, approvalRef }) => `${owner}:${approvalRef}`).sort()).toEqual(
        [
          `generic_admin:${sharedApprovalRef}`,
          `generic_admin:${globalApprovalRef}`,
          `site_lifecycle:${sharedApprovalRef}`,
          `site_lifecycle:${microsecondApprovalRef}`,
          `site_lifecycle:${foreignLifecycleApprovalRef}`,
        ].sort(),
      );

      const lifecycleBreakglassRows = await reader.listPendingApprovals({ ...basePermit,
        scope: { kind: "breakglass", grantRef: randomUUID(),
          resourceRefs: [`site_lifecycle:${sharedApprovalRef}`], fieldAllowlist: ["approval_ref"] } },
      { siteRef: null, before: null, limit: 100 });
      expect(lifecycleBreakglassRows.map(({ owner, approvalRef }) => `${owner}:${approvalRef}`))
        .toEqual([`site_lifecycle:${sharedApprovalRef}`]);

      const genericBreakglassRows = await reader.listPendingApprovals({ ...basePermit,
        scope: { kind: "breakglass", grantRef: randomUUID(),
          resourceRefs: [`generic_admin:${sharedApprovalRef}`], fieldAllowlist: ["approval_ref"] } },
      { siteRef: null, before: null, limit: 100 });
      expect(genericBreakglassRows.map(({ owner, approvalRef }) => `${owner}:${approvalRef}`))
        .toEqual([`generic_admin:${sharedApprovalRef}`]);

      const crossRegionRows = await reader.listPendingApprovals({ ...basePermit, region: "us-west-2",
        scope: { kind: "site", siteRefs: [ownSiteRef] } },
      { siteRef: null, before: null, limit: 100 });
      expect(crossRegionRows.map(({ owner, approvalRef }) => `${owner}:${approvalRef}`))
        .toEqual([`site_lifecycle:${crossRegionApprovalRef}`]);

      const pages: string[] = [];
      let before: Parameters<PostgresAdminQueryReader["listPendingApprovals"]>[1]["before"] = null;
      for (;;) {
        const page = await reader.listPendingApprovals({ ...basePermit,
          scope: { kind: "site", siteRefs: [ownSiteRef] } },
        { siteRef: ownSiteRef, before, limit: 1 });
        const row = page[0];
        if (row === undefined) break;
        pages.push(`${row.owner}:${row.approvalRef}`);
        before = { admittedAt: row.admittedAt, owner: row.owner, approvalRef: row.approvalRef };
      }
      expect(pages).toEqual([
        `site_lifecycle:${sharedApprovalRef}`,
        `generic_admin:${sharedApprovalRef}`,
        `site_lifecycle:${microsecondApprovalRef}`,
      ]);

      await admin.query("BEGIN");
      await admin.query(
        `SELECT set_config('app.operation','admin.site.read',true),
                set_config('app.environment','staging',true),
                set_config('app.region','us-east-1',true),
                set_config('app.workload_kind','platform_admin',true),
                set_config('app.actor_kind','operator',true),
                set_config('app.admin_scope_kind','site',true),
                set_config('app.admin_site_refs',$1,true),set_config('app.site_id',$2,true)`,
        [JSON.stringify([ownSiteRef]), ownSiteRef],
      );
      expect((await admin.query(
        "SELECT approval_ref FROM platform.site_effect_approval WHERE site_ref=$1",
        [ownSiteRef],
      )).rows).toEqual([]);
      await admin.query("ROLLBACK");
    } finally {
      try {
        await cleanup();
      } finally {
        await Promise.all([bootstrap.end(), admin.end()]);
      }
    }
  });
const memoryRoleNames = Object.freeze({
  public: "platform_memory_public",
  runtime: "platform_memory_runtime",
  worker: "platform_memory_worker",
});
// This single test deliberately exercises the complete feature-off authority chain:
// role/ACL inspection, denied callers, purge work, and migration preflight probes.
// Keep a finite integration budget instead of Vitest's unit-test default.
const MEMORY_FEATURE_OFF_AUTHORITY_TEST_TIMEOUT_MS = 60_000;
const migratorUser = decodeURIComponent(new URL(migratorDatabaseUrl).username);
const apiUser = decodeURIComponent(new URL(apiDatabaseUrl).username);
const authorizationUser = requireRole(process.env.PLATFORM_DATABASE_AUTHORIZATION_ROLE);
const admissionUser = requireRole(process.env.PLATFORM_DATABASE_ADMISSION_ROLE);
const assetDataPlaneUser = requireRole(process.env.PLATFORM_DATABASE_ASSET_DATA_PLANE_ROLE);
const artifactDataPlaneUser = requireRole(
  process.env.PLATFORM_DATABASE_ARTIFACT_DATA_PLANE_ROLE,
);
const workerUsers = {
  "commerce-worker": requireRole(process.env.PLATFORM_DATABASE_COMMERCE_WORKER_ROLE),
  "site-worker": requireRole(process.env.PLATFORM_DATABASE_SITE_WORKER_ROLE),
  "asset-worker": requireRole(process.env.PLATFORM_DATABASE_ASSET_WORKER_ROLE),
  "admin-worker": requireRole(process.env.PLATFORM_DATABASE_ADMIN_WORKER_ROLE),
  "identity-worker": requireRole(process.env.PLATFORM_DATABASE_IDENTITY_WORKER_ROLE),
  "authorization-maintenance": requireRole(
    process.env.PLATFORM_DATABASE_AUTHORIZATION_MAINTENANCE_ROLE,
  ),
} as const satisfies Record<PlatformWorkerAuthorityRole, string>;
const identityWorkerDatabaseUrl = workerDatabaseUrls["identity-worker"];
const identityWorkerUser = workerUsers["identity-worker"];
const adminUser = requireRole(process.env.PLATFORM_DATABASE_ADMIN_ROLE);
const modelGatewayUser = requireRole(process.env.PLATFORM_DATABASE_MODEL_GATEWAY_ROLE);
const databaseName = decodeURIComponent(new URL(migratorDatabaseUrl).pathname.slice(1));
let database: PlatformDatabaseClient;
let workerDatabases: Record<PlatformWorkerAuthorityRole, PlatformTransactionalDatabaseClient>;
let modelGatewayDatabase: ReturnType<typeof createPostgresModelGatewayDatabase>;

describe("Platform PostgreSQL foundation", () => {
  beforeAll(async () => {
    await runPlatformMigrations({
      environment: platformMigrationEnvironment(),
    });
    database = createPlatformDatabaseClient(
      loadPlatformDatabaseConfig("api", {
        DATABASE_URL_PLATFORM: apiDatabaseUrl,
        PLATFORM_DATABASE_CREDENTIAL_CLASS: "api",
        PLATFORM_DATABASE_API_ROLE: apiUser,
        PLATFORM_DATABASE_MIGRATOR_ROLE: migratorUser,
        PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
      }),
    );
    await database.connect();
    workerDatabases = Object.fromEntries(
      (Object.keys(workerDatabaseUrls) as PlatformWorkerAuthorityRole[]).map((role) => [
        role,
        createPlatformDatabaseClient(
          loadPlatformDatabaseConfig(role, {
            DATABASE_URL_PLATFORM: workerDatabaseUrls[role],
            PLATFORM_DATABASE_CREDENTIAL_CLASS: role,
            [workerRoleEnvironmentName(role)]: workerUsers[role],
            PLATFORM_DATABASE_MIGRATOR_ROLE: migratorUser,
            PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
          }),
        ),
      ]),
    ) as Record<PlatformWorkerAuthorityRole, PlatformTransactionalDatabaseClient>;
    await Promise.all(Object.values(workerDatabases).map((client) => client.connect()));
    modelGatewayDatabase = createPostgresModelGatewayDatabase(
      loadModelGatewayDatabaseConfig({
        DATABASE_URL_PLATFORM: modelGatewayDatabaseUrl,
        PLATFORM_DATABASE_CREDENTIAL_CLASS: "model-gateway",
        PLATFORM_DATABASE_MODEL_GATEWAY_ROLE: modelGatewayUser,
        PLATFORM_DATABASE_MIGRATOR_ROLE: migratorUser,
        PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
      }),
    );
    await modelGatewayDatabase.connect();
    await modelGatewayDatabase.checkHealth();
  }, 60_000);

  afterAll(async () => {
    await database?.disconnect();
    await Promise.allSettled(
      Object.values(workerDatabases ?? {}).map((client) => client.disconnect()),
    );
    await modelGatewayDatabase?.disconnect();
  });

  it("enforces Memory feature-off identities and exact worker purge authority", async () => {
    const suffix = randomUUID();
    const siteRef = `memory-site-${suffix}`;
    const releaseRef = `memory-release-${suffix}`;
    const subjectRef = `memory-subject-${suffix}`;
    const projectRef = `memory-project-${suffix}`;
    const userSpaceRef = `memory-user-space-${suffix}`;
    const projectSpaceRef = `memory-project-space-${suffix}`;
    const featurePolicyRef = `memory-policy-${suffix}`;
    const executionSpaceRef = `memory-execution-${suffix}`;
    const purgeCommandRef = `memory-purge-command-${suffix}`;
    const purgeJobRef = `memory-purge-job-${suffix}`;
    const exhaustedPurgeCommandRef = `memory-purge-exhausted-command-${suffix}`;
    const exhaustedPurgeJobRef = `memory-purge-exhausted-job-${suffix}`;
    const liveExhaustedPurgeCommandRef = `memory-purge-live-exhausted-command-${suffix}`;
    const liveExhaustedPurgeJobRef = `memory-purge-live-exhausted-job-${suffix}`;
    const targetEntryRef = `memory-target-entry-${suffix}`;
    const targetRevisionRef = `memory-target-revision-${suffix}`;
    const postCutoffEntryRef = `memory-post-cutoff-entry-${suffix}`;
    const postCutoffRevisionRef = `memory-post-cutoff-revision-${suffix}`;
    const bootstrap = new Client({ connectionString: bootstrapDatabaseUrl });
    const publicClient = new Client({ connectionString: memoryDatabaseUrls.public });
    const runtimeClient = new Client({ connectionString: memoryDatabaseUrls.runtime });
    const workerClient = new Client({ connectionString: memoryDatabaseUrls.worker });
    const neighborClient = new Client({ connectionString: apiDatabaseUrl });
    await Promise.all([
      bootstrap.connect(), publicClient.connect(), runtimeClient.connect(), workerClient.connect(),
      neighborClient.connect(),
    ]);
    const authorityInventoryBefore = await readMemoryAuthorityInventory(bootstrap);

    try {
      await bootstrap.query(
        `INSERT INTO platform.authorization_site
           (site_ref,state,security_epoch,policy_epoch,revocation_epoch)
         VALUES ($1,'active',1,1,1)`,
        [siteRef],
      );
      await bootstrap.query(
        `INSERT INTO platform.authorization_site_release
           (release_ref,site_ref,state,web_artifact_digest,enabled_surface_ids,
            feature_policy_revision,model_option_catalog_ref,agent_catalog_ref,
            identity_issuer_label,identity_auth_strength_policy_revision,locale_policy)
         VALUES ($1,$2,'active',$3,'[]'::jsonb,$4,$5,$6,$7,$8,'{}'::jsonb)`,
        [releaseRef, siteRef, "a".repeat(64), featurePolicyRef, `models-${suffix}`,
          `agents-${suffix}`, "Kokoro", "identity-v1"],
      );
      await bootstrap.query(
        `INSERT INTO platform.authorization_subject
           (subject_ref,site_ref,display_name,state,subject_generation,restriction_epoch)
         VALUES ($1,$2,'Memory subject','active',1,1)`,
        [subjectRef, siteRef],
      );
      await bootstrap.query("BEGIN");
      await bootstrap.query("SET CONSTRAINTS ALL DEFERRED");
      await bootstrap.query(
        `INSERT INTO platform.authorization_project
           (project_ref,site_ref,workspace_ref,execution_space_ref,display_name,state)
         VALUES ($1,$2,$3,$4,'Memory project','active')`,
        [projectRef, siteRef, `workspace-${suffix}`, executionSpaceRef],
      );
      await bootstrap.query(
        `INSERT INTO platform.identity_execution_space
           (site_ref,execution_space_ref,project_ref,execution_namespace,state,security_epoch)
         VALUES ($1,$2,$3,$4,'active',1)`,
        [siteRef, executionSpaceRef, projectRef,
          `memory-component-${suffix.replaceAll("-", "")}`],
      );
      await bootstrap.query("COMMIT");
      await bootstrap.query(
        `INSERT INTO platform.authorization_project_membership
           (project_ref,subject_ref,state,membership_epoch,authorization_epoch,is_default)
         VALUES ($1,$2,'active',7,11,false)`,
        [projectRef, subjectRef],
      );
      await bootstrap.query(
        `INSERT INTO platform.memory_space
           (site_ref,space_ref,scope_kind,subject_ref,subject_generation,project_ref,
            feature_policy_revision_ref,version,space_generation,learning_generation,
            revocation_epoch,minimum_learnable_source_origin_seq,learning_state,use_state,state,
            created_at,updated_at)
         VALUES
           ($1,$2,'user',$3,1,NULL,$5,1,1,1,1,0,'active','active','active',
             statement_timestamp(),statement_timestamp()),
           ($1,$4,'project',NULL,NULL,$6,$5,1,1,1,1,0,'active','active','active',
             statement_timestamp(),statement_timestamp())`,
        [siteRef, userSpaceRef, subjectRef, projectSpaceRef, featurePolicyRef, projectRef],
      );

      const roleFacts = await bootstrap.query<{
        role_name: string; can_login: boolean; inherits: boolean; bypasses_rls: boolean;
        is_superuser: boolean; can_create_database: boolean; can_create_role: boolean;
        can_replicate: boolean; can_create_objects: boolean; can_create_temporary: boolean;
        has_membership: boolean; has_members: boolean; owns_database: boolean;
        owns_schema: boolean; owns_relation: boolean; owns_routine: boolean;
        owns_sequence: boolean; owns_type: boolean; owns_tablespace: boolean;
      }>(
        `SELECT role_row.rolname AS role_name,role_row.rolcanlogin AS can_login,
                role_row.rolinherit AS inherits,role_row.rolbypassrls AS bypasses_rls,
                role_row.rolsuper AS is_superuser,role_row.rolcreatedb AS can_create_database,
                role_row.rolcreaterole AS can_create_role,role_row.rolreplication AS can_replicate,
                has_database_privilege(role_row.rolname,current_database(),'CREATE')
                  AS can_create_objects,
                has_database_privilege(role_row.rolname,current_database(),'TEMPORARY')
                  AS can_create_temporary,
                EXISTS (SELECT 1 FROM pg_auth_members member WHERE member.member=role_row.oid)
                  AS has_membership,
                EXISTS (SELECT 1 FROM pg_auth_members member WHERE member.roleid=role_row.oid)
                  AS has_members,
                EXISTS (SELECT 1 FROM pg_database db WHERE db.datdba=role_row.oid)
                  AS owns_database,
                EXISTS (SELECT 1 FROM pg_namespace ns WHERE ns.nspowner=role_row.oid)
                  AS owns_schema,
                EXISTS (SELECT 1 FROM pg_class relation WHERE relation.relowner=role_row.oid)
                  AS owns_relation,
                EXISTS (SELECT 1 FROM pg_class relation
                  WHERE relation.relowner=role_row.oid AND relation.relkind='S')
                  AS owns_sequence,
                EXISTS (SELECT 1 FROM pg_proc routine WHERE routine.proowner=role_row.oid)
                  AS owns_routine,
                EXISTS (SELECT 1 FROM pg_type type_row WHERE type_row.typowner=role_row.oid)
                  AS owns_type,
                EXISTS (SELECT 1 FROM pg_tablespace tablespace
                  WHERE tablespace.spcowner=role_row.oid) AS owns_tablespace
           FROM pg_roles role_row WHERE role_row.rolname=ANY($1::text[])
          ORDER BY role_row.rolname`,
        [Object.values(memoryRoleNames)],
      );
      expect(roleFacts.rows).toHaveLength(3);
      for (const row of roleFacts.rows) {
        expect(row).toMatchObject({ can_login: true, inherits: false, bypasses_rls: false,
          is_superuser: false, can_create_database: false, can_create_role: false,
          can_replicate: false, can_create_objects: false, can_create_temporary: false,
          has_membership: false, has_members: false, owns_database: false, owns_schema: false,
          owns_relation: false, owns_sequence: false, owns_routine: false, owns_type: false,
          owns_tablespace: false });
      }

      const privileges = await bootstrap.query<{
        role_name: string; public_schema_usage: boolean; public_schema_create: boolean;
        platform_schema_usage: boolean; platform_schema_create: boolean;
        relation_acl_count: string; routine_acl_count: string;
      }>(
        `SELECT role_row.rolname AS role_name,
                has_schema_privilege(role_row.rolname,'public','USAGE') AS public_schema_usage,
                has_schema_privilege(role_row.rolname,'public','CREATE') AS public_schema_create,
                has_schema_privilege(role_row.rolname,'platform','USAGE') AS platform_schema_usage,
                has_schema_privilege(role_row.rolname,'platform','CREATE') AS platform_schema_create,
                (SELECT count(*)::text FROM pg_class relation
                  CROSS JOIN LATERAL aclexplode(relation.relacl) acl
                 WHERE relation.relnamespace=to_regnamespace('platform')
                   AND acl.grantee=role_row.oid) AS relation_acl_count,
                (SELECT count(*)::text FROM pg_proc routine
                  CROSS JOIN LATERAL aclexplode(routine.proacl) acl
                 WHERE routine.pronamespace=to_regnamespace('platform')
                   AND acl.grantee=role_row.oid) AS routine_acl_count
           FROM pg_roles role_row WHERE role_row.rolname=ANY($1::text[])
          ORDER BY role_row.rolname`,
        [Object.values(memoryRoleNames)],
      );
      expect(privileges.rows).toEqual([
        { role_name: memoryRoleNames.public, public_schema_usage: true,
          public_schema_create: false, platform_schema_usage: true,
          platform_schema_create: false, relation_acl_count: "0", routine_acl_count: "22" },
        { role_name: memoryRoleNames.runtime, public_schema_usage: true,
          public_schema_create: false, platform_schema_usage: false,
          platform_schema_create: false, relation_acl_count: "0", routine_acl_count: "0" },
        { role_name: memoryRoleNames.worker, public_schema_usage: true,
          public_schema_create: false, platform_schema_usage: true,
          platform_schema_create: false, relation_acl_count: "0", routine_acl_count: "4" },
      ]);

      for (const client of [publicClient, runtimeClient, workerClient]) {
        await expect(client.query("SELECT site_ref FROM platform.memory_space LIMIT 1"))
          .rejects.toMatchObject({ code: "42501" });
      }
      await expect(publicClient.query("SET ROLE platform_migrator"))
        .rejects.toMatchObject({ code: "42501" });
      for (const deniedClient of [publicClient, runtimeClient, neighborClient]) {
        await expect(deniedClient.query(
          "SELECT * FROM platform.memory_worker_claim_purge($1,$2::char(64),60)",
          ["forbidden-memory-worker", "f".repeat(64)],
        )).rejects.toMatchObject({ code: "42501" });
      }
      const publicExecute = await bootstrap.query<{ public_execute_count: string }>(
        `SELECT count(*)::text AS public_execute_count FROM pg_proc routine
           JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
          CROSS JOIN LATERAL aclexplode(COALESCE(
            routine.proacl,acldefault('f',routine.proowner))) acl
          WHERE namespace.nspname='platform' AND routine.proname LIKE 'memory_%'
            AND acl.grantee=0 AND acl.privilege_type='EXECUTE'`,
      );
      expect(publicExecute.rows).toEqual([{ public_execute_count: "0" }]);

      await bootstrap.query("BEGIN");
      await bootstrap.query("SET CONSTRAINTS ALL DEFERRED");
      for (const [entryRef, revisionRef] of [
        [targetEntryRef, targetRevisionRef], [postCutoffEntryRef, postCutoffRevisionRef],
      ] as const) {
        await bootstrap.query(
          `INSERT INTO platform.memory_entry
             (site_ref,space_ref,entry_ref,version,current_revision,current_revision_ref,state,
              category,feature_policy_revision_ref,space_generation,learning_generation,
              revocation_epoch,created_at,updated_at)
           VALUES ($1,$2,$3,1,1,$4,'active','fact',$5,1,1,1,
             statement_timestamp(),statement_timestamp())`,
          [siteRef, userSpaceRef, entryRef, revisionRef, featurePolicyRef],
        );
        await bootstrap.query(
          `INSERT INTO platform.memory_revision
             (site_ref,space_ref,entry_ref,revision,revision_ref,reason,supersedes_revision,
              supersedes_revision_ref,feature_policy_revision_ref,recorded_at)
           VALUES ($1,$2,$3,1,$4,'explicit',NULL,NULL,$5,statement_timestamp())`,
          [siteRef, userSpaceRef, entryRef, revisionRef, featurePolicyRef],
        );
        await bootstrap.query(
          `INSERT INTO platform.memory_revision_payload
             (site_ref,space_ref,entry_ref,revision,revision_ref,envelope_version,
              protection_key_revision,nonce,protected_ciphertext,authentication_tag,aad_digest,
              protected_at)
           VALUES ($1,$2,$3,1,$4,1,'memory-key-v1',$5::bytea,$6::bytea,$7::bytea,$8,
             statement_timestamp())`,
          [siteRef, userSpaceRef, entryRef, revisionRef, Buffer.alloc(12, 1),
            Buffer.from([1, 2, 3]), Buffer.alloc(16, 2), "b".repeat(64)],
        );
      }
      await bootstrap.query(
        `INSERT INTO platform.memory_public_command_inbox
           (site_ref,command_ref,owner_scope_kind,owner_subject_ref,owner_subject_generation,
            operation,request_digest,request_digest_key_revision,request_payload_digest,
            request_payload_key_revision,state,prepare_ref,
            expected_state_digest,created_at)
         VALUES ($1,$2,'user',$3,1,'reset',$4,'memory-command-hmac-r1',$6,
           'memory-replay-r1','accepted',
           'foundation-purge-prepare',$5,statement_timestamp())`,
        [siteRef, purgeCommandRef, subjectRef, "c".repeat(64), "e".repeat(64), "a".repeat(64)],
      );
      for (const [commandRef, digest] of [
        [exhaustedPurgeCommandRef, "8".repeat(64)],
        [liveExhaustedPurgeCommandRef, "9".repeat(64)],
      ] as const) {
        await bootstrap.query(
          `INSERT INTO platform.memory_public_command_inbox
             (site_ref,command_ref,owner_scope_kind,owner_subject_ref,owner_subject_generation,
              operation,request_digest,request_digest_key_revision,request_payload_digest,
              request_payload_key_revision,state,prepare_ref,
              expected_state_digest,created_at)
           VALUES ($1,$2,'user',$3,1,'reset',$4,'memory-command-hmac-r1',$6,
             'memory-replay-r1','accepted',
             'foundation-exhausted-prepare',$5,statement_timestamp())`,
          [siteRef, commandRef, subjectRef, digest, "f".repeat(64), "b".repeat(64)],
        );
      }
      await bootstrap.query(
        `INSERT INTO platform.memory_purge_job
           (site_ref,purge_job_ref,command_ref,space_ref,entry_ref,space_generation,
            learning_generation,revocation_epoch,frozen_manifest_version,revision_target_count,
            revision_target_manifest_digest,ingress_cutoff,materialization_cutoff,state,
            next_attempt_at,created_at,updated_at)
         VALUES ($1,$2,$3,$4,NULL,1,1,1,1,1,$5,0,0,'queued',statement_timestamp(),
           statement_timestamp(),statement_timestamp())`,
        [siteRef, purgeJobRef, purgeCommandRef, userSpaceRef, "d".repeat(64)],
      );
      await bootstrap.query(
        `INSERT INTO platform.memory_purge_job
           (site_ref,purge_job_ref,command_ref,space_ref,entry_ref,space_generation,
            learning_generation,revocation_epoch,frozen_manifest_version,revision_target_count,
            revision_target_manifest_digest,ingress_cutoff,materialization_cutoff,state,
            attempt_count,lease_epoch,lease_token_hash,worker_id,lease_expires_at,next_attempt_at,
            created_at,updated_at)
         VALUES
           ($1,$2,$3,$4,NULL,1,1,1,1,0,$5,0,0,'leased',100,100,$6,'exhausted-worker',
             statement_timestamp()-interval '1 minute',statement_timestamp()-interval '2 minutes',
             statement_timestamp()-interval '3 minutes',statement_timestamp()-interval '1 minute'),
           ($1,$7,$8,$4,NULL,1,1,1,1,0,$9,0,0,'leased',100,100,$10,'active-worker',
             statement_timestamp()+interval '10 minutes',statement_timestamp()-interval '2 minutes',
             statement_timestamp()-interval '3 minutes',statement_timestamp())`,
        [siteRef, exhaustedPurgeJobRef, exhaustedPurgeCommandRef, userSpaceRef,
          "6".repeat(64), "4".repeat(64), liveExhaustedPurgeJobRef,
          liveExhaustedPurgeCommandRef, "7".repeat(64), "5".repeat(64)],
      );
      await bootstrap.query(
        `INSERT INTO platform.memory_purge_revision_target
           (site_ref,purge_job_ref,target_ordinal,space_ref,entry_ref,revision,revision_ref,
            space_generation,learning_generation,revocation_epoch,targeted_at)
         VALUES ($1,$2,0,$3,$4,1,$5,1,1,1,statement_timestamp())`,
        [siteRef, purgeJobRef, userSpaceRef, targetEntryRef, targetRevisionRef],
      );
      await bootstrap.query("COMMIT");

      const leaseTokenHash = "e".repeat(64);
      await expect(workerClient.query(
        "SELECT * FROM platform.memory_worker_claim_purge($1,$2::char(64),60)",
        ["memory-worker-component", leaseTokenHash],
      )).resolves.toMatchObject({ rows: [{ site_ref: siteRef, purge_job_ref: purgeJobRef,
        lease_epoch: "1" }] });
      const exhaustedClaims = await bootstrap.query<{
        purge_job_ref: string; state: string; attempt_count: number;
        lease_cleared: boolean;
      }>(
        `SELECT purge_job_ref,state,attempt_count,
          lease_token_hash IS NULL AND worker_id IS NULL AND lease_expires_at IS NULL
            AS lease_cleared
         FROM platform.memory_purge_job WHERE site_ref=$1 AND purge_job_ref=ANY($2::text[])
         ORDER BY purge_job_ref`,
        [siteRef, [exhaustedPurgeJobRef, liveExhaustedPurgeJobRef]],
      );
      expect(exhaustedClaims.rows).toEqual([
        { purge_job_ref: exhaustedPurgeJobRef, state: "failed", attempt_count: 100,
          lease_cleared: true },
        { purge_job_ref: liveExhaustedPurgeJobRef, state: "leased", attempt_count: 100,
          lease_cleared: false },
      ].sort((left, right) => left.purge_job_ref.localeCompare(right.purge_job_ref)));
      await expect(workerClient.query(
        `SELECT platform.memory_worker_record_purge_receipt(
          $1,$2,'revision_payload','completed',$3,$4::char(64),1,$5::char(64))`,
        [siteRef, purgeJobRef, `premature-${suffix}`, "f".repeat(64), leaseTokenHash],
      )).rejects.toThrow("MEMORY_PURGE_REVISION_TARGETS_INCOMPLETE");
      await expect(workerClient.query(
        `SELECT platform.memory_worker_record_purge_receipt(
          $1,$2,'revision_payload','completed',$3,$4::char(64),1,$5::char(64))`,
        [`wrong-${siteRef}`, purgeJobRef, `wrong-site-${suffix}`, "f".repeat(64),
          leaseTokenHash],
      )).rejects.toThrow();
      await expect(workerClient.query(
        `SELECT platform.memory_worker_delete_revision_payload(
          $1,$2,$3,$4,1,$5,1,$6::char(64)) AS outcome`,
        [purgeJobRef, siteRef, userSpaceRef, postCutoffEntryRef, postCutoffRevisionRef,
          leaseTokenHash],
      )).rejects.toThrow("MEMORY_PURGE_TARGET_FORBIDDEN");
      const deleteValues = [purgeJobRef, siteRef, userSpaceRef, targetEntryRef,
        targetRevisionRef, leaseTokenHash];
      await expect(workerClient.query(
        `SELECT platform.memory_worker_delete_revision_payload(
          $1,$2,$3,$4,1,$5,1,$6::char(64)) AS outcome`, deleteValues,
      )).resolves.toMatchObject({ rows: [{ outcome: "deleted" }] });
      await expect(workerClient.query(
        `SELECT platform.memory_worker_delete_revision_payload(
          $1,$2,$3,$4,1,$5,1,$6::char(64)) AS outcome`, deleteValues,
      )).resolves.toMatchObject({ rows: [{ outcome: "already_deleted" }] });
      await expect(workerClient.query(
        `SELECT platform.memory_worker_record_purge_receipt(
          $1,$2,'revision_payload','completed',$3,$4::char(64),1,$5::char(64))`,
        [siteRef, purgeJobRef, `receipt-${suffix}`, "1".repeat(64), leaseTokenHash],
      )).resolves.toMatchObject({ rowCount: 1 });
      for (const [participant, status] of [
        ["public_presentation_cache", "completed"],
        ["import_quarantine_object", "completed"],
        ["export_object", "completed"],
        ["command_outbox_payload", "completed"],
        ["backup_object_gc", "completed"],
        ["lexical_index", "not_applicable"],
        ["selection_snapshot", "not_applicable"],
        ["context_use", "not_applicable"],
        ["proposal_payload", "not_applicable"],
        ["embedding", "not_applicable"],
        ["ga_checkpoint_evidence", "not_applicable"],
      ] as const) {
        await expect(workerClient.query(
          `SELECT platform.memory_worker_record_purge_receipt(
            $1,$2,$3,$4,$5,$6::char(64),1,$7::char(64))`,
          [siteRef, purgeJobRef, participant, status, `receipt-${participant}-${suffix}`,
            createHash("sha256").update(participant).digest("hex"), leaseTokenHash],
        )).resolves.toMatchObject({ rowCount: 1 });
      }
      await expect(workerClient.query(
        `SELECT platform.memory_worker_finalize_purge($1,$2,1,$3::char(64)) AS outcome`,
        [siteRef, purgeJobRef, leaseTokenHash],
      )).resolves.toMatchObject({ rows: [{ outcome: "completed" }] });
      await expect(workerClient.query(
        `SELECT platform.memory_worker_finalize_purge($1,$2,1,$3::char(64)) AS outcome`,
        [siteRef, purgeJobRef, leaseTokenHash],
      )).resolves.toMatchObject({ rows: [{ outcome: "already_completed" }] });

      const pinnedPreflightClient = new Client({ connectionString: migratorDatabaseUrl });
      await pinnedPreflightClient.connect();
      let migrationExecuted = false;
      try {
        await pinnedPreflightClient.query("BEGIN");
        await pinnedPreflightClient.query(
          `UPDATE platform.memory_database_role_identity
              SET role_oid=(SELECT oid FROM pg_roles WHERE rolname=$1)
            WHERE role_kind='worker'`,
          [apiUser],
        );
        await expect(runPlatformMigrations({
          environment: platformMigrationEnvironment(),
          createLockClient: () => ({
            connect: async () => undefined,
            query: (sql, values) => pinnedPreflightClient.query(sql, values as unknown[]),
            end: async () => undefined,
          }),
          execute: async () => {
            migrationExecuted = true;
            return 0;
          },
        })).rejects.toThrow("PLATFORM_MEMORY_ROLE_IDENTITY_PREFLIGHT_FAILED");
        expect(migrationExecuted).toBe(false);
      } finally {
        await pinnedPreflightClient.query("ROLLBACK");
        await pinnedPreflightClient.end();
      }

      const missingIdentityClient = new Client({ connectionString: migratorDatabaseUrl });
      await missingIdentityClient.connect();
      let missingIdentityMigrationExecuted = false;
      try {
        await missingIdentityClient.query("BEGIN");
        await missingIdentityClient.query(
          "GRANT USAGE ON SCHEMA platform TO platform_memory_public",
        );
        await missingIdentityClient.query("DROP TABLE platform.memory_database_role_identity");
        await expect(runPlatformMigrations({
          environment: platformMigrationEnvironment(),
          createLockClient: () => ({
            connect: async () => undefined,
            query: (sql, values) => missingIdentityClient.query(sql, values as unknown[]),
            end: async () => undefined,
          }),
          execute: async () => {
            missingIdentityMigrationExecuted = true;
            return 0;
          },
        })).rejects.toThrow("PLATFORM_MEMORY_ROLE_IDENTITY_PREFLIGHT_FAILED");
        expect(missingIdentityMigrationExecuted).toBe(false);
        await expect(missingIdentityClient.query(
          "SELECT has_schema_privilege('platform_memory_public','platform','USAGE') AS retained",
        )).resolves.toMatchObject({ rows: [{ retained: true }] });
      } finally {
        await missingIdentityClient.query("ROLLBACK");
        await missingIdentityClient.end();
      }

      const databaseGrantClient = new Client({ connectionString: migratorDatabaseUrl });
      await databaseGrantClient.connect();
      try {
        await databaseGrantClient.query("BEGIN");
        await databaseGrantClient.query(
          `GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} ` +
            "TO platform_memory_public WITH GRANT OPTION",
        );
        await expect(runPlatformMigrations({
          environment: platformMigrationEnvironment(),
          createLockClient: () => ({
            connect: async () => undefined,
            query: (sql, values) => databaseGrantClient.query(sql, values as unknown[]),
            end: async () => undefined,
          }),
          execute: async () => 0,
        })).rejects.toThrow("PLATFORM_MEMORY_ROLE_AUTHORITY_INVALID");
      } finally {
        await databaseGrantClient.query("ROLLBACK");
        await databaseGrantClient.end();
      }

      const exactAuthorityClient = new Client({ connectionString: migratorDatabaseUrl });
      await exactAuthorityClient.connect();
      const probeSchema = `memory_authority_probe_${suffix.replaceAll("-", "")}`;
      try {
        await exactAuthorityClient.query("BEGIN");
        await exactAuthorityClient.query(`CREATE SCHEMA ${quoteIdentifier(probeSchema)}`);
        await exactAuthorityClient.query(
          `CREATE TABLE ${quoteIdentifier(probeSchema)}.probe_table(id BIGINT)`,
        );
        await exactAuthorityClient.query(
          `CREATE SEQUENCE ${quoteIdentifier(probeSchema)}.probe_sequence`,
        );
        await exactAuthorityClient.query(
          `CREATE FUNCTION ${quoteIdentifier(probeSchema)}.probe_routine() RETURNS BIGINT ` +
            "LANGUAGE SQL AS 'SELECT 1::bigint'",
        );
        await exactAuthorityClient.query(
          `REVOKE ALL ON FUNCTION ${quoteIdentifier(probeSchema)}.probe_routine() FROM PUBLIC`,
        );
        await exactAuthorityClient.query(
          `GRANT USAGE ON SCHEMA ${quoteIdentifier(probeSchema)} TO platform_memory_public`,
        );
        await exactAuthorityClient.query(
          `GRANT SELECT ON TABLE ${quoteIdentifier(probeSchema)}.probe_table ` +
            "TO platform_memory_public",
        );
        await exactAuthorityClient.query(
          `GRANT USAGE ON SEQUENCE ${quoteIdentifier(probeSchema)}.probe_sequence ` +
            "TO platform_memory_runtime",
        );
        await exactAuthorityClient.query(
          `GRANT EXECUTE ON FUNCTION ${quoteIdentifier(probeSchema)}.probe_routine() ` +
            "TO platform_memory_worker WITH GRANT OPTION",
        );
        await exactAuthorityClient.query(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdentifier(probeSchema)} ` +
            "GRANT SELECT ON TABLES TO platform_memory_runtime",
        );
        await expect(runPlatformMigrations({
          environment: platformMigrationEnvironment(),
          createLockClient: () => ({
            connect: async () => undefined,
            query: (sql, values) => exactAuthorityClient.query(sql, values as unknown[]),
            end: async () => undefined,
          }),
          execute: async () => 0,
        })).rejects.toThrow("PLATFORM_MEMORY_ROLE_AUTHORITY_INVALID");
      } finally {
        await exactAuthorityClient.query("ROLLBACK");
        await exactAuthorityClient.end();
      }

      const publicDefaultClient = new Client({ connectionString: migratorDatabaseUrl });
      await publicDefaultClient.connect();
      try {
        await publicDefaultClient.query("BEGIN");
        await publicDefaultClient.query(
          "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC",
        );
        await expect(runPlatformMigrations({
          environment: platformMigrationEnvironment(),
          createLockClient: () => ({
            connect: async () => undefined,
            query: (sql, values) => publicDefaultClient.query(sql, values as unknown[]),
            end: async () => undefined,
          }),
          execute: async () => 0,
        })).rejects.toThrow("PLATFORM_MEMORY_ROLE_AUTHORITY_INVALID");
      } finally {
        await publicDefaultClient.query("ROLLBACK");
        await publicDefaultClient.end();
      }

      const sentinelOwner = `memory_default_sentinel_${suffix.replaceAll("-", "")}`;
      await bootstrap.query("BEGIN");
      try {
        await bootstrap.query(
          `CREATE ROLE ${quoteIdentifier(sentinelOwner)} ` +
            "LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
        );
        await bootstrap.query(
          `GRANT CREATE ON SCHEMA public TO ${quoteIdentifier(sentinelOwner)}`,
        );
        const implicitRoutineDefault = await bootstrap.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM pg_default_acl defaults
           JOIN pg_roles owner ON owner.oid=defaults.defaclrole
           WHERE owner.rolname=$1 AND defaults.defaclnamespace=0
             AND defaults.defaclobjtype='f'`,
          [sentinelOwner],
        );
        expect(implicitRoutineDefault.rows).toEqual([{ count: "0" }]);
        await bootstrap.query("SET LOCAL ROLE platform_migrator");
        await expect(runPlatformMigrations({
          environment: platformMigrationEnvironment(),
          createLockClient: () => ({
            connect: async () => undefined,
            query: (sql, values) => bootstrap.query(sql, values as unknown[]),
            end: async () => undefined,
          }),
          execute: async () => 0,
        })).rejects.toThrow("PLATFORM_MEMORY_ROLE_AUTHORITY_INVALID");
        await bootstrap.query("RESET ROLE");
        await bootstrap.query(
          `REVOKE CREATE ON SCHEMA public FROM ${quoteIdentifier(sentinelOwner)}`,
        );
        await bootstrap.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(sentinelOwner)} ` +
            "GRANT SELECT ON TABLES TO PUBLIC",
        );
        await bootstrap.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(sentinelOwner)} ` +
            "GRANT USAGE ON SEQUENCES TO PUBLIC",
        );
        await bootstrap.query("SET LOCAL ROLE platform_migrator");
        await runPlatformMigrations({
          environment: platformMigrationEnvironment(),
          createLockClient: () => ({
            connect: async () => undefined,
            query: (sql, values) => bootstrap.query(sql, values as unknown[]),
            end: async () => undefined,
          }),
          execute: async () => 0,
        });
        await bootstrap.query("RESET ROLE");
        const sentinelDefaults = await bootstrap.query<{
          object_type: string; privilege_type: string; is_grantable: boolean;
        }>(
          `SELECT candidate.object_type::text,acl.privilege_type,acl.is_grantable
           FROM pg_roles owner
           CROSS JOIN LATERAL (VALUES ('S'::"char"),('f'::"char"),('r'::"char"))
             candidate(object_type)
           CROSS JOIN LATERAL aclexplode(COALESCE(
             (SELECT defaults.defaclacl FROM pg_default_acl defaults
              WHERE defaults.defaclrole=owner.oid AND defaults.defaclnamespace=0
                AND defaults.defaclobjtype=candidate.object_type),
             acldefault(candidate.object_type,owner.oid)
           )) acl
           WHERE owner.rolname=$1 AND acl.grantee=0
           ORDER BY candidate.object_type,acl.privilege_type`,
          [sentinelOwner],
        );
        expect(sentinelDefaults.rows).toEqual([
          { object_type: "S", privilege_type: "USAGE", is_grantable: false },
          { object_type: "f", privilege_type: "EXECUTE", is_grantable: false },
          { object_type: "r", privilege_type: "SELECT", is_grantable: false },
        ]);
      } finally {
        await bootstrap.query("ROLLBACK");
      }

      const oidMismatchReceiptRef = `memory-oid-mismatch-${suffix}`;
      await bootstrap.query("BEGIN");
      await bootstrap.query(
        `UPDATE platform.memory_database_role_identity
            SET role_oid=(SELECT oid FROM pg_roles WHERE rolname=$1)
          WHERE role_kind='worker'`,
        [apiUser],
      );
      await bootstrap.query("SET LOCAL SESSION AUTHORIZATION platform_memory_worker");
      await expect(bootstrap.query(
        `SELECT platform.memory_worker_record_purge_receipt(
          $1,$2,'revision_payload','completed',$3,$4::char(64),1,$5::char(64))`,
        [siteRef, purgeJobRef, oidMismatchReceiptRef, "2".repeat(64), leaseTokenHash],
      )).rejects.toThrow("MEMORY_DATABASE_ROLE_FORBIDDEN");
      await bootstrap.query("ROLLBACK");
      const oidMismatchFact = await bootstrap.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM platform.memory_purge_participant_receipt
          WHERE receipt_ref=$1`,
        [oidMismatchReceiptRef],
      );
      expect(oidMismatchFact.rows).toEqual([{ count: "0" }]);
    } finally {
      try {
        await bootstrap.query("ROLLBACK");
        await bootstrap.query("BEGIN");
        await bootstrap.query("SET CONSTRAINTS ALL DEFERRED");
        await bootstrap.query("SET LOCAL session_replication_role='replica'");
        await bootstrap.query(
          "DELETE FROM platform.memory_purge_participant_receipt WHERE site_ref=$1",
          [siteRef],
        );
        await bootstrap.query(
          "DELETE FROM platform.memory_purge_revision_target WHERE site_ref=$1",
          [siteRef],
        );
        await bootstrap.query("DELETE FROM platform.memory_purge_job WHERE site_ref=$1", [siteRef]);
        await bootstrap.query(
          "DELETE FROM platform.memory_public_command_inbox WHERE site_ref=$1",
          [siteRef],
        );
        await bootstrap.query("DELETE FROM platform.memory_revision_payload WHERE site_ref=$1", [
          siteRef,
        ]);
        await bootstrap.query("DELETE FROM platform.memory_provenance WHERE site_ref=$1", [
          siteRef,
        ]);
        await bootstrap.query("DELETE FROM platform.memory_command_receipt WHERE site_ref=$1", [
          siteRef,
        ]);
        await bootstrap.query("DELETE FROM platform.memory_entry WHERE site_ref=$1", [siteRef]);
        await bootstrap.query("DELETE FROM platform.memory_revision WHERE site_ref=$1", [siteRef]);
        await bootstrap.query("DELETE FROM platform.memory_space WHERE site_ref=$1", [siteRef]);
        await bootstrap.query(
          `DELETE FROM platform.authorization_project_membership
            WHERE project_ref=$1 AND subject_ref=$2`,
          [projectRef, subjectRef],
        );
        await bootstrap.query(
          "DELETE FROM platform.identity_execution_space WHERE execution_space_ref=$1",
          [executionSpaceRef],
        );
        await bootstrap.query("DELETE FROM platform.authorization_project WHERE project_ref=$1", [
          projectRef,
        ]);
        await bootstrap.query("DELETE FROM platform.authorization_subject WHERE subject_ref=$1", [
          subjectRef,
        ]);
        await bootstrap.query(
          "DELETE FROM platform.authorization_site_release WHERE release_ref=$1",
          [releaseRef],
        );
        await bootstrap.query("DELETE FROM platform.authorization_site WHERE site_ref=$1", [
          siteRef,
        ]);
        await bootstrap.query("COMMIT");
        const inventory = await bootstrap.query<{ remaining: string }>(
          `SELECT (
             (SELECT count(*) FROM platform.memory_space WHERE site_ref=$1)+
             (SELECT count(*) FROM platform.memory_entry WHERE site_ref=$1)+
             (SELECT count(*) FROM platform.memory_revision WHERE site_ref=$1)+
             (SELECT count(*) FROM platform.memory_revision_payload WHERE site_ref=$1)+
             (SELECT count(*) FROM platform.memory_public_command_inbox WHERE site_ref=$1)+
             (SELECT count(*) FROM platform.memory_purge_job WHERE site_ref=$1)+
             (SELECT count(*) FROM platform.memory_purge_revision_target WHERE site_ref=$1)+
             (SELECT count(*) FROM platform.memory_purge_participant_receipt WHERE site_ref=$1)+
             (SELECT count(*) FROM platform.authorization_site WHERE site_ref=$1)
           )::text AS remaining`,
          [siteRef],
        );
        expect(inventory.rows).toEqual([{ remaining: "0" }]);
        expect(await readMemoryAuthorityInventory(bootstrap)).toEqual(authorityInventoryBefore);
      } finally {
        await Promise.allSettled([
          bootstrap.end(),
          publicClient.end(),
          runtimeClient.end(),
          workerClient.end(),
          neighborClient.end(),
        ]);
      }
    }
  }, MEMORY_FEATURE_OFF_AUTHORITY_TEST_TIMEOUT_MS);

  it("rejects digest-incoherent direct root UUID and decimal spellings before persistence", async () => {
    const bootstrap = new Client({ connectionString: bootstrapDatabaseUrl });
    await bootstrap.connect();
    try {
      const closure = directRootCanonicalPayload("closure");
      const closureCommand = closure.command as Record<string, unknown>;
      const closureBudget = closureCommand.budget as Record<string, unknown>;
      closureBudget.executionBudgetRootRef = "00000000-0000-7000-8000-0000000000AA";
      await expect(bootstrap.query(
        "SELECT platform.commit_execution_root_closure($1::jsonb)",
        [JSON.stringify(closure)],
      )).rejects.toThrow("CREDIT_DIRECT_ROOT_CANONICAL_VALUE_INVALID");

      const reconciliation = directRootCanonicalPayload("reconciliation");
      const reconciliationCommand = reconciliation.command as Record<string, unknown>;
      const reconciliationBudget = reconciliationCommand.budget as Record<string, unknown>;
      reconciliationBudget.reservedCeiling = "1e2";
      await expect(bootstrap.query(
        "SELECT platform.mark_execution_root_reconciliation($1::jsonb)",
        [JSON.stringify(reconciliation)],
      )).rejects.toThrow("CREDIT_DIRECT_ROOT_CANONICAL_VALUE_INVALID");

      const { rows } = await bootstrap.query<{ closure_count: string; reconciliation_count: string }>(
        `SELECT
           (SELECT count(*)::text FROM platform.credit_execution_root_closure_receipt
             WHERE business_operation_key='canonical-regression:one') AS closure_count,
           (SELECT count(*)::text FROM platform.credit_execution_root_reconciliation
             WHERE business_operation_key='canonical-regression:one') AS reconciliation_count`,
      );
      expect(rows[0]).toEqual({ closure_count: "0", reconciliation_count: "0" });
    } finally {
      await bootstrap.end();
    }
  });

  it("binds a leased Admission role to terminal Credit closure authority without inheritance", async () => {
    expect(admissionUser).toMatch(/^kt_pg_[a-z0-9_]+$/u);
    const admission = new Client({ connectionString: admissionDatabaseUrl });
    const bootstrap = new Client({ connectionString: bootstrapDatabaseUrl });
    const productionAdmission = createPlatformDatabaseClient(
      loadPlatformDatabaseConfig("admission", {
        DATABASE_URL_PLATFORM: admissionDatabaseUrl,
        PLATFORM_DATABASE_CREDENTIAL_CLASS: "admission",
        PLATFORM_DATABASE_ADMISSION_ROLE: admissionUser,
        PLATFORM_DATABASE_MIGRATOR_ROLE: migratorUser,
        PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
      }),
    );
    await Promise.all([admission.connect(), bootstrap.connect()]);
    const routines = [
      "platform.admission_role_identity_is_current()",
      "platform.record_admission_verified_terminal_evidence(text,text,text,text,text,text,text,character)",
      "platform.find_execution_root_closure(text,jsonb,text,character)",
      "platform.lock_execution_root_closure(text,jsonb,text,uuid,uuid,uuid,uuid,uuid,text,bigint,bigint,bigint,numeric,text)",
      "platform.commit_execution_root_closure(jsonb)",
      "platform.mark_execution_root_reconciliation(jsonb)",
    ] as const;
    try {
      await productionAdmission.connect();
      await productionAdmission.checkHealth();

      const identity = await admission.query<{
        current_user: string;
        identity_exact: boolean;
        all_routines: boolean;
      }>(
        `SELECT current_user,
                platform.admission_role_identity_is_current() AS identity_exact,
                bool_and(has_function_privilege(current_user,routine,'EXECUTE')) AS all_routines
           FROM unnest($1::text[]) routine
          GROUP BY current_user`,
        [routines],
      );
      expect(identity.rows).toEqual([{
        current_user: admissionUser,
        identity_exact: true,
        all_routines: true,
      }]);

      const role = await bootstrap.query<{
        inherits: boolean;
        bypasses_rls: boolean;
        inherits_canonical_admission: boolean;
      }>(
        `SELECT runtime_role.rolinherit AS inherits,
                runtime_role.rolbypassrls AS bypasses_rls,
                pg_has_role(runtime_role.rolname,'platform_admission','MEMBER')
                  AS inherits_canonical_admission
           FROM pg_roles runtime_role WHERE runtime_role.rolname=$1`,
        [admissionUser],
      );
      expect(role.rows).toEqual([{
        inherits: false,
        bypasses_rls: false,
        inherits_canonical_admission: false,
      }]);

      const policies = await bootstrap.query<{
        relation_name: string;
        schema_owner_only: boolean;
        using_expression: string;
        with_check_expression: string;
      }>(
        `SELECT relation.relname AS relation_name,
                policy.polroles=ARRAY[namespace.nspowner]::oid[] AS schema_owner_only,
                pg_get_expr(policy.polqual,policy.polrelid,false) AS using_expression,
                pg_get_expr(policy.polwithcheck,policy.polrelid,false) AS with_check_expression
           FROM pg_policy policy
           JOIN pg_class relation ON relation.oid=policy.polrelid
           JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
          WHERE namespace.nspname='platform' AND relation.relname=ANY($1::text[])
          ORDER BY relation.relname`,
        [[
          "admission_verified_terminal_evidence",
          "credit_execution_root_closure_receipt",
          "credit_execution_root_outcome",
          "credit_execution_root_reconciliation",
        ]],
      );
      expect(policies.rows).toHaveLength(4);
      expect(policies.rows.every((policy) =>
        policy.schema_owner_only &&
        policy.using_expression.includes("admission_role_identity_is_current") &&
        policy.with_check_expression.includes("admission_role_identity_is_current")))
        .toBe(true);

      const apiAuthority = await bootstrap.query<{ can_execute: boolean }>(
        `SELECT bool_or(has_function_privilege($1,routine,'EXECUTE')) AS can_execute
           FROM unnest($2::text[]) routine`,
        [apiUser, routines],
      );
      expect(apiAuthority.rows).toEqual([{ can_execute: false }]);
    } finally {
      await Promise.allSettled([
        productionAdmission.disconnect(),
        admission.end(),
        bootstrap.end(),
      ]);
    }
  });

  it("lets the exact leased Admission role reserve media access only inside its site fence", async () => {
    const suffix = randomUUID();
    const siteRef = `admission-media-site-${suffix}`;
    const bootstrap = new Client({ connectionString: bootstrapDatabaseUrl });
    const admission = new Client({ connectionString: admissionDatabaseUrl });
    await Promise.all([bootstrap.connect(), admission.connect()]);
    try {
      await bootstrap.query("BEGIN");
      await bootstrap.query("SELECT set_config('app.site_id',$1,true)", [siteRef]);
      await bootstrap.query(
        "INSERT INTO platform.site(site_ref,site_key,state) VALUES ($1,$2,'preview_ready')",
        [siteRef, `admission-media-${suffix.slice(0, 20)}`],
      );
      await bootstrap.query("COMMIT");

      const reserve = (commandId: string, digestSeed: string) => admission.query(
        `INSERT INTO platform.admission_media_access_authorization
           (handle_digest,site_id,project_ref,session_id,run_id,command_id,request_digest,
            configuration_revision_id,subject_ref,subject_generation,projection_reservation_digest,
            reservation_receipt_ref,input_policy_decision_ref,expires_at,state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13::timestamptz,'reserved')`,
        [digestSeed.repeat(64), siteRef, `project-${suffix}`, `session-${suffix}`, `run-${suffix}`,
          commandId, "c".repeat(64), `configuration-${suffix}`, `subject-${suffix}`,
          "b".repeat(64), `reservation-receipt-${suffix}`, `policy-${suffix}`,
          new Date(Date.now() + 60_000).toISOString()],
      );

      await admission.query("BEGIN");
      await admission.query(
        `SELECT set_config('app.operation','admission.command',true),
                set_config('app.workload_kind','platform_admission',true),
                set_config('app.site_id',$1,true)`,
        [siteRef],
      );
      await expect(reserve(`media-command-${suffix}`, "a")).resolves.toMatchObject({ rowCount: 1 });
      await admission.query("ROLLBACK");

      await admission.query("BEGIN");
      await admission.query(
        `SELECT set_config('app.operation','admission.command',true),
                set_config('app.workload_kind','platform_admission',true),
                set_config('app.site_id',$1,true)`,
        [`foreign-${siteRef}`],
      );
      await expect(reserve(`foreign-media-command-${suffix}`, "d"))
        .rejects.toMatchObject({ code: "42501" });
      await admission.query("ROLLBACK");
    } finally {
      await admission.query("ROLLBACK").catch(() => undefined);
      await bootstrap.query("ROLLBACK").catch(() => undefined);
      await bootstrap.query("BEGIN").catch(() => undefined);
      await bootstrap.query("SELECT set_config('app.site_id',$1,true)", [siteRef])
        .catch(() => undefined);
      await bootstrap.query("DELETE FROM platform.site WHERE site_ref=$1", [siteRef])
        .catch(() => undefined);
      await bootstrap.query("COMMIT").catch(() => undefined);
      await Promise.allSettled([admission.end(), bootstrap.end()]);
    }
  });

  it("rejects a Media execution-root proof presented by the Admission database role", async () => {
    const admission = new Client({ connectionString: admissionDatabaseUrl });
    await admission.connect();
    try {
      const payload = directRootCanonicalPayload("closure");
      const identity = payload.identity as Record<string, unknown>;
      await expect(admission.query(
        "SELECT platform.find_execution_root_closure($1,$2::jsonb,$3,$4)",
        [identity.siteId, JSON.stringify(identity.ownerProof), identity.businessOperationKey,
          identity.requestDigest],
      )).rejects.toThrow("CREDIT_EXECUTION_ROOT_OWNER_ROLE_INVALID");
    } finally {
      await admission.end();
    }
  });

  it("enforces Artifact owner-query RLS and exact data-plane role OID/routine authority", async () => {
    const suffix = randomUUID();
    const siteRef = `artifact-site-${suffix}`;
    const subjectRef = `artifact-subject-${suffix}`;
    const projectRef = `artifact-project-${suffix}`;
    const ownedRef = `artifact-owned-${suffix}`;
    const ownedVersionRef = `artifact-version-owned-${suffix}`;
    const foreignRef = `artifact-foreign-${suffix}`;
    const foreignVersionRef = `artifact-version-foreign-${suffix}`;
    const bootstrap = new Client({ connectionString: bootstrapDatabaseUrl });
    const api = new Client({ connectionString: apiDatabaseUrl });
    const dataPlane = new Client({ connectionString: artifactDataPlaneDatabaseUrl });
    await Promise.all([bootstrap.connect(), api.connect(), dataPlane.connect()]);
    try {
      await bootstrap.query("BEGIN");
      await bootstrap.query(
        "INSERT INTO platform.site(site_ref,site_key,state) VALUES ($1,$2,'preview_ready')",
        [siteRef, `artifact-${suffix.slice(0, 24)}`],
      );
      for (const [artifactRef, versionRef, owner] of [
        [ownedRef, ownedVersionRef, subjectRef],
        [foreignRef, foreignVersionRef, `foreign-${subjectRef}`],
      ] as const) {
        await bootstrap.query(
          `INSERT INTO platform.artifact(artifact_ref,site_ref,subject_ref,subject_generation,
             project_ref,media_class,current_artifact_version_ref,created_at,updated_at)
           VALUES ($1,$2,$3,1,$4,'image',$5,statement_timestamp(),statement_timestamp())`,
          [artifactRef, siteRef, owner, projectRef, versionRef],
        );
        await bootstrap.query(
          `INSERT INTO platform.artifact_version(artifact_version_ref,artifact_ref,site_ref,
             subject_ref,subject_generation,project_ref,state,owner_version,created_at,updated_at)
           VALUES ($1,$2,$3,$4,1,$5,'reserved',1,statement_timestamp(),statement_timestamp())`,
          [versionRef, artifactRef, siteRef, owner, projectRef],
        );
      }
      await bootstrap.query("COMMIT");

      await api.query(
        `SELECT set_config('app.site_id',$1,false),set_config('app.subject_id',$2,false),
                set_config('app.subject_generation','1',false),
                set_config('app.project_id',$3,false)`,
        [siteRef, subjectRef, projectRef],
      );
      await expect(api.query(
        "SELECT artifact_ref FROM platform.list_owned_artifacts(NULL,NULL,101)",
      )).resolves.toMatchObject({ rows: [{ artifact_ref: ownedRef }] });

      await expect(dataPlane.query(
        "SELECT platform.assert_artifact_delivery_data_plane_role()",
      )).resolves.toMatchObject({ rowCount: 1 });
      await expect(dataPlane.query(
        `SELECT authorization_ref FROM
           platform.find_artifact_delivery_authorization_by_capability($1::char(64))`,
        ["0".repeat(64)],
      )).resolves.toMatchObject({ rowCount: 0 });
      await expect(dataPlane.query("SELECT artifact_ref FROM platform.artifact LIMIT 1"))
        .rejects.toMatchObject({ code: "42501" });
      await expect(dataPlane.query(
        "SELECT artifact_ref FROM platform.list_owned_artifacts(NULL,NULL,1)",
      )).rejects.toMatchObject({ code: "42501" });
      await expect(bootstrap.query(
        `SELECT identity.role_name=$1::name AS "nameMatches",
                identity.role_oid=(SELECT oid FROM pg_roles WHERE rolname=$1) AS "oidMatches"
           FROM platform.artifact_delivery_data_plane_role_identity identity`,
        [artifactDataPlaneUser],
      )).resolves.toMatchObject({ rows: [{ nameMatches: true, oidMatches: true }] });
    } finally {
      await bootstrap.query("ROLLBACK").catch(() => undefined);
      await bootstrap.query("BEGIN").catch(() => undefined);
      await bootstrap.query("SET CONSTRAINTS ALL DEFERRED").catch(() => undefined);
      await bootstrap.query(
        "DELETE FROM platform.artifact_version WHERE artifact_ref=ANY($1::text[])",
        [[ownedRef, foreignRef]],
      ).catch(() => undefined);
      await bootstrap.query(
        "DELETE FROM platform.artifact WHERE artifact_ref=ANY($1::text[])",
        [[ownedRef, foreignRef]],
      ).catch(() => undefined);
      await bootstrap.query("DELETE FROM platform.site WHERE site_ref=$1", [siteRef])
        .catch(() => undefined);
      await bootstrap.query("COMMIT").catch(() => undefined);
      await Promise.allSettled([bootstrap.end(), api.end(), dataPlane.end()]);
    }
  });

  it("creates exactly one Platform-owned schema and foundation marker", async () => {
    const direct = new Client({ connectionString: apiDatabaseUrl });
    await direct.connect();
    const result = await direct.query<{
      schema_name: string;
      table_name: string;
      schema_version: number;
    }>(`
      SELECT n.nspname AS schema_name,
             c.relname AS table_name,
             f."schemaVersion" AS schema_version
      FROM pg_namespace n
      JOIN pg_class c ON c.relnamespace = n.oid
      JOIN platform.platform_foundation f ON f.singleton = TRUE
      WHERE n.nspname = 'platform'
        AND c.relname = 'platform_foundation'
    `);

    await direct.end();
    expect(result.rows).toEqual([
      { schema_name: "platform", table_name: "platform_foundation", schema_version: 1 },
    ]);
  });

  it("serializes Media child authority in allocation-root-hold order and closes NULL receipt fences", async () => {
    const seed = creditConcurrencySeed();
    const setup = new Client({ connectionString: migratorDatabaseUrl });
    const first = new Client({ connectionString: migratorDatabaseUrl });
    const second = new Client({ connectionString: migratorDatabaseUrl });
    const observer = new Client({ connectionString: migratorDatabaseUrl });
    await Promise.all([setup.connect(), first.connect(), second.connect(), observer.connect()]);
    let firstLease: ReturnType<typeof issuePlatformTransaction> | null = null;
    let secondLease: ReturnType<typeof issuePlatformTransaction> | null = null;
    try {
      await insertCreditConcurrencySeed(setup, seed);
      const secondPid = await second.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await first.query("BEGIN");
      await second.query("BEGIN");
      await first.query("SELECT set_config('app.site_id',$1,true)", [seed.siteId]);
      await second.query("SELECT set_config('app.site_id',$1,true)", [seed.siteId]);
      await second.query("SET LOCAL statement_timeout='2s'");
      firstLease = issuePlatformTransaction(pgTransaction(first));
      secondLease = issuePlatformTransaction(pgTransaction(second));
      const input = { siteId: seed.siteId, executionBudgetRootRef: seed.rootRef,
        allocationRefs: [seed.allocationRef] };
      await expect(lockCreditFinancialAuthority(firstLease.transaction, input)).resolves.toEqual({
        creditHoldRef: seed.holdRef,
      });
      const waiting = lockCreditFinancialAuthority(secondLease.transaction, input);
      await expect(waitForPostgresLock(observer, secondPid.rows[0]?.pid)).resolves.toBe(true);
      await first.query("COMMIT");
      revokePlatformTransaction(firstLease);
      firstLease = null;
      await expect(waiting).resolves.toEqual({ creditHoldRef: seed.holdRef });
      await second.query("COMMIT");
      revokePlatformTransaction(secondLease);
      secondLease = null;

      await setup.query("BEGIN");
      await setup.query("SELECT set_config('app.site_id',$1,true)", [seed.siteId]);
      try {
        await expect(setup.query(
          `INSERT INTO platform.credit_budget_operation_receipt
           (operation_receipt_ref,site_ref,operation_kind,business_operation_key,request_digest,
            execution_budget_root_ref,authorization_segment_ref,outcome_kind,result,result_digest,
            outbox_event_ref,completed_at,parent_allocation_ref,child_allocation_ref,
            parent_before_revision,parent_after_revision,child_before_revision,child_after_revision,credit_amount)
           VALUES ($1::uuid,$2,'derive_media_child','null-fence',$3,$4::uuid,NULL,'accepted','{}'::jsonb,$3,
                   NULL,clock_timestamp(),$5::uuid,$6::uuid,NULL,2,0,1,1)`,
          [randomUUID(), seed.siteId, "a".repeat(64), seed.rootRef, seed.allocationRef, randomUUID()],
        )).rejects.toMatchObject({ code: "23514" });
      } finally {
        await setup.query("ROLLBACK");
      }

      const index = await setup.query<{ predicate: string | null }>(
        `SELECT pg_get_expr(index.indpred,index.indrelid) AS predicate
         FROM pg_index AS index
         JOIN pg_class AS relation ON relation.oid=index.indexrelid
         WHERE relation.relname='credit_budget_operation_receipt_return_child_latest_idx'`,
      );
      expect(index.rows).toHaveLength(1);
      expect(index.rows[0]?.predicate).toContain("return_media_child");
    } finally {
      if (firstLease !== null) revokePlatformTransaction(firstLease);
      if (secondLease !== null) revokePlatformTransaction(secondLease);
      await Promise.allSettled([first.query("ROLLBACK"), second.query("ROLLBACK")]);
      await Promise.allSettled([setup.end(), first.end(), second.end(), observer.end()]);
    }
  });

  it("enforces statement, lock, idle transaction, and isolation settings", async () => {
    const direct = new Client({
      connectionString: apiDatabaseUrl,
      options:
        "-c statement_timeout=15000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=10000",
    });
    await direct.connect();
    const result = await direct.query<{
      statement_timeout: string;
      lock_timeout: string;
      idle_timeout: string;
      isolation: string;
    }>(`
      SELECT current_setting('statement_timeout') AS statement_timeout,
             current_setting('lock_timeout') AS lock_timeout,
             current_setting('idle_in_transaction_session_timeout') AS idle_timeout,
             current_setting('transaction_isolation') AS isolation
    `);

    await direct.end();
    expect(result.rows).toEqual([
      {
        statement_timeout: "15s",
        lock_timeout: "3s",
        idle_timeout: "10s",
        isolation: "read committed",
      },
    ]);
  });

  it("keeps the singleton foundation invariant in PostgreSQL", async () => {
    const direct = new Client({ connectionString: migratorDatabaseUrl });
    await direct.connect();
    try {
      await expect(
        direct.query(
          `INSERT INTO platform.platform_foundation (singleton, "schemaVersion") VALUES (FALSE, 1)`,
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await direct.end();
    }
  });

  it("persists local Identity security facts without outbox rows and keeps Identity effects exact", async () => {
    const authority = new Client({ connectionString: migratorDatabaseUrl });
    const direct = new Client({ connectionString: apiDatabaseUrl });
    await Promise.all([authority.connect(), direct.connect()]);
    await authority.query(`
      INSERT INTO platform.authorization_site
        (site_ref,state,security_epoch,policy_epoch,revocation_epoch)
      VALUES ('component-security-site','active',1,1,1)
      ON CONFLICT (site_ref) DO NOTHING
    `);
    await direct.query("BEGIN");
    try {
      await direct.query(`
        INSERT INTO platform.authorization_subject
          (subject_ref,site_ref,display_name,state,subject_generation,restriction_epoch)
        VALUES ('component-security-subject','component-security-site','Security Test','active',1,1);
        INSERT INTO platform.authorization_identity_session
          (session_ref,subject_ref,site_ref,credential_digest,authentication_methods,state,
           session_epoch,credential_epoch,authenticated_at,expires_at,device_label,last_seen_at)
        VALUES (
          'component-security-session','component-security-subject','component-security-site',
          repeat('1',64),ARRAY['password']::TEXT[],'active',1,1,
          '2026-07-30T00:00:00Z','2026-07-31T00:00:00Z','Component Test',
          '2026-07-30T00:00:00Z'
        );
        INSERT INTO platform.identity_account
          (site_ref,account_ref,subject_ref,state,account_generation,security_epoch)
        VALUES (
          'component-security-site','component-security-account','component-security-subject',
          'active',1,1
        );
        INSERT INTO platform.command_receipt
          (command_id,environment,region,caller_identity,operation,idempotency_key,request_digest)
        VALUES (
          repeat('1',32),'production','test','component-security-caller',
          'identity-security-component','component-security-command',repeat('a',64)
        );
      `);

      const localEventIds = [
        "10000000-0000-4000-8000-000000000001",
        "10000000-0000-4000-8000-000000000002",
        "10000000-0000-4000-8000-000000000003",
      ] as const;
      const localEventTypes = [
        "identity.totp.enrollment_started",
        "identity.reauthentication.proof_issued",
        "identity.recovery_codes.regenerated",
      ] as const;
      for (const [index, eventId] of localEventIds.entries()) {
        await direct.query(
          `INSERT INTO platform.identity_security_event
           (event_id,site_ref,account_ref,subject_ref,session_ref,event_type,
            account_security_epoch,payload_digest,correlation_id,causation_id,occurred_at)
           VALUES (
             $1::uuid,'component-security-site','component-security-account',
             'component-security-subject','component-security-session',$2,1,
             repeat('b',64),'component-security-correlation',repeat('1',32),
             '2026-07-30T00:00:00Z'
           )`,
          [eventId, localEventTypes[index]],
        );
      }
      const persisted = await direct.query<{ event_type: string }>(
        `SELECT event_type FROM platform.identity_security_event
         WHERE event_id=ANY($1::uuid[]) ORDER BY event_type`,
        [localEventIds],
      );
      const shadowOutbox = await direct.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM platform.outbox_event
         WHERE event_id=ANY($1::uuid[])`,
        [localEventIds],
      );
      expect(persisted.rows.map((row) => row.event_type)).toEqual([...localEventTypes].sort());
      expect(shadowOutbox.rows).toEqual([{ count: "0" }]);

      const effectIds = [
        "20000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000002",
      ] as const;
      const effectTypes = [
        "identity.verification.delivery.requested",
        "identity.namespace.allocation.requested",
      ] as const;
      for (const [index, eventId] of effectIds.entries()) {
        await direct.query(
          `INSERT INTO platform.outbox_event
           (event_id,owner,event_type,aggregate_id,payload,payload_digest,correlation_id)
           VALUES ($1::uuid,'identity',$2,'component-effect','{}'::jsonb,repeat('c',64),
                   'component-security-correlation')`,
          [eventId, effectTypes[index]],
        );
      }
      const effects = await direct.query<{ event_type: string }>(
        `SELECT event_type FROM platform.outbox_event
         WHERE event_id=ANY($1::uuid[]) ORDER BY event_type`,
        [effectIds],
      );
      expect(effects.rows.map((row) => row.event_type)).toEqual([...effectTypes].sort());
      await expect(
        direct.query(
          `INSERT INTO platform.outbox_event
         (event_id,owner,event_type,aggregate_id,payload,payload_digest,correlation_id)
         VALUES (
           '30000000-0000-4000-8000-000000000001','identity',
           'identity.totp.enrollment_started','component-local-fact','{}'::jsonb,
           repeat('d',64),'component-security-correlation'
         )`,
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await direct.query("ROLLBACK");
      await direct.end();
      await authority.query(
        "DELETE FROM platform.authorization_site WHERE site_ref='component-security-site'",
      );
      await authority.end();
    }
  });

  it("enforces FORCE RLS and the complete producer/owner matrix", async () => {
    const migrator = new Client({ connectionString: migratorDatabaseUrl });
    const identity = new Client({ connectionString: identityWorkerDatabaseUrl });
    const assetDataPlane = new Client({ connectionString: assetDataPlaneDatabaseUrl });
    const producers = [
      { name: "api", url: apiDatabaseUrl, allowed: ["identity", "commerce", "asset"] },
      { name: "admission", url: admissionDatabaseUrl, allowed: ["credit"] },
      { name: "admin", url: adminDatabaseUrl, allowed: ["admin-execution", "commerce", "site"] },
      { name: "asset-worker", url: workerDatabaseUrls["asset-worker"], allowed: ["asset"] },
    ] as const;
    const allOwners = [
      "identity",
      "commerce",
      "asset",
      "credit",
      "site",
      "admin-execution",
    ] as const satisfies readonly OutboxOwner[];
    const clients = producers.map((producer) => new Client({ connectionString: producer.url }));
    const commerceWorker = new Client({ connectionString: workerDatabaseUrls["commerce-worker"] });
    const siteWorker = new Client({ connectionString: workerDatabaseUrls["site-worker"] });
    const adminWorker = new Client({ connectionString: workerDatabaseUrls["admin-worker"] });
    const insertedByOwner = new Map<string, string[]>();
    try {
      await Promise.all([
        migrator.connect(),
        identity.connect(),
        assetDataPlane.connect(),
        commerceWorker.connect(),
        siteWorker.connect(),
        adminWorker.connect(),
        ...clients.map((client) => client.connect()),
      ]);
      await expect(
        migrator.query<{
          row_level_security: boolean;
          force_row_level_security: boolean;
          policy_count: string;
          public_policy_count: string;
          restrictive_policy_count: string;
        }>(`
        SELECT relation.relrowsecurity AS row_level_security,
               relation.relforcerowsecurity AS force_row_level_security,
               count(policy.oid)::text AS policy_count,
               count(policy.oid) FILTER (WHERE 0=ANY(policy.polroles))::text AS public_policy_count,
               count(policy.oid) FILTER (WHERE NOT policy.polpermissive)::text
                 AS restrictive_policy_count
          FROM pg_class relation
          JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
          LEFT JOIN pg_policy policy ON policy.polrelid=relation.oid
         WHERE namespace.nspname='platform' AND relation.relname='outbox_event'
         GROUP BY relation.relrowsecurity,relation.relforcerowsecurity
      `),
      ).resolves.toMatchObject({
        rows: [
          {
            row_level_security: true,
            force_row_level_security: true,
            policy_count: "17",
            public_policy_count: "0",
            restrictive_policy_count: "0",
          },
        ],
      });
      await expect(
        migrator.query<{
          function_owner: string;
          security_definer: boolean;
          fixed_search_path: boolean;
          public_can_execute: boolean;
          data_plane_can_execute: boolean;
        }>(
          `
        SELECT function_owner.rolname AS function_owner,
               function_row.prosecdef AS security_definer,
               EXISTS (
                 SELECT 1
                   FROM unnest(COALESCE(function_row.proconfig,ARRAY[]::text[])) setting
                  WHERE replace(setting,' ','')='search_path=pg_catalog,platform'
               ) AS fixed_search_path,
               EXISTS (
                 SELECT 1 FROM aclexplode(COALESCE(
                   function_row.proacl,acldefault('f',function_row.proowner)
                 )) acl
                 WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
               ) AS public_can_execute,
               has_function_privilege(
                 $1,
                 function_row.oid,
                 'EXECUTE'
               ) AS data_plane_can_execute
          FROM pg_proc function_row
          JOIN pg_roles function_owner ON function_owner.oid=function_row.proowner
         WHERE function_row.oid=to_regprocedure(
           'platform.enqueue_asset_upload_completion_event(uuid,text,jsonb,character,text,text)'
         )
      `,
          [assetDataPlaneUser],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            function_owner: migratorUser,
            security_definer: true,
            fixed_search_path: true,
            public_can_execute: false,
            data_plane_can_execute: true,
          },
        ],
      });

      const assetCompletionEventId = randomUUID();
      const assetSessionRef = `asset-session-${randomUUID()}`;
      const assetPayload = {
        kind: "asset_upload_completion_requested_v1",
        siteRef: "site-component",
        environment: "production",
        region: "us-east-1",
        intentRef: `asset-intent-${randomUUID()}`,
        sessionRef: assetSessionRef,
        expectedVersion: "1",
      };
      await assetDataPlane.query(
        `SELECT set_config('app.operation','asset.multipart.complete',false),
                set_config('app.workload_kind','site_product',false),
                set_config('app.actor_kind','user',false),
                set_config('app.scopes','["asset:upload"]',false),
                set_config('app.site_id',$1,false),
                set_config('app.environment',$2,false),
                set_config('app.region',$3,false)`,
        [assetPayload.siteRef, assetPayload.environment, assetPayload.region],
      );
      await expect(
        assetDataPlane.query(
          `SELECT platform.enqueue_asset_upload_completion_event(
          $1::uuid,$2,$3::jsonb,$4::char(64),$5,$6
        )`,
          [
            assetCompletionEventId,
            assetSessionRef,
            JSON.stringify(assetPayload),
            "a".repeat(64),
            "asset-component-correlation",
            "asset-component-causation",
          ],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        assetDataPlane.query(
          `SELECT platform.enqueue_asset_upload_completion_event(
          $1::uuid,$2,$3::jsonb,$4::char(64),$5,$6
        )`,
          [
            assetCompletionEventId,
            assetSessionRef,
            JSON.stringify(assetPayload),
            "a".repeat(64),
            "asset-component-correlation",
            "asset-component-causation",
          ],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        assetDataPlane.query("SELECT event_id FROM platform.outbox_event LIMIT 1"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        insertOutboxEvent(assetDataPlane, randomUUID(), "asset", "asset-data-plane-forged-direct"),
      ).rejects.toMatchObject({ code: "42501" });

      for (const [index, producer] of producers.entries()) {
        const client = clients[index];
        if (client === undefined) throw new Error("COMPONENT_PRODUCER_CLIENT_MISSING");
        const allowedOwners = new Set<string>(producer.allowed);
        for (const owner of producer.allowed) {
          const eventId = randomUUID();
          const result = await insertOutboxEvent(client, eventId, owner, producer.name);
          expect(result.rowCount).toBe(1);
          insertedByOwner.set(owner, [...(insertedByOwner.get(owner) ?? []), eventId]);
        }
        for (const owner of allOwners.filter((candidate) => !allowedOwners.has(candidate))) {
          await expect(
            insertOutboxEvent(client, randomUUID(), owner, `${producer.name}-forged`),
          ).rejects.toMatchObject({ code: "42501" });
        }
      }

      await expect(
        identity.query("SELECT DISTINCT owner FROM platform.outbox_event ORDER BY owner"),
      ).resolves.toMatchObject({ rows: [{ owner: "identity" }] });
      const assetWorker = clients[3];
      if (assetWorker === undefined) throw new Error("COMPONENT_ASSET_WORKER_CLIENT_MISSING");
      await expect(
        commerceWorker.query("SELECT DISTINCT owner FROM platform.outbox_event ORDER BY owner"),
      ).resolves.toMatchObject({ rows: [{ owner: "commerce" }, { owner: "credit" }] });
      await expect(
        siteWorker.query("SELECT DISTINCT owner FROM platform.outbox_event ORDER BY owner"),
      ).resolves.toMatchObject({ rows: [{ owner: "site" }] });
      await expect(
        assetWorker.query("SELECT DISTINCT owner FROM platform.outbox_event ORDER BY owner"),
      ).resolves.toMatchObject({ rows: [{ owner: "asset" }] });
      await expect(
        adminWorker.query("SELECT DISTINCT owner FROM platform.outbox_event ORDER BY owner"),
      ).resolves.toMatchObject({ rows: [{ owner: "admin-execution" }] });
      await expect(
        assetWorker.query("SELECT event_id FROM platform.outbox_event WHERE event_id=$1", [
          assetCompletionEventId,
        ]),
      ).resolves.toMatchObject({ rows: [{ event_id: assetCompletionEventId }] });
      await expect(
        migrator.query("SELECT event_id FROM platform.outbox_event WHERE event_id=$1", [
          assetCompletionEventId,
        ]),
      ).resolves.toMatchObject({ rowCount: 0 });
      await expect(
        migrator.query("UPDATE platform.outbox_event SET state='dead_letter' WHERE event_id=$1", [
          assetCompletionEventId,
        ]),
      ).resolves.toMatchObject({ rowCount: 0 });
      await expect(
        migrator.query("DELETE FROM platform.outbox_event WHERE event_id=$1", [
          assetCompletionEventId,
        ]),
      ).resolves.toMatchObject({ rowCount: 0 });
      const identityEvent = insertedByOwner.get("identity")?.[0];
      const commerceEvent = insertedByOwner.get("commerce")?.[0];
      if (identityEvent === undefined || commerceEvent === undefined) {
        throw new Error("COMPONENT_OUTBOX_SEED_MISSING");
      }
      await expect(
        identity.query("UPDATE platform.outbox_event SET state='dead_letter' WHERE event_id=$1", [
          commerceEvent,
        ]),
      ).resolves.toMatchObject({ rowCount: 0 });
      await expect(
        adminWorker.query(
          "UPDATE platform.outbox_event SET state='dead_letter' WHERE event_id=$1",
          [identityEvent],
        ),
      ).resolves.toMatchObject({ rowCount: 0 });
      await expect(
        identity.query("UPDATE platform.outbox_event SET owner='commerce' WHERE event_id=$1", [
          identityEvent,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await migrator.query("TRUNCATE TABLE platform.outbox_event").catch(() => undefined);
      await Promise.allSettled([
        migrator.end(),
        identity.end(),
        assetDataPlane.end(),
        commerceWorker.end(),
        siteWorker.end(),
        adminWorker.end(),
        ...clients.map((client) => client.end()),
      ]);
    }
  });

  it("enforces exact worker operations and dedicated function authority", async () => {
    const exactOperations = {
      "commerce-worker": "commerce.outbox.reconcile",
      "site-worker": "site.runtime.consume",
      "asset-worker": "asset.outbox.consume",
      "admin-worker": "admin.execution.claim",
      "identity-worker": "identity.outbox.consume",
      "authorization-maintenance": "authorization.retention",
    } as const;
    const roles = Object.keys(exactOperations) as PlatformWorkerAuthorityRole[];
    for (const [index, role] of roles.entries()) {
      await expect(
        workerDatabases[role].internalTransaction(exactOperations[role], async () => role),
      ).resolves.toBe(role);
      const foreignRole = roles[(index + 1) % roles.length];
      if (foreignRole === undefined) throw new Error("COMPONENT_FOREIGN_WORKER_ROLE_MISSING");
      await expect(
        workerDatabases[role].internalTransaction(
          exactOperations[foreignRole],
          async () => undefined,
        ),
      ).rejects.toThrowError("PLATFORM_INTERNAL_OPERATION_ROLE_FORBIDDEN");
    }

    const scopedFence = {
      operation: "asset.scan.evaluate" as const,
      siteRef: "site-component",
      environment: "production",
      region: "us-east-1",
      scopes: ["asset:worker"] as const,
    };
    await expect(
      workerDatabases["asset-worker"].internalScopedTransaction(
        scopedFence,
        async () => "asset-scoped",
      ),
    ).resolves.toBe("asset-scoped");
    await expect(
      workerDatabases["commerce-worker"].internalScopedTransaction(
        scopedFence,
        async () => undefined,
      ),
    ).rejects.toThrowError("PLATFORM_SCOPED_INTERNAL_OPERATION_ROLE_FORBIDDEN");

    const adminFence = {
      operation: "admin.authority.change",
      siteRef: null,
      environment: "production",
      region: "us-east-1",
      makerRef: "operator-maker",
      makerGeneration: 1n,
      makerAuthorizationEpoch: 1n,
      checkerRef: "operator-checker",
      checkerGeneration: 1n,
      checkerAuthorizationEpoch: 1n,
    };
    await expect(
      workerDatabases["admin-worker"].adminExecutionTransaction(
        adminFence,
        async () => "admin-execution",
      ),
    ).resolves.toBe("admin-execution");
    await expect(
      workerDatabases["site-worker"].adminExecutionTransaction(adminFence, async () => undefined),
    ).rejects.toThrowError("ADMIN_EXECUTION_ROLE_FORBIDDEN");

    const roleClients = await Promise.all([
      ...roles.map(async (role) => {
        const client = new Client({ connectionString: workerDatabaseUrls[role] });
        await client.connect();
        return { role, client };
      }),
      (async () => {
        const client = new Client({ connectionString: modelGatewayDatabaseUrl });
        await client.connect();
        return { role: "model-gateway" as const, client };
      })(),
    ]);
    try {
      for (const { role, client } of roleClients) {
        if (role !== "model-gateway") {
          const relationProbe = {
            "commerce-worker": {
              own: "SELECT redemption_id FROM platform.commerce_redemption LIMIT 0",
              foreign: "SELECT site_ref FROM platform.site LIMIT 0",
            },
            "site-worker": {
              own: "SELECT site_ref FROM platform.site LIMIT 0",
              foreign: "SELECT intent_ref FROM platform.asset_upload_intent LIMIT 0",
            },
            "asset-worker": {
              own: "SELECT intent_ref FROM platform.asset_upload_intent LIMIT 0",
              foreign: "SELECT approval_ref FROM platform.admin_approval LIMIT 0",
            },
            "admin-worker": {
              own: "SELECT approval_ref FROM platform.admin_approval LIMIT 0",
              foreign:
                "SELECT transaction_ref FROM platform.identity_verification_transaction LIMIT 0",
            },
            "identity-worker": {
              own: "SELECT transaction_ref FROM platform.identity_verification_transaction LIMIT 0",
              foreign: "SELECT redemption_id FROM platform.commerce_redemption LIMIT 0",
            },
            "authorization-maintenance": {
              own: "SELECT event_id FROM platform.authorization_scoped_event_log LIMIT 0",
              foreign: "SELECT event_id FROM platform.outbox_event LIMIT 0",
            },
          } as const;
          const targetRole = roles[(roles.indexOf(role) + 1) % roles.length];
          if (targetRole === undefined) throw new Error("COMPONENT_TARGET_WORKER_ROLE_MISSING");
          await client.query("SELECT set_config('app.workload_kind',$1,false)", [
            PLATFORM_WORKER_DATABASE_AUTHORITY[role].workloadKind,
          ]);
          await expect(client.query(relationProbe[role].own)).resolves.toMatchObject({ rows: [] });
          await client.query(
            `SELECT set_config('app.workload_kind',$1,false),
                    set_config('app.scopes','["asset:worker"]',false),
                    set_config('app.admin_execution','true',false)`,
            [PLATFORM_WORKER_DATABASE_AUTHORITY[targetRole].workloadKind],
          );
          await expect(client.query(relationProbe[role].foreign)).rejects.toMatchObject({
            code: "42501",
          });
        }
        const privilege = await client.query<{
          model_report: boolean;
          admin_authority: boolean;
        }>(`
          SELECT has_function_privilege(
                   current_user,
                   'platform.report_model_provider_availability(uuid,text,text,text,bigint,text,timestamptz,text)',
                   'EXECUTE'
                 ) AS model_report,
                 has_function_privilege(
                   current_user,'platform.apply_admin_authority_change(uuid,jsonb)','EXECUTE'
                 ) AS admin_authority
        `);
        expect(privilege.rows).toEqual([
          {
            model_report: role === "model-gateway",
            admin_authority: role === "admin-worker",
          },
        ]);
      }
    } finally {
      await Promise.allSettled(roleClients.map(({ client }) => client.end()));
    }
  });

  it("locks populated worker authority rows without granting authority-table UPDATE", async () => {
    const suffix = randomUUID();
    const siteRef = `site-lock-${suffix}`;
    const releaseRef = `release-lock-${suffix}`;
    const workloadIdentityId = `workload-lock-${suffix}`;
    const subjectRef = `subject-lock-${suffix}`;
    const projectRef = `project-lock-${suffix}`;
    const executionSpaceRef = `space-lock-${suffix}`;
    const bindingRef = `binding-lock-${suffix}`;
    const intentRef = `intent-lock-${suffix}`;
    const sessionRef = `session-lock-${suffix}`;
    const operatorRef = `operator-lock-${suffix}`;
    const globalGrantRef = randomUUID();
    const breakglassGrantRef = randomUUID();
    const matchingAssetEventId = randomUUID();
    const foreignAssetEventId = randomUUID();
    const matchingAssetPayload = Object.freeze({
      kind: "asset_scan_requested_v1",
      siteRef,
      environment: "production",
      region: "us-east-1",
      candidateRef: `candidate-matching-${suffix}`,
      expectedVersion: "1",
    });
    const foreignAssetPayload = Object.freeze({
      ...matchingAssetPayload,
      environment: "staging",
      region: "us-west-2",
      candidateRef: `candidate-foreign-${suffix}`,
    });
    const bootstrap = new Client({ connectionString: bootstrapDatabaseUrl });
    const asset = new Client({ connectionString: workerDatabaseUrls["asset-worker"] });
    const site = new Client({ connectionString: workerDatabaseUrls["site-worker"] });
    const admin = new Client({ connectionString: workerDatabaseUrls["admin-worker"] });
    await Promise.all([bootstrap.connect(), asset.connect(), site.connect(), admin.connect()]);
    try {
      await bootstrap.query("BEGIN");
      try {
        const seedQueries: readonly (readonly [string, readonly unknown[]])[] = [
          [
            `INSERT INTO platform.authorization_site
               (site_ref,state,security_epoch,policy_epoch,revocation_epoch)
             VALUES ($1,'active',1,1,1)`,
            [siteRef],
          ],
          [
            `INSERT INTO platform.authorization_site_release
               (release_ref,site_ref,state,web_artifact_digest,enabled_surface_ids,
                feature_policy_revision,model_option_catalog_ref,agent_catalog_ref,
                identity_issuer_label,identity_auth_strength_policy_revision,locale_policy)
             VALUES ($1,$2,'active',repeat('a',64),'[]'::jsonb,'policy-1','model-1','agent-1',
                     'Component','auth-1','{}'::jsonb)`,
            [releaseRef, siteRef],
          ],
          [
            `INSERT INTO platform.authorization_product_binding
               (binding_ref,workload_identity_id,deployment_ref,site_ref,release_ref,environment,
                region,audience,session_contract_revision,binding_epoch,state)
             VALUES ($1,$2,$3,$4,$5,'production','us-east-1','component','v1',1,'active')`,
            [bindingRef, workloadIdentityId, `deployment-lock-${suffix}`, siteRef, releaseRef],
          ],
          [
            `INSERT INTO platform.authorization_subject
               (subject_ref,site_ref,display_name,state,subject_generation,restriction_epoch)
             VALUES ($1,$2,'Component Subject','active',1,1)`,
            [subjectRef, siteRef],
          ],
          [
            `INSERT INTO platform.authorization_project
               (project_ref,site_ref,workspace_ref,execution_space_ref,display_name,state)
             VALUES ($1,$2,'workspace-component',$3,'Component Project','active')`,
            [projectRef, siteRef, executionSpaceRef],
          ],
          [
            `INSERT INTO platform.identity_execution_space
               (site_ref,execution_space_ref,project_ref,execution_namespace,state,security_epoch)
             VALUES ($1,$2,$3,$4,'active',1)`,
            [siteRef, executionSpaceRef, projectRef,
              `component-lock-${suffix.replaceAll("-", "")}`],
          ],
          [
            `INSERT INTO platform.authorization_project_membership
               (project_ref,subject_ref,state,membership_epoch,authorization_epoch,is_default)
             VALUES ($1,$2,'active',1,1,true)`,
            [projectRef, subjectRef],
          ],
          [
            `INSERT INTO platform.asset_upload_intent
               (intent_ref,site_ref,workload_identity_id,site_release_ref,binding_epoch,
                subject_ref,subject_generation,project_ref,purpose,safe_display_name,
                client_media_type,expected_size,expected_checksum_sha256,policy_revision_ref,
                idempotency_key,request_digest,state,expected_version,expires_at)
             VALUES ($1,$2,$3,$4,1,$5,1,$6,'component-lock','Component lock asset',
                     'image/png',1,repeat('b',64),'policy-1',$7,repeat('c',64),
                     'admitted',1,now()+interval '1 hour')`,
            [intentRef, siteRef, workloadIdentityId, releaseRef, subjectRef, projectRef,
              `idem-lock-${suffix}`],
          ],
          [
            `INSERT INTO platform.asset_upload_session
               (session_ref,intent_ref,site_ref,subject_ref,subject_generation,project_ref,purpose,
                quota_revision_ref,storage_tenant_ref,storage_region,quarantine_object_ref,
                protocol_revision,capability_audience,minimum_part_bytes,maximum_part_bytes,
                capability_lifetime_seconds,capability_epoch,capability_expires_at,
                completion_requested_at,state,expected_version,expires_at)
             VALUES ($1,$2,$3,$4,1,$5,'component-lock','quota-1','tenant-1','us-east-1',
                     'quarantine/component','s3-multipart-v1','component-audience',1,10,300,1,
                     now()+interval '10 minutes',now()-interval '1 minute','completing',2,
                     now()+interval '1 hour')`,
            [sessionRef, intentRef, siteRef, subjectRef, projectRef],
          ],
          [
            "INSERT INTO platform.site(site_ref,site_key,state) VALUES ($1,$2,'preview_ready')",
            [siteRef, `lock-${suffix.slice(0, 24)}`],
          ],
          [
            `INSERT INTO platform.site_project_binding
               (binding_ref,site_ref,repository_ref,provider_namespace,provider_project_ref,
                environment,region,workload_identity_id,binding_epoch,state)
             VALUES ($1,$2,$3,$4,'provider-project','production','us-east-1',$5,1,'active')`,
            [bindingRef, siteRef, `repository-lock-${suffix}`,
              `namespace-${suffix.slice(0, 20)}`, workloadIdentityId],
          ],
          [
            `INSERT INTO platform.admin_operator_authority
               (operator_ref,operator_generation,state,permissions,operator_security_epoch,
                authorization_epoch,expires_at)
             VALUES ($1,1,'active',ARRAY['admin.authority.manage'],1,1,
                     now()+interval '1 hour')`,
            [operatorRef],
          ],
          [
            `INSERT INTO platform.admin_operator_site_scope
               (operator_ref,operator_generation,site_ref,environment,region,scope_epoch,state,
                expires_at)
             VALUES ($1,1,$2,'production','us-east-1',1,'active',now()+interval '1 hour')`,
            [operatorRef, siteRef],
          ],
          [
            `INSERT INTO platform.admin_operator_site_scope
               (operator_ref,operator_generation,site_ref,environment,region,scope_epoch,state,
                expires_at)
             VALUES ($1,1,$2,'staging','us-west-2',2,'active',now()+interval '1 hour')`,
            [operatorRef, siteRef],
          ],
          [
            `INSERT INTO platform.admin_operator_global_scope_grant
               (grant_ref,operator_ref,operator_generation,environment,region,scope_epoch,state,
                expires_at)
             VALUES ($1::uuid,$2,1,'production','us-east-1',1,'active',
                     now()+interval '1 hour')`,
            [globalGrantRef, operatorRef],
          ],
          [
            `INSERT INTO platform.admin_breakglass_grant
               (grant_ref,operator_ref,operator_generation,incident_ref,environment,region,
                authorized_operation,resource_refs,field_allowlist,scope_epoch,state,
                approved_by_refs,expires_at)
             VALUES ($1::uuid,$2,1,'incident-component','production','us-east-1',
                     'admin.authority.change',ARRAY['authority'],ARRAY['permissions'],1,'active',
                     ARRAY['approver-one','approver-two'],now()+interval '10 minutes')`,
            [breakglassGrantRef, operatorRef],
          ],
          [
            `INSERT INTO platform.outbox_event
               (event_id,owner,event_type,aggregate_id,payload,payload_digest,correlation_id)
             VALUES ($1::uuid,'asset','asset.scan.requested',$2,$3::jsonb,$4,$5)`,
            [matchingAssetEventId, matchingAssetPayload.candidateRef,
              JSON.stringify(matchingAssetPayload), digestAssetCommand(matchingAssetPayload),
              `correlation-matching-${suffix}`],
          ],
          [
            `INSERT INTO platform.outbox_event
               (event_id,owner,event_type,aggregate_id,payload,payload_digest,correlation_id)
             VALUES ($1::uuid,'asset','asset.scan.requested',$2,$3::jsonb,$4,$5)`,
            [foreignAssetEventId, foreignAssetPayload.candidateRef,
              JSON.stringify(foreignAssetPayload), digestAssetCommand(foreignAssetPayload),
              `correlation-foreign-${suffix}`],
          ],
        ];
        for (const [statement, values] of seedQueries) {
          await bootstrap.query(statement, values as unknown[]);
        }
        await bootstrap.query("COMMIT");
      } catch (error) {
        await bootstrap.query("ROLLBACK");
        throw error;
      }

      await asset.query(
        `SELECT set_config('app.workload_kind','platform_asset_worker',false),
                set_config('app.operation','asset.upload-completion.observe',false),
                set_config('app.site_id',$1,false),
                set_config('app.environment','production',false),
                set_config('app.region','us-east-1',false)`,
        [siteRef],
      );
      await expect(asset.query(
        `SELECT platform.lock_asset_worker_upload_completion_authority(
           $1,$2
         ) AS allowed`,
        [siteRef, intentRef],
      )).resolves.toMatchObject({ rows: [{ allowed: true }] });
      await asset.query("SELECT set_config('app.region','us-west-2',false)");
      await expect(asset.query(
        `SELECT platform.lock_asset_worker_upload_completion_authority(
           $1,$2
         ) AS allowed`,
        [siteRef, intentRef],
      )).resolves.toMatchObject({ rows: [{ allowed: false }] });
      await asset.query("SELECT set_config('app.region','us-east-1',false)");
      await asset.query("SELECT set_config('app.operation','asset.promotion.finalize',false)");
      await expect(asset.query(
        `SELECT platform.lock_asset_worker_promotion_authority(
           $1,$2,$3,1,$4
         ) AS allowed`,
        [siteRef, intentRef, subjectRef, projectRef],
      )).resolves.toMatchObject({ rows: [{ allowed: true }] });

      await site.query(
        `SELECT set_config('app.workload_kind','platform_site_worker',false),
                set_config('app.operation','site.runtime.consume',false)`,
      );
      await expect(site.query(
        `SELECT binding_ref FROM platform.lock_site_worker_project_binding(
           $1,'production','us-east-1'
         )`,
        [siteRef],
      )).resolves.toMatchObject({ rows: [{ binding_ref: bindingRef }] });

      const workerAuthority = await workerDatabases["admin-worker"].adminExecutionTransaction({
        operation: "admin.authority.change",
        siteRef: null,
        environment: "production",
        region: "us-east-1",
        makerRef: operatorRef,
        makerGeneration: 1n,
        makerAuthorizationEpoch: 1n,
        checkerRef: `checker-${suffix}`,
        checkerGeneration: 1n,
        checkerAuthorizationEpoch: 1n,
      }, (transaction) => createAdminWorkerAuthorityRepository().lockOperatorAuthority(
        transaction,
        { operatorRef, operatorGeneration: 1n },
      ));
      expect(workerAuthority).toMatchObject({
        operatorRef,
        siteScopes: [siteRef],
        globalScopes: [globalGrantRef],
        environments: ["production"],
        regions: ["us-east-1"],
      });
      expect(workerAuthority?.breakGlassExpiresAt).not.toBeNull();

      await bootstrap.query(
        `UPDATE platform.admin_operator_site_scope SET state='revoked'
         WHERE operator_ref=$1 AND operator_generation=1
           AND site_ref=$2 AND environment='production' AND region='us-east-1'`,
        [operatorRef, siteRef],
      );
      const crossTupleAuthority = await workerDatabases["admin-worker"].adminExecutionTransaction({
        operation: "admin.authority.change",
        siteRef,
        environment: "production",
        region: "us-west-2",
        makerRef: operatorRef,
        makerGeneration: 1n,
        makerAuthorizationEpoch: 1n,
        checkerRef: `checker-cross-${suffix}`,
        checkerGeneration: 1n,
        checkerAuthorizationEpoch: 1n,
      }, (transaction) => createAdminWorkerAuthorityRepository().lockOperatorAuthority(
        transaction,
        { operatorRef, operatorGeneration: 1n },
      ));
      expect(crossTupleAuthority).toMatchObject({
        operatorRef,
        siteScopes: [],
        globalScopes: [],
        environments: [],
        regions: [],
        breakGlassExpiresAt: null,
      });
      await bootstrap.query(
        `UPDATE platform.admin_operator_site_scope SET state='active'
         WHERE operator_ref=$1 AND operator_generation=1
           AND site_ref=$2 AND environment='production' AND region='us-east-1'`,
        [operatorRef, siteRef],
      );

      const claimedAssetEvents = await createPostgresAssetEffectEventQueue(
        workerDatabases["asset-worker"],
        { workerId: `asset-route-${suffix}`, environment: "production", region: "us-east-1" },
        new OutboxRepository(),
      ).claim();
      const claimedAssetEventIds = new Set(claimedAssetEvents.map((event) => event.eventId));
      expect(claimedAssetEventIds.has(matchingAssetEventId)).toBe(true);
      expect(claimedAssetEventIds.has(foreignAssetEventId)).toBe(false);

      let completionObservations = 0;
      let revokeDuringObservation = false;
      const completionService = createAssetWorkerCompletionService({
        unitOfWork: createAssetWorkerUnitOfWork(workerDatabases["asset-worker"], {
          environment: "production",
          region: "us-east-1",
        }),
        deployment: { environment: "production", region: "us-east-1" },
        objectStore: {
          async observe() {
            completionObservations += 1;
            if (revokeDuringObservation) {
              await bootstrap.query(
                `UPDATE platform.authorization_project_membership SET state='revoked'
                 WHERE project_ref=$1 AND subject_ref=$2`,
                [projectRef, subjectRef],
              );
            }
            return {
              disposition: "present" as const,
              providerVersionRef: "provider-version-component",
              providerEtagDigest: "d".repeat(64),
              size: 1n,
              checksumSha256: "b".repeat(64),
              observedAt: new Date().toISOString(),
            };
          },
          async computeSha256() { throw new Error("not expected"); },
        },
      });
      const revokedAuthorities = [
        ["authorization_product_binding", "binding_ref", bindingRef, "revoked", "active"],
        ["authorization_subject", "subject_ref", subjectRef, "disabled", "active"],
        ["authorization_project", "project_ref", projectRef, "archived", "active"],
        ["authorization_project_membership", "project_ref", projectRef, "revoked", "active"],
      ] as const;
      for (const [relation, key, value, revokedState, activeState] of revokedAuthorities) {
        const observationsBeforeRejection = completionObservations;
        await bootstrap.query(
          `UPDATE platform.${quoteIdentifier(relation)} SET state=$1 ` +
            `WHERE ${quoteIdentifier(key)}=$2`,
          [revokedState, value],
        );
        await expect(completionService.execute({
          eventId: randomUUID(),
          siteRef,
          intentRef,
          sessionRef,
          expectedVersion: 2n,
          correlationId: `correlation-${suffix}`,
        })).rejects.toThrowError("ASSET_UPLOAD_AUTHORITY_STALE");
        expect(completionObservations).toBe(observationsBeforeRejection);
        await bootstrap.query(
          `UPDATE platform.${quoteIdentifier(relation)} SET state=$1 ` +
            `WHERE ${quoteIdentifier(key)}=$2`,
          [activeState, value],
        );
      }
      revokeDuringObservation = true;
      await expect(completionService.execute({
        eventId: randomUUID(),
        siteRef,
        intentRef,
        sessionRef,
        expectedVersion: 2n,
        correlationId: `correlation-${suffix}`,
      })).rejects.toThrowError("ASSET_UPLOAD_AUTHORITY_STALE");
      expect(completionObservations).toBe(1);
      await bootstrap.query(
        `UPDATE platform.authorization_project_membership SET state='active'
         WHERE project_ref=$1 AND subject_ref=$2`,
        [projectRef, subjectRef],
      );

      await expect(asset.query(
        "SELECT binding_ref FROM platform.authorization_product_binding FOR UPDATE",
      )).rejects.toMatchObject({ code: "42501" });
      await expect(site.query(
        "SELECT binding_ref FROM platform.site_project_binding FOR UPDATE",
      )).rejects.toMatchObject({ code: "42501" });
      await expect(admin.query(
        "SELECT operator_ref FROM platform.admin_operator_authority FOR UPDATE",
      )).rejects.toMatchObject({ code: "42501" });
      await expect(admin.query(
        "SELECT site_ref FROM platform.admin_operator_site_scope",
      )).rejects.toMatchObject({ code: "42501" });
    } finally {
      const cleanupQueries: readonly (readonly [string, readonly unknown[]])[] = [
        ["DELETE FROM platform.outbox_event WHERE event_id=ANY($1::uuid[])",
          [[matchingAssetEventId, foreignAssetEventId]]],
        ["DELETE FROM platform.admin_breakglass_grant WHERE grant_ref=$1::uuid", [breakglassGrantRef]],
        ["DELETE FROM platform.admin_operator_global_scope_grant WHERE grant_ref=$1::uuid", [globalGrantRef]],
        ["DELETE FROM platform.admin_operator_site_scope WHERE operator_ref=$1", [operatorRef]],
        ["DELETE FROM platform.admin_operator_authority WHERE operator_ref=$1", [operatorRef]],
        ["DELETE FROM platform.site_project_binding WHERE binding_ref=$1", [bindingRef]],
        ["DELETE FROM platform.site WHERE site_ref=$1", [siteRef]],
        ["DELETE FROM platform.asset_upload_session WHERE session_ref=$1", [sessionRef]],
        ["DELETE FROM platform.asset_upload_intent WHERE intent_ref=$1", [intentRef]],
        [
          `DELETE FROM platform.authorization_project_membership
           WHERE project_ref=$1 AND subject_ref=$2`,
          [projectRef, subjectRef],
        ],
        [
          "DELETE FROM platform.identity_execution_space WHERE execution_space_ref=$1",
          [executionSpaceRef],
        ],
        ["DELETE FROM platform.authorization_project WHERE project_ref=$1", [projectRef]],
        ["DELETE FROM platform.authorization_subject WHERE subject_ref=$1", [subjectRef]],
        ["DELETE FROM platform.authorization_product_binding WHERE binding_ref=$1", [bindingRef]],
        ["DELETE FROM platform.authorization_site_release WHERE release_ref=$1", [releaseRef]],
        ["DELETE FROM platform.authorization_site WHERE site_ref=$1", [siteRef]],
      ];
      await bootstrap.query("BEGIN").catch(() => undefined);
      try {
        for (const [statement, values] of cleanupQueries) {
          await bootstrap.query(statement, values as unknown[]);
        }
        await bootstrap.query("COMMIT");
      } catch {
        await bootstrap.query("ROLLBACK").catch(() => undefined);
      }
      await Promise.allSettled([bootstrap.end(), asset.end(), site.end(), admin.end()]);
    }
  });

  it("keeps the six worker roles LOGIN-only and rejects database TEMP drift", async () => {
    const migrator = new Client({ connectionString: migratorDatabaseUrl });
    await migrator.connect();
    try {
      const authority = await migrator.query<{
        role_name: string;
        can_login: boolean;
        is_superuser: boolean;
        inherits: boolean;
        bypasses_rls: boolean;
        can_create_database: boolean;
        can_create_role: boolean;
        can_replicate: boolean;
        can_create_objects: boolean;
        can_create_temporary: boolean;
        has_membership: boolean;
        has_members: boolean;
        owns_database: boolean;
        owns_schema: boolean;
        owns_relation: boolean;
        owns_routine: boolean;
      }>(
        `
        SELECT runtime_role.rolname AS role_name,
               runtime_role.rolcanlogin AS can_login,
               runtime_role.rolsuper AS is_superuser,
               runtime_role.rolinherit AS inherits,
               runtime_role.rolbypassrls AS bypasses_rls,
               runtime_role.rolcreatedb AS can_create_database,
               runtime_role.rolcreaterole AS can_create_role,
               runtime_role.rolreplication AS can_replicate,
               has_database_privilege(runtime_role.rolname,current_database(),'CREATE')
                 AS can_create_objects,
               has_database_privilege(runtime_role.rolname,current_database(),'TEMPORARY')
                 AS can_create_temporary,
               EXISTS (SELECT 1 FROM pg_auth_members membership
                 WHERE membership.member=runtime_role.oid) AS has_membership,
               EXISTS (SELECT 1 FROM pg_auth_members membership
                 WHERE membership.roleid=runtime_role.oid) AS has_members,
               EXISTS (SELECT 1 FROM pg_database database_row
                 WHERE database_row.datdba=runtime_role.oid) AS owns_database,
               EXISTS (SELECT 1 FROM pg_namespace namespace
                 WHERE namespace.nspowner=runtime_role.oid) AS owns_schema,
               EXISTS (SELECT 1 FROM pg_class relation
                 WHERE relation.relowner=runtime_role.oid) AS owns_relation,
               EXISTS (SELECT 1 FROM pg_proc routine
                 WHERE routine.proowner=runtime_role.oid) AS owns_routine
          FROM pg_roles runtime_role
         WHERE runtime_role.rolname=ANY($1::text[])
         ORDER BY runtime_role.rolname
      `,
        [Object.values(workerUsers)],
      );
      expect(authority.rows).toHaveLength(6);
      for (const row of authority.rows)
        expect(row).toMatchObject({
          can_login: true,
          is_superuser: false,
          inherits: false,
          bypasses_rls: false,
          can_create_database: false,
          can_create_role: false,
          can_replicate: false,
          can_create_objects: false,
          can_create_temporary: false,
          has_membership: false,
          has_members: false,
          owns_database: false,
          owns_schema: false,
          owns_relation: false,
          owns_routine: false,
        });

      await migrator.query(
        `GRANT TEMPORARY ON DATABASE ${quoteIdentifier(databaseName)} ` +
          `TO ${quoteIdentifier(workerUsers["commerce-worker"])}`,
      );
      const invalidWorker = createPlatformDatabaseClient(
        loadPlatformDatabaseConfig("commerce-worker", {
          DATABASE_URL_PLATFORM: workerDatabaseUrls["commerce-worker"],
          PLATFORM_DATABASE_CREDENTIAL_CLASS: "commerce-worker",
          PLATFORM_DATABASE_COMMERCE_WORKER_ROLE: workerUsers["commerce-worker"],
          PLATFORM_DATABASE_MIGRATOR_ROLE: migratorUser,
          PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
        }),
      );
      try {
        await expect(invalidWorker.connect()).rejects.toThrowError(
          "PLATFORM_RUNTIME_DATABASE_ROLE_INVALID",
        );
      } finally {
        await invalidWorker.disconnect();
      }
    } finally {
      await migrator
        .query(
          `REVOKE TEMPORARY ON DATABASE ${quoteIdentifier(databaseName)} ` +
            `FROM ${quoteIdentifier(workerUsers["commerce-worker"])}`,
        )
        .catch(() => undefined);
      await migrator.end();
    }
  });

  it("rejects a worker that owns any database in the PostgreSQL cluster", async () => {
    const ownedDatabase = `kokoro_test_worker_owner_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const bootstrap = new Client({ connectionString: bootstrapDatabaseUrl });
    await bootstrap.connect();
    try {
      await bootstrap.query(
        `CREATE DATABASE ${quoteIdentifier(ownedDatabase)} ` +
          `OWNER ${quoteIdentifier(workerUsers["commerce-worker"])}`,
      );
      const invalidWorker = createWorkerDatabaseClient("commerce-worker");
      try {
        await expect(invalidWorker.connect()).rejects.toThrowError(
          "PLATFORM_RUNTIME_DATABASE_ROLE_INVALID",
        );
      } finally {
        await invalidWorker.disconnect();
      }
    } finally {
      await bootstrap
        .query(`DROP DATABASE IF EXISTS ${quoteIdentifier(ownedDatabase)} WITH (FORCE)`)
        .catch(() => undefined);
      await bootstrap.end();
    }
  });

  it("rejects a same-name worker role recreated with its exact former ACL", async () => {
    const roleKind = "authorization-maintenance" as const;
    const roleName = workerUsers[roleKind];
    const roleUrl = new URL(workerDatabaseUrls[roleKind]);
    const password = decodeURIComponent(roleUrl.password);
    const bootstrap = new Client({ connectionString: bootstrapDatabaseUrl });
    let replacementOid: string | undefined;
    await workerDatabases[roleKind].disconnect();
    await bootstrap.connect();
    try {
      const original = await bootstrap.query<{ oid: string }>(
        "SELECT oid::bigint::text AS oid FROM pg_roles WHERE rolname=$1",
        [roleName],
      );
      const originalOid = original.rows[0]?.oid;
      expect(originalOid).toBeDefined();

      await bootstrap.query(`DROP OWNED BY ${quoteIdentifier(roleName)}`);
      await bootstrap.query(`DROP ROLE ${quoteIdentifier(roleName)}`);
      await createLoginOnlyTestRole(bootstrap, roleName, password);
      await restoreExactWorkerAcl(bootstrap, roleKind, roleName);

      const replacement = await bootstrap.query<{ oid: string }>(
        "SELECT oid::bigint::text AS oid FROM pg_roles WHERE rolname=$1",
        [roleName],
      );
      replacementOid = replacement.rows[0]?.oid;
      expect(replacementOid).toBeDefined();
      expect(replacementOid).not.toBe(originalOid);

      const legacyNameOnlyAudit = await bootstrap.query(
        SPLIT_WORKER_EXACT_AUTHORITY_SQL,
        [
          roleName,
          JSON.stringify(canonicalRelationAuthority(roleKind)),
          SPLIT_WORKER_ROUTINE_AUTHORITY[roleKind],
        ],
      );
      expect(legacyNameOnlyAudit.rows).toEqual([
        {
          roleAuthorityExact: true,
          relationAuthorityExact: true,
          routineAuthorityExact: true,
          publicRelationAuthorityClosed: true,
          publicRoutineAuthorityClosed: true,
          sequenceAuthorityClosed: true,
        },
      ]);

      const staleIdentityWorker = createWorkerDatabaseClient(roleKind);
      try {
        await expect(staleIdentityWorker.connect()).rejects.toThrowError(
          "PLATFORM_RUNTIME_DATABASE_ROLE_INVALID",
        );
      } finally {
        await staleIdentityWorker.disconnect();
      }
    } finally {
      await ensureLoginOnlyTestRole(bootstrap, roleName, password);
      await bootstrap.query(
        `GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO ${quoteIdentifier(roleName)}`,
      );
      await runPlatformMigrations({ environment: platformMigrationEnvironment() });
      workerDatabases[roleKind] = createWorkerDatabaseClient(roleKind);
      await workerDatabases[roleKind].connect();
      await bootstrap.end();
    }
    expect(replacementOid).toBeDefined();
  }, 60_000);

  it("does not let an API credential impersonate any exact worker through GUCs", async () => {
    const ownedSiteRef = `site-owned-${randomUUID()}`;
    const foreignSiteRef = `site-foreign-${randomUUID()}`;
    const admin = new Client({ connectionString: adminDatabaseUrl });
    const api = new Client({ connectionString: apiDatabaseUrl });
    await Promise.all([admin.connect(), api.connect()]);
    try {
      await admin.query("BEGIN");
      for (const [siteRef, siteKey] of [
        [ownedSiteRef, `owned-${randomUUID()}`],
        [foreignSiteRef, `foreign-${randomUUID()}`],
      ] as const) {
        await admin.query(
          `SELECT set_config('app.site_id',$1,true),
                  set_config('app.workload_kind','admin_workload',true)`,
          [siteRef],
        );
        await admin.query(
          `INSERT INTO platform.site(site_ref,site_key,state) VALUES ($1,$2,'preview_ready')`,
          [siteRef, siteKey],
        );
      }
      await admin.query("COMMIT");

      await api.query("BEGIN");
      await api.query(
        `SELECT set_config('app.site_id',$1,true),
                set_config('app.workload_kind','platform_site_worker',true)`,
        [ownedSiteRef],
      );
      const visible = await api.query<{ site_ref: string }>(
        `SELECT site_ref FROM platform.site WHERE site_ref=ANY($1::text[]) ORDER BY site_ref`,
        [[ownedSiteRef, foreignSiteRef]],
      );
      expect(visible.rows).toEqual([{ site_ref: ownedSiteRef }]);

      const probes = [
        [
          "platform_site_worker",
          "SELECT attempt_ref FROM platform.site_activation_attempt LIMIT 0",
        ],
        [
          "platform_asset_worker",
          "SELECT evaluation_ref FROM platform.asset_scan_evaluation LIMIT 0",
        ],
        [
          "platform_admin_worker",
          "SELECT platform.apply_admin_authority_change(gen_random_uuid(),'{}'::jsonb)",
        ],
        ["platform_identity_worker", "UPDATE platform.outbox_event SET state=state WHERE FALSE"],
        ["platform_commerce_worker", "UPDATE platform.outbox_event SET state=state WHERE FALSE"],
        [
          "platform_authorization_maintenance",
          "DELETE FROM platform.authorization_scoped_snapshot WHERE FALSE",
        ],
      ] as const;
      await api.query("COMMIT");
      for (const [workloadKind, sql] of probes) {
        await api.query(
          `SELECT set_config('app.workload_kind',$1,false),
                  set_config('app.scopes','["asset:worker"]',false),
                  set_config('app.admin_execution','true',false)`,
          [workloadKind],
        );
        await expect(api.query(sql)).rejects.toMatchObject({ code: "42501" });
      }
    } finally {
      await api.query("ROLLBACK").catch(() => undefined);
      await admin.query("ROLLBACK").catch(() => undefined);
      await Promise.allSettled([api.end(), admin.end()]);
    }
  });

  it("keeps PUBLIC routine execution closed and rejects a widened routine ACL", async () => {
    const migrator = new Client({ connectionString: migratorDatabaseUrl });
    await migrator.connect();
    try {
      const publicAuthority = await migrator.query<{
        public_routine_count: string;
        public_default_execute: boolean;
      }>(
        `
        SELECT (
          SELECT count(*)::text
          FROM pg_proc routine
          JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
          CROSS JOIN LATERAL aclexplode(COALESCE(
            routine.proacl,acldefault('f',routine.proowner)
          )) acl
          WHERE namespace.nspname='platform'
            AND acl.grantee=0
            AND acl.privilege_type='EXECUTE'
        ) AS public_routine_count,
        EXISTS (
          SELECT 1
          FROM pg_default_acl defaults
          JOIN pg_namespace namespace ON namespace.oid=defaults.defaclnamespace
          CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
          WHERE defaults.defaclrole=(SELECT oid FROM pg_roles WHERE rolname=$1)
            AND namespace.nspname='platform'
            AND defaults.defaclobjtype='f'
            AND acl.grantee=0
            AND acl.privilege_type='EXECUTE'
        ) AS public_default_execute
      `,
        [migratorUser],
      );
      expect(publicAuthority.rows).toEqual([
        {
          public_routine_count: "0",
          public_default_execute: false,
        },
      ]);

      await migrator.query(
        `GRANT EXECUTE ON FUNCTION platform.resolve_model_candidates(TEXT,TEXT,TEXT) TO PUBLIC`,
      );
      const invalidWorker = createPlatformDatabaseClient(
        loadPlatformDatabaseConfig("commerce-worker", {
          DATABASE_URL_PLATFORM: workerDatabaseUrls["commerce-worker"],
          PLATFORM_DATABASE_CREDENTIAL_CLASS: "commerce-worker",
          PLATFORM_DATABASE_COMMERCE_WORKER_ROLE: workerUsers["commerce-worker"],
          PLATFORM_DATABASE_MIGRATOR_ROLE: migratorUser,
          PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
        }),
      );
      try {
        await expect(invalidWorker.connect()).rejects.toThrowError(
          "PLATFORM_RUNTIME_DATABASE_ROLE_INVALID",
        );
      } finally {
        await invalidWorker.disconnect();
      }
    } finally {
      await migrator
        .query(
          `REVOKE EXECUTE ON FUNCTION platform.resolve_model_candidates(TEXT,TEXT,TEXT) FROM PUBLIC`,
        )
        .catch(() => undefined);
      await migrator.end();
    }
  });

  it("uses exact Site cursor update columns and rejects an added key-column grant", async () => {
    const migrator = new Client({ connectionString: migratorDatabaseUrl });
    await migrator.connect();
    try {
      const authority = await migrator.query<{
        stream_singleton_update: boolean;
        stream_watermark_update: boolean;
        cursor_site_update: boolean;
        cursor_sequence_update: boolean;
      }>(
        `
        SELECT has_column_privilege($1,'platform.authorization_scoped_stream_state',
                  'singleton','UPDATE') AS stream_singleton_update,
               has_column_privilege($1,'platform.authorization_scoped_stream_state',
                  'high_watermark','UPDATE') AS stream_watermark_update,
               has_column_privilege($1,'platform.authorization_scoped_site_cursor',
                  'site_ref','UPDATE') AS cursor_site_update,
               has_column_privilege($1,'platform.authorization_scoped_site_cursor',
                  'aggregate_sequence','UPDATE') AS cursor_sequence_update
      `,
        [workerUsers["site-worker"]],
      );
      expect(authority.rows).toEqual([
        {
          stream_singleton_update: false,
          stream_watermark_update: true,
          cursor_site_update: false,
          cursor_sequence_update: true,
        },
      ]);

      await migrator.query(
        `GRANT UPDATE(site_ref) ON TABLE platform.authorization_scoped_site_cursor ` +
          `TO ${workerUsers["site-worker"]}`,
      );
      const invalidWorker = createPlatformDatabaseClient(
        loadPlatformDatabaseConfig("site-worker", {
          DATABASE_URL_PLATFORM: workerDatabaseUrls["site-worker"],
          PLATFORM_DATABASE_CREDENTIAL_CLASS: "site-worker",
          PLATFORM_DATABASE_SITE_WORKER_ROLE: workerUsers["site-worker"],
          PLATFORM_DATABASE_MIGRATOR_ROLE: migratorUser,
          PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
        }),
      );
      try {
        await expect(invalidWorker.connect()).rejects.toThrowError(
          "PLATFORM_RUNTIME_DATABASE_ROLE_INVALID",
        );
      } finally {
        await invalidWorker.disconnect();
      }
    } finally {
      await migrator
        .query(
          `REVOKE UPDATE(site_ref) ON TABLE platform.authorization_scoped_site_cursor ` +
            `FROM ${workerUsers["site-worker"]}`,
        )
        .catch(() => undefined);
      await migrator.end();
    }
  });

  it("fails runtime startup for extra PUBLIC or same-name widened policies", async () => {
    const migrator = new Client({ connectionString: migratorDatabaseUrl });
    await migrator.connect();
    try {
      await migrator.query(
        "CREATE POLICY outbox_public_probe ON platform.outbox_event FOR SELECT TO PUBLIC USING (FALSE)",
      );
      const invalidApi = createPlatformDatabaseClient(
        loadPlatformDatabaseConfig("api", {
          DATABASE_URL_PLATFORM: apiDatabaseUrl,
          PLATFORM_DATABASE_CREDENTIAL_CLASS: "api",
          PLATFORM_DATABASE_API_ROLE: apiUser,
          PLATFORM_DATABASE_MIGRATOR_ROLE: migratorUser,
          PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
        }),
      );
      try {
        await expect(invalidApi.connect()).rejects.toThrowError(
          "PLATFORM_RUNTIME_DATABASE_ROLE_INVALID",
        );
      } finally {
        await invalidApi.disconnect();
      }
      await migrator.query("DROP POLICY outbox_public_probe ON platform.outbox_event");

      await migrator.query(
        `ALTER POLICY outbox_identity_worker_select ON platform.outbox_event
         USING (TRUE)`,
      );
      const invalidIdentity = createPlatformDatabaseClient(
        loadPlatformDatabaseConfig("identity-worker", {
          DATABASE_URL_PLATFORM: identityWorkerDatabaseUrl,
          PLATFORM_DATABASE_CREDENTIAL_CLASS: "identity-worker",
          PLATFORM_DATABASE_IDENTITY_WORKER_ROLE: identityWorkerUser,
          PLATFORM_DATABASE_MIGRATOR_ROLE: migratorUser,
          PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
        }),
      );
      try {
        await expect(invalidIdentity.connect()).rejects.toThrowError(
          "PLATFORM_RUNTIME_DATABASE_ROLE_INVALID",
        );
      } finally {
        await invalidIdentity.disconnect();
      }
      await restorePolicy(migrator, "outbox_identity_worker_select", identityWorkerUser, "USING", [
        "identity",
      ]);

      await migrator.query(
        `ALTER POLICY outbox_admin_insert ON platform.outbox_event
         WITH CHECK (TRUE)`,
      );
      const invalidModelGateway = createPostgresModelGatewayDatabase(
        loadModelGatewayDatabaseConfig({
          DATABASE_URL_PLATFORM: modelGatewayDatabaseUrl,
          PLATFORM_DATABASE_CREDENTIAL_CLASS: "model-gateway",
          PLATFORM_DATABASE_MODEL_GATEWAY_ROLE: modelGatewayUser,
          PLATFORM_DATABASE_MIGRATOR_ROLE: migratorUser,
          PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
        }),
      );
      try {
        await expect(invalidModelGateway.connect()).rejects.toThrowError(
          "MODEL_GATEWAY_DATABASE_ROLE_INVALID",
        );
      } finally {
        await invalidModelGateway.disconnect();
      }
      await restorePolicy(migrator, "outbox_admin_insert", adminUser, "WITH CHECK", [
        "admin-execution",
        "commerce",
        "site",
      ]);

      await replaceSelectPolicy(
        migrator,
        "outbox_identity_worker_select",
        identityWorkerUser,
        ["identity"],
        "RESTRICTIVE",
      );
      const restrictiveIdentity = createPlatformDatabaseClient(
        loadPlatformDatabaseConfig("identity-worker", {
          DATABASE_URL_PLATFORM: identityWorkerDatabaseUrl,
          PLATFORM_DATABASE_CREDENTIAL_CLASS: "identity-worker",
          PLATFORM_DATABASE_IDENTITY_WORKER_ROLE: identityWorkerUser,
          PLATFORM_DATABASE_MIGRATOR_ROLE: migratorUser,
          PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
        }),
      );
      try {
        await expect(restrictiveIdentity.connect()).rejects.toThrowError(
          "PLATFORM_RUNTIME_DATABASE_ROLE_INVALID",
        );
      } finally {
        await restrictiveIdentity.disconnect();
      }
      await replaceSelectPolicy(
        migrator,
        "outbox_identity_worker_select",
        identityWorkerUser,
        ["identity"],
        "PERMISSIVE",
      );
    } finally {
      await migrator
        .query("DROP POLICY IF EXISTS outbox_public_probe ON platform.outbox_event")
        .catch(() => undefined);
      await replaceSelectPolicy(
        migrator,
        "outbox_identity_worker_select",
        identityWorkerUser,
        ["identity"],
        "PERMISSIVE",
      ).catch(() => undefined);
      await restorePolicy(migrator, "outbox_admin_insert", adminUser, "WITH CHECK", [
        "admin-execution",
        "commerce",
        "site",
      ]).catch(() => undefined);
      await migrator.end();
    }
  });
});

function platformMigrationEnvironment(): Readonly<Record<string, string | undefined>> {
  return {
    DATABASE_URL_PLATFORM: migratorDatabaseUrl,
    PLATFORM_DATABASE_CREDENTIAL_CLASS: "migrator",
    PLATFORM_DATABASE_MIGRATOR_ROLE: migratorUser,
    PLATFORM_DATABASE_API_ROLE: apiUser,
    PLATFORM_DATABASE_ADMISSION_ROLE: admissionUser,
    PLATFORM_DATABASE_AUTHORIZATION_ROLE: authorizationUser,
    PLATFORM_DATABASE_ASSET_DATA_PLANE_ROLE: assetDataPlaneUser,
    PLATFORM_DATABASE_ARTIFACT_DATA_PLANE_ROLE: artifactDataPlaneUser,
    PLATFORM_DATABASE_COMMERCE_WORKER_ROLE: workerUsers["commerce-worker"],
    PLATFORM_DATABASE_SITE_WORKER_ROLE: workerUsers["site-worker"],
    PLATFORM_DATABASE_ASSET_WORKER_ROLE: workerUsers["asset-worker"],
    PLATFORM_DATABASE_ADMIN_WORKER_ROLE: workerUsers["admin-worker"],
    PLATFORM_DATABASE_IDENTITY_WORKER_ROLE: workerUsers["identity-worker"],
    PLATFORM_DATABASE_AUTHORIZATION_MAINTENANCE_ROLE:
      workerUsers["authorization-maintenance"],
    PLATFORM_DATABASE_ADMIN_ROLE: adminUser,
    PLATFORM_DATABASE_MODEL_GATEWAY_ROLE: modelGatewayUser,
    PLATFORM_DATABASE_MEMORY_PUBLIC_ROLE: memoryRoleNames.public,
    PLATFORM_DATABASE_MEMORY_RUNTIME_ROLE: memoryRoleNames.runtime,
    PLATFORM_DATABASE_MEMORY_WORKER_ROLE: memoryRoleNames.worker,
    PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
    PATH: process.env.PATH,
  };
}

type CreditConcurrencySeed = Readonly<{
  siteId: string;
  billingAccountId: string;
  creditAccountRef: string;
  creditProgramRevisionRef: string;
  creditGrantRef: string;
  issuanceJournalRef: string;
  reserveJournalRef: string;
  ratingPolicyRevisionRef: string;
  holdRef: string;
  rootRef: string;
  allocationRef: string;
}>;

function creditConcurrencySeed(): CreditConcurrencySeed {
  const suffix = randomUUID();
  return Object.freeze({
    siteId: `credit-lock-${suffix}`,
    billingAccountId: `billing-${suffix}`,
    creditAccountRef: randomUUID(),
    creditProgramRevisionRef: `credit-program-${suffix}`,
    creditGrantRef: randomUUID(),
    issuanceJournalRef: randomUUID(),
    reserveJournalRef: randomUUID(),
    ratingPolicyRevisionRef: `rating-${suffix}`,
    holdRef: randomUUID(),
    rootRef: randomUUID(),
    allocationRef: randomUUID(),
  });
}

async function insertCreditConcurrencySeed(client: Client, seed: CreditConcurrencySeed): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.site_id',$1,true)", [seed.siteId]);
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(
      `INSERT INTO platform.authorization_site
       (site_ref,state,security_epoch,policy_epoch,revocation_epoch)
       VALUES ($1,'active',1,1,1)`,
      [seed.siteId],
    );
    await client.query(
      `INSERT INTO platform.commerce_billing_account(billing_account_ref,site_ref,state)
       VALUES ($1,$2,'active')`,
      [seed.billingAccountId, seed.siteId],
    );
    await client.query(
      `INSERT INTO platform.credit_account
       (credit_account_ref,site_ref,billing_account_ref,unit,liability_merchant_account_ref,state)
       VALUES ($1::uuid,$2,$3,'credit_micros','merchant-component','active')`,
      [seed.creditAccountRef, seed.siteId, seed.billingAccountId],
    );
    const scopePolicy = Object.freeze({
      version: 1,
      surfaceRefs: ["media.image"],
      capabilityKeys: ["image.text_to_image"],
      agentRefs: [],
      allowUnattributedAgent: true,
    });
    await client.query(
      `INSERT INTO platform.commerce_credit_program_revision
       (credit_program_revision_ref,site_ref,program_ref,revision,ux_bucket_class,unit,amount,
        burn_priority,scope_policy,liability_merchant_account_ref,window_kind,rollover_policy,
        revision_digest,catalog_epoch,published_at)
       VALUES ($1,$2,$1,1,'permanent','credit_micros',100,1000,$3::jsonb,
               'merchant-component','none','none',$4,1,clock_timestamp())`,
      [seed.creditProgramRevisionRef, seed.siteId, JSON.stringify(scopePolicy), "1".repeat(64)],
    );
    await client.query(
      `INSERT INTO platform.credit_rating_policy_revision
       (rating_policy_revision_ref,site_ref,unit,policy,policy_digest,state,published_at)
       VALUES ($1,$2,'credit_micros','{}'::jsonb,$3,'published',clock_timestamp())`,
      [seed.ratingPolicyRevisionRef, seed.siteId, "2".repeat(64)],
    );
    const issuanceEntries = [
      creditJournalEntry(seed, 0, "debit", "grant_issuance_source", null),
      creditJournalEntry(seed, 1, "credit", "customer_available", null),
    ] as const;
    await client.query(
      `INSERT INTO platform.credit_journal_transaction
       (journal_transaction_ref,credit_account_ref,site_ref,unit,business_operation_key,
        request_digest,operation_kind,expected_entry_count,entries_digest,occurred_at)
       VALUES ($1::uuid,$2::uuid,$3,'credit_micros',$4,$5,'grant_issue',2,$6,clock_timestamp())`,
      [seed.issuanceJournalRef, seed.creditAccountRef, seed.siteId,
        `issue-${seed.creditGrantRef}`, "3".repeat(64), creditJournalDigest(issuanceEntries)],
    );
    await client.query(
      `INSERT INTO platform.credit_grant
       (credit_grant_id,credit_account_ref,site_ref,billing_account_ref,credit_program_revision_ref,
        credit_program_revision,credit_program_revision_digest,source_type,source_ref,
        source_window_key,issuance_journal_transaction_ref,ux_bucket_class,unit,
        liability_merchant_account_ref,original_amount,burn_priority,scope_policy,
        effective_at,acquired_at,issued_at)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5,1,$9,'admin_grant',$8,'',$6::uuid,'permanent',
               'credit_micros','merchant-component',100,1000,$7::jsonb,
               transaction_timestamp(),transaction_timestamp(),transaction_timestamp())`,
      [seed.creditGrantRef, seed.creditAccountRef, seed.siteId, seed.billingAccountId,
        seed.creditProgramRevisionRef, seed.issuanceJournalRef, JSON.stringify(scopePolicy),
        `admin-${seed.creditGrantRef}`, "1".repeat(64)],
    );
    await insertCreditJournalEntries(client, seed.issuanceJournalRef, issuanceEntries);
    await client.query(
      `INSERT INTO platform.credit_hold
       (credit_hold_ref,credit_account_ref,site_ref,execution_root_ref,unit,requested_amount,
        reserved_amount,state,expires_at)
       VALUES ($1::uuid,$2::uuid,$3,$4,'credit_micros',100,100,'open',clock_timestamp()+interval '5 minutes')`,
      [seed.holdRef, seed.creditAccountRef, seed.siteId, `execution-${seed.rootRef}`],
    );
    const reserveEntries = [
      creditJournalEntry(seed, 0, "debit", "customer_available", seed.holdRef),
      creditJournalEntry(seed, 1, "credit", "customer_reserved", seed.holdRef),
    ] as const;
    await client.query(
      `INSERT INTO platform.credit_journal_transaction
       (journal_transaction_ref,credit_account_ref,site_ref,unit,business_operation_key,
        request_digest,operation_kind,expected_entry_count,entries_digest,occurred_at)
       VALUES ($1::uuid,$2::uuid,$3,'credit_micros',$4,$5,'hold_reserve',2,$6,clock_timestamp())`,
      [seed.reserveJournalRef, seed.creditAccountRef, seed.siteId,
        `reserve-${seed.holdRef}`, "4".repeat(64), creditJournalDigest(reserveEntries)],
    );
    await client.query(
      `INSERT INTO platform.credit_hold_allocation
       (credit_hold_ref,credit_grant_id,site_ref,credit_account_ref,unit,
        reserve_journal_transaction_ref,allocated_amount,allocation_ordinal)
       VALUES ($1::uuid,$2::uuid,$3,$4::uuid,'credit_micros',$5::uuid,100,0)`,
      [seed.holdRef, seed.creditGrantRef, seed.siteId, seed.creditAccountRef,
        seed.reserveJournalRef],
    );
    await insertCreditJournalEntries(client, seed.reserveJournalRef, reserveEntries);
    await client.query(
      `INSERT INTO platform.credit_execution_budget_root
       (execution_budget_root_ref,site_ref,execution_root_ref,billing_account_ref,credit_account_ref,
        unit,liability_merchant_account_ref,credit_hold_ref,root_allocation_ref,
        authorization_budget_ref,rating_policy_revision_ref,surface_ref,capability_key,reserved_ceiling,state)
       VALUES ($1::uuid,$2,$3,$4,$5::uuid,'credit_micros','merchant-component',$6::uuid,$7::uuid,
               'budget-component',$8,'media.image','image.text_to_image',100,'open')`,
      [seed.rootRef, seed.siteId, `execution-${seed.rootRef}`, seed.billingAccountId,
        seed.creditAccountRef, seed.holdRef, seed.allocationRef, seed.ratingPolicyRevisionRef],
    );
    await client.query(
      `INSERT INTO platform.credit_budget_allocation
       (budget_allocation_ref,execution_budget_root_ref,site_ref,billing_account_ref,credit_account_ref,
        unit,liability_merchant_account_ref,parent_allocation_ref,is_root,audience,purpose)
       VALUES ($1::uuid,$2::uuid,$3,$4,$5::uuid,'credit_micros','merchant-component',NULL,TRUE,'root','execution_root')`,
      [seed.allocationRef, seed.rootRef, seed.siteId, seed.billingAccountId, seed.creditAccountRef],
    );
    await client.query(
      `INSERT INTO platform.credit_budget_allocation_revision
       (allocation_revision_ref,budget_allocation_ref,execution_budget_root_ref,site_ref,billing_account_ref,
        credit_account_ref,unit,liability_merchant_account_ref,revision,allocation_epoch,credit_ceiling,
        unassigned_stock,active_child_reserved_stock,committed_stock,captured_cumulative,
        returned_to_parent_cumulative,state)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,'credit_micros','merchant-component',
               1,1,100,100,0,0,0,0,'active')`,
      [randomUUID(), seed.allocationRef, seed.rootRef, seed.siteId, seed.billingAccountId,
        seed.creditAccountRef],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

type CreditJournalSeedEntry = Readonly<{
  ordinal: number;
  siteId: string;
  creditAccountRef: string;
  side: "credit" | "debit";
  accountType: "customer_available" | "customer_reserved" | "grant_issuance_source";
  amount: "100";
  creditGrantRef: string;
  creditHoldRef: string | null;
}>;

function creditJournalEntry(
  seed: CreditConcurrencySeed,
  ordinal: number,
  side: CreditJournalSeedEntry["side"],
  accountType: CreditJournalSeedEntry["accountType"],
  creditHoldRef: string | null,
): CreditJournalSeedEntry {
  return Object.freeze({ ordinal, siteId: seed.siteId, creditAccountRef: seed.creditAccountRef,
    side, accountType, amount: "100", creditGrantRef: seed.creditGrantRef, creditHoldRef });
}

function creditJournalDigest(entries: readonly CreditJournalSeedEntry[]): string {
  return creditJournalEntriesDigest(entries.map((entry) => ({
    ordinal: entry.ordinal,
    siteId: entry.siteId,
    creditAccountId: entry.creditAccountRef,
    unit: "credit_micros",
    side: entry.side,
    accountType: entry.accountType,
    amount: entry.amount,
    creditGrantId: entry.creditGrantRef,
    creditHoldRef: entry.creditHoldRef,
  })));
}

async function insertCreditJournalEntries(
  client: Client,
  journalTransactionRef: string,
  entries: readonly CreditJournalSeedEntry[],
): Promise<void> {
  for (const entry of entries) {
    await client.query(
      `INSERT INTO platform.credit_journal_entry
       (journal_transaction_ref,entry_ordinal,site_ref,credit_account_ref,unit,entry_side,
        account_type,amount,credit_grant_id,credit_hold_ref)
       VALUES ($1::uuid,$2,$3,$4::uuid,'credit_micros',$5,$6,$7,$8::uuid,$9::uuid)`,
      [journalTransactionRef, entry.ordinal, entry.siteId, entry.creditAccountRef, entry.side,
        entry.accountType, entry.amount, entry.creditGrantRef, entry.creditHoldRef],
    );
  }
}

function pgTransaction(client: Client): PlatformSqlTransaction {
  return {
    async query<Row extends Record<string, unknown>>(statement: string, values?: readonly unknown[]) {
      return (await client.query<Row>(statement, values as unknown[] | undefined)).rows;
    },
    async execute(statement: string, values?: readonly unknown[]) {
      return (await client.query(statement, values as unknown[] | undefined)).rowCount ?? 0;
    },
  };
}

async function waitForPostgresLock(client: Client, pid: number | undefined): Promise<boolean> {
  if (pid === undefined) return false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = await client.query<{ wait_event_type: string | null }>(
      "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
      [pid],
    );
    if (state.rows[0]?.wait_event_type === "Lock") return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

function createWorkerDatabaseClient(
  role: PlatformWorkerAuthorityRole,
): PlatformTransactionalDatabaseClient {
  return createPlatformDatabaseClient(
    loadPlatformDatabaseConfig(role, {
      DATABASE_URL_PLATFORM: workerDatabaseUrls[role],
      PLATFORM_DATABASE_CREDENTIAL_CLASS: role,
      [workerRoleEnvironmentName(role)]: workerUsers[role],
      PLATFORM_DATABASE_MIGRATOR_ROLE: migratorUser,
      PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
    }),
  );
}

async function readMemoryAuthorityInventory(client: Client): Promise<unknown> {
  const result = await client.query<{ inventory: unknown }>(
    `WITH memory_role AS (
       SELECT role_row.* FROM pg_roles role_row
        WHERE role_row.rolname=ANY($1::text[])
     )
     SELECT jsonb_build_object(
       'roles',COALESCE((SELECT jsonb_agg(jsonb_build_object(
         'roleName',role_row.rolname,'roleOid',role_row.oid::text,
         'canLogin',role_row.rolcanlogin,'inherits',role_row.rolinherit,
         'isSuperuser',role_row.rolsuper,'canCreateDatabase',role_row.rolcreatedb,
         'canCreateRole',role_row.rolcreaterole,'canReplicate',role_row.rolreplication,
         'bypassesRls',role_row.rolbypassrls,
         'memberOf',COALESCE((SELECT jsonb_agg(granted.rolname ORDER BY granted.rolname)
           FROM pg_auth_members membership JOIN pg_roles granted ON granted.oid=membership.roleid
          WHERE membership.member=role_row.oid),'[]'::jsonb),
         'members',COALESCE((SELECT jsonb_agg(member.rolname ORDER BY member.rolname)
           FROM pg_auth_members membership JOIN pg_roles member ON member.oid=membership.member
          WHERE membership.roleid=role_row.oid),'[]'::jsonb),
         'databasePrivileges',jsonb_build_object(
           'connect',has_database_privilege(role_row.rolname,current_database(),'CONNECT'),
           'create',has_database_privilege(role_row.rolname,current_database(),'CREATE'),
           'temporary',has_database_privilege(role_row.rolname,current_database(),'TEMPORARY')),
         'ownership',jsonb_build_object(
           'database',(SELECT count(*) FROM pg_database value WHERE value.datdba=role_row.oid),
           'schema',(SELECT count(*) FROM pg_namespace value WHERE value.nspowner=role_row.oid),
           'relation',(SELECT count(*) FROM pg_class value WHERE value.relowner=role_row.oid),
           'sequence',(SELECT count(*) FROM pg_class value
             WHERE value.relowner=role_row.oid AND value.relkind='S'),
           'routine',(SELECT count(*) FROM pg_proc value WHERE value.proowner=role_row.oid),
           'type',(SELECT count(*) FROM pg_type value WHERE value.typowner=role_row.oid),
           'tablespace',(SELECT count(*) FROM pg_tablespace value
             WHERE value.spcowner=role_row.oid))
       ) ORDER BY role_row.rolname) FROM memory_role role_row),'[]'::jsonb),
       'identity',COALESCE((SELECT jsonb_agg(jsonb_build_object(
         'roleKind',identity.role_kind,'roleName',identity.role_name::text,
         'roleOid',identity.role_oid::text) ORDER BY identity.role_kind)
         FROM platform.memory_database_role_identity identity),'[]'::jsonb),
       'schemaAcl',COALESCE((SELECT jsonb_agg(jsonb_build_object(
         'roleName',role_row.rolname,'schema',namespace.nspname,
         'privilege',acl.privilege_type,'grantable',acl.is_grantable)
         ORDER BY role_row.rolname,namespace.nspname,acl.privilege_type)
         FROM pg_namespace namespace
         CROSS JOIN LATERAL aclexplode(namespace.nspacl) acl
         JOIN memory_role role_row ON role_row.oid=acl.grantee),'[]'::jsonb),
       'relationAcl',COALESCE((SELECT jsonb_agg(jsonb_build_object(
         'roleName',role_row.rolname,'relation',namespace.nspname||'.'||relation.relname,
         'kind',relation.relkind,'privilege',acl.privilege_type,
         'grantable',acl.is_grantable)
         ORDER BY role_row.rolname,namespace.nspname,relation.relname,acl.privilege_type)
         FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
         CROSS JOIN LATERAL aclexplode(relation.relacl) acl
         JOIN memory_role role_row ON role_row.oid=acl.grantee),'[]'::jsonb),
       'routineAcl',COALESCE((SELECT jsonb_agg(jsonb_build_object(
         'roleName',role_row.rolname,'routine',routine.oid::regprocedure::text,
         'privilege',acl.privilege_type,'grantable',acl.is_grantable)
         ORDER BY role_row.rolname,routine.oid::regprocedure::text,acl.privilege_type)
         FROM pg_proc routine
         CROSS JOIN LATERAL aclexplode(routine.proacl) acl
         JOIN memory_role role_row ON role_row.oid=acl.grantee),'[]'::jsonb),
       'defaultAcl',COALESCE((SELECT jsonb_agg(jsonb_build_object(
         'roleName',role_row.rolname,'owner',owner.rolname,
         'schema',namespace.nspname,'objectType',defaults.defaclobjtype,
         'privilege',acl.privilege_type,'grantable',acl.is_grantable)
         ORDER BY role_row.rolname,owner.rolname,namespace.nspname,
           defaults.defaclobjtype,acl.privilege_type)
         FROM pg_default_acl defaults JOIN pg_roles owner ON owner.oid=defaults.defaclrole
         LEFT JOIN pg_namespace namespace ON namespace.oid=defaults.defaclnamespace
         CROSS JOIN LATERAL aclexplode(defaults.defaclacl) acl
         JOIN memory_role role_row ON role_row.oid=acl.grantee),'[]'::jsonb)
     ) AS inventory`,
    [Object.values(memoryRoleNames)],
  );
  const inventory = result.rows[0]?.inventory;
  if (inventory === undefined) throw new Error("MEMORY_AUTHORITY_INVENTORY_MISSING");
  return inventory;
}

async function createLoginOnlyTestRole(
  client: Client,
  roleName: string,
  password: string,
): Promise<void> {
  await client.query(
    `CREATE ROLE ${quoteIdentifier(roleName)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB ` +
      `NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${sqlLiteral(password)}`,
  );
}

async function ensureLoginOnlyTestRole(
  client: Client,
  roleName: string,
  password: string,
): Promise<void> {
  const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [roleName]);
  if (role.rowCount === 0) await createLoginOnlyTestRole(client, roleName, password);
}

async function restoreExactWorkerAcl(
  client: Client,
  roleKind: PlatformWorkerAuthorityRole,
  roleName: string,
): Promise<void> {
  const role = quoteIdentifier(roleName);
  await client.query(
    `GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO ${role}; ` +
      `GRANT USAGE ON SCHEMA platform TO ${role}`,
  );
  for (const authority of SPLIT_WORKER_RELATION_AUTHORITY[roleKind]) {
    const columns = authority.columns?.map(quoteIdentifier).join(",");
    await client.query(
      `GRANT ${authority.privilege}${columns === undefined ? "" : `(${columns})`} ` +
        `ON TABLE platform.${quoteIdentifier(authority.relation)} TO ${role}`,
    );
  }
  for (const routine of SPLIT_WORKER_ROUTINE_AUTHORITY[roleKind]) {
    await client.query(`GRANT EXECUTE ON FUNCTION ${routine} TO ${role}`);
  }
}

function requireLeasedDatabaseUrl(value: string | undefined): string {
  if (!value) {
    throw new Error("PLATFORM_POSTGRES_LEASE_URL_REQUIRED");
  }

  const url = new URL(value);
  if (!url.pathname.slice(1).startsWith("kokoro_test_")) {
    throw new Error("DATABASE_URL_PLATFORM_TEST_MUST_BE_LEASED");
  }
  return value;
}

function directRootCanonicalPayload(kind: "closure" | "reconciliation"): Record<string, unknown> {
  const identity = {
    siteId: "site:canonical-regression",
    businessOperationKey: "canonical-regression:one", requestDigest: "a".repeat(64),
    ownerProof: {
      kind: "media_operation", sourceRef: "media:canonical-regression",
      terminalEvidenceRef: "effect:canonical-regression", outcome: "completed",
      proofDigest: "c".repeat(64),
      workerLease: { taskRef: "task:canonical-regression", leaseEpoch: "1",
        leaseTokenHash: "b".repeat(64) },
    },
  };
  const budget = {
    executionBudgetRootRef: "00000000-0000-7000-8000-000000000001",
    executionManifestRef: "manifest:canonical-regression",
    rootHoldRef: "00000000-0000-7000-8000-000000000002",
    rootAllocationRef: "00000000-0000-7000-8000-000000000003",
    rootAllocationRevision: "1", rootAllocationEpoch: "1",
    authorizationSegmentRef: "00000000-0000-7000-8000-000000000004",
    authorizationSegmentVersion: "1", reservedCeiling: "100", unit: "credit_micros",
  };
  const settlement = {
    settlementRef: "00000000-0000-7000-8000-000000000005",
    authorizationSegmentRef: "00000000-0000-7000-8000-000000000004",
    closureRef: "00000000-0000-7000-8000-000000000006",
    closureRevision: "1", state: "settled", customerAmount: "25",
    platformExposureAmount: "0",
  };
  const command = { terminalEvidenceRef: "effect:canonical-regression",
    outcome: "completed", budget, settlement };
  if (kind === "reconciliation") return { identity, command,
    authority: {
      executionBudgetRootRef: budget.executionBudgetRootRef,
      rootAllocationRef: budget.rootAllocationRef, rootHoldRef: budget.rootHoldRef,
      authorizationSegmentRef: budget.authorizationSegmentRef,
      settlementRef: settlement.settlementRef, executionManifestRef: budget.executionManifestRef,
      rootAllocationRevision: "1", rootAllocationEpoch: "1", authorizationSegmentVersion: "1",
      reservedCeiling: "100", unit: "credit_micros", expectedRootState: "open",
      expectedRootVersion: "1", expectedHoldState: "open", expectedHoldFenceEpoch: "1",
      expectedAllocationState: "active", expectedAllocationRevision: "1",
      expectedAllocationEpoch: "1",
    },
    result: {
      reconciliationReceiptRef: "00000000-0000-7000-8000-000000000007",
      reconciliationAllocationRevisionRef: "00000000-0000-7000-8000-000000000008",
      code: "CREDIT_EXECUTION_ROOT_RATING_MISMATCH", observedAt: "2026-08-12T12:00:00.000Z",
    },
  };
  return { identity, command, result: {
    allocation: { revision: "2", allocationEpoch: "2", creditCeiling: "100",
      unassignedStock: "0", activeChildReservedStock: "0", committedStock: "0",
      capturedCumulative: "25", returnedToParentCumulative: "75", state: "terminal" },
    allocationRevisionRef: "00000000-0000-7000-8000-000000000008",
    rootState: "settled", rootVersion: "2", holdState: "settled", holdFenceEpoch: "2",
    capturedAmount: "25", releasedAmount: "75", releases: [],
    releaseJournalTransactionRef: null, releaseEntriesDigest: null,
    receipt: {
      allocationClosureReceiptRef: "00000000-0000-7000-8000-000000000007",
      siteId: identity.siteId, sourceKind: identity.ownerProof.kind,
      sourceRef: identity.ownerProof.sourceRef, ownerProofDigest: identity.ownerProof.proofDigest,
      businessOperationKey: identity.businessOperationKey, requestDigest: identity.requestDigest,
      terminalEvidenceRef: command.terminalEvidenceRef,
      settlementRef: settlement.settlementRef, executionBudgetRootRef: budget.executionBudgetRootRef,
      rootAllocationRef: budget.rootAllocationRef, rootHoldRef: budget.rootHoldRef,
      capturedAmount: "25", releasedAmount: "75", unit: "credit_micros",
      outcome: "completed", executionManifestRef: budget.executionManifestRef,
      authorizationSegmentRef: budget.authorizationSegmentRef, authorizationSegmentVersion: "1",
      settlementClosureRef: settlement.closureRef, settlementClosureRevision: "1",
      platformExposureAmount: "0", ratingSnapshotRef: "00000000-0000-7000-8000-000000000009",
      receiptDigest: "c".repeat(64), recordedAt: "2026-08-12T12:00:00.000Z",
    },
  } };
}

function workerRoleEnvironmentName(role: PlatformWorkerAuthorityRole): string {
  return `PLATFORM_DATABASE_${role.replaceAll("-", "_").toUpperCase()}_ROLE`;
}

async function replaceSelectPolicy(
  client: Client,
  policyName: string,
  roleName: string,
  owners: readonly string[],
  mode: "PERMISSIVE" | "RESTRICTIVE",
): Promise<void> {
  if (
    !/^[a-z_][a-z0-9_]{0,62}$/u.test(policyName) ||
    !/^[a-z_][a-z0-9_]{0,62}$/u.test(roleName) ||
    owners.length < 1
  ) {
    throw new Error("COMPONENT_POLICY_REPLACEMENT_INVALID");
  }
  const ownerLiterals = owners.map(sqlLiteral).join(",");
  await client.query(`DROP POLICY IF EXISTS ${policyName} ON platform.outbox_event`);
  await client.query(
    `CREATE POLICY ${policyName} ON platform.outbox_event AS ${mode} FOR SELECT ` +
      `TO ${roleName} USING (current_user=${sqlLiteral(roleName)} AND ` +
      `owner=ANY(ARRAY[${ownerLiterals}]::text[]))`,
  );
}

function requireRole(value: string | undefined): string {
  if (!value) throw new Error("PLATFORM_DATABASE_RUNTIME_ROLE_REQUIRED");
  return value;
}

function insertOutboxEvent(
  client: Client,
  eventId: string,
  owner: OutboxOwner,
  producer: string,
): Promise<QueryResult> {
  return client.query(
    `INSERT INTO platform.outbox_event
       (event_id,owner,event_type,aggregate_id,payload,payload_digest,
        correlation_id,causation_id)
     VALUES ($1::uuid,$2,$3,$4,'{}'::jsonb,$5,$6,$7)`,
    [
      eventId,
      owner,
      OUTBOX_ROUTE_CATALOG[owner].eventTypes[0],
      `${producer}:${eventId}`,
      "0".repeat(64),
      `${producer}:correlation`,
      `${producer}:causation`,
    ],
  );
}

async function restorePolicy(
  client: Client,
  policyName: string,
  roleName: string,
  clause: "USING" | "WITH CHECK",
  owners: readonly string[],
): Promise<void> {
  if (
    !/^[a-z_][a-z0-9_]{0,62}$/u.test(policyName) ||
    !/^[a-z_][a-z0-9_]{0,62}$/u.test(roleName) ||
    owners.length < 1
  ) {
    throw new Error("COMPONENT_POLICY_RESTORE_INVALID");
  }
  const ownerLiterals = owners.map(sqlLiteral).join(",");
  await client.query(
    `ALTER POLICY ${policyName} ON platform.outbox_event ${clause} (` +
      `current_user=${sqlLiteral(roleName)} AND ` +
      `owner=ANY(ARRAY[${ownerLiterals}]::text[]))`,
  );
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) {
    throw new Error("COMPONENT_SQL_IDENTIFIER_INVALID");
  }
  return `"${value}"`;
}
