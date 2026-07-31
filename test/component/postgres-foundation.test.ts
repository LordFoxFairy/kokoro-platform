import { Client, type QueryResult } from "pg";
import { randomUUID } from "node:crypto";
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
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
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
const migratorUser = decodeURIComponent(new URL(migratorDatabaseUrl).username);
const apiUser = decodeURIComponent(new URL(apiDatabaseUrl).username);
const authorizationUser = requireRole(process.env.PLATFORM_DATABASE_AUTHORIZATION_ROLE);
const admissionUser = requireRole(process.env.PLATFORM_DATABASE_ADMISSION_ROLE);
const assetDataPlaneUser = requireRole(process.env.PLATFORM_DATABASE_ASSET_DATA_PLANE_ROLE);
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
    PLATFORM_DATABASE_COMMERCE_WORKER_ROLE: workerUsers["commerce-worker"],
    PLATFORM_DATABASE_SITE_WORKER_ROLE: workerUsers["site-worker"],
    PLATFORM_DATABASE_ASSET_WORKER_ROLE: workerUsers["asset-worker"],
    PLATFORM_DATABASE_ADMIN_WORKER_ROLE: workerUsers["admin-worker"],
    PLATFORM_DATABASE_IDENTITY_WORKER_ROLE: workerUsers["identity-worker"],
    PLATFORM_DATABASE_AUTHORIZATION_MAINTENANCE_ROLE:
      workerUsers["authorization-maintenance"],
    PLATFORM_DATABASE_ADMIN_ROLE: adminUser,
    PLATFORM_DATABASE_MODEL_GATEWAY_ROLE: modelGatewayUser,
    PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
    PATH: process.env.PATH,
  };
}

type CreditConcurrencySeed = Readonly<{
  siteId: string;
  billingAccountId: string;
  creditAccountRef: string;
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
    holdRef: randomUUID(),
    rootRef: randomUUID(),
    allocationRef: randomUUID(),
  });
}

async function insertCreditConcurrencySeed(client: Client, seed: CreditConcurrencySeed): Promise<void> {
  await client.query("BEGIN");
  try {
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
    await client.query(
      `INSERT INTO platform.credit_hold
       (credit_hold_ref,credit_account_ref,site_ref,execution_root_ref,unit,requested_amount,
        reserved_amount,state,expires_at)
       VALUES ($1::uuid,$2::uuid,$3,$4,'credit_micros',100,100,'open',clock_timestamp()+interval '5 minutes')`,
      [seed.holdRef, seed.creditAccountRef, seed.siteId, `execution-${seed.rootRef}`],
    );
    await client.query(
      `INSERT INTO platform.credit_execution_budget_root
       (execution_budget_root_ref,site_ref,execution_root_ref,billing_account_ref,credit_account_ref,
        unit,liability_merchant_account_ref,credit_hold_ref,root_allocation_ref,
        authorization_budget_ref,rating_policy_revision_ref,surface_ref,capability_key,reserved_ceiling,state)
       VALUES ($1::uuid,$2,$3,$4,$5::uuid,'credit_micros','merchant-component',$6::uuid,$7::uuid,
               'budget-component','rating-component','media.image','image.text_to_image',100,'open')`,
      [seed.rootRef, seed.siteId, `execution-${seed.rootRef}`, seed.billingAccountId,
        seed.creditAccountRef, seed.holdRef, seed.allocationRef],
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
