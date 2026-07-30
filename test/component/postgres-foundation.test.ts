import { Client, type QueryResult } from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPlatformDatabaseClient,
  loadPlatformDatabaseConfig,
  type PlatformDatabaseClient,
} from "../../src/infrastructure/postgres/client.js";
import { runPlatformMigrations } from "../../src/infrastructure/postgres/migrator.js";
import {
  createPostgresModelGatewayDatabase,
  loadModelGatewayDatabaseConfig,
} from "../../src/modules/model-gateway/infrastructure/postgres/model-gateway-database.js";
import {
  OUTBOX_ROUTE_CATALOG,
  type OutboxOwner,
} from "../../src/shared/outbox-inbox/outbox.js";

const migratorDatabaseUrl = requireLeasedDatabaseUrl(
  process.env.DATABASE_URL_PLATFORM_MIGRATOR_TEST,
);
const apiDatabaseUrl = requireLeasedDatabaseUrl(process.env.DATABASE_URL_PLATFORM_API_TEST);
const admissionDatabaseUrl = requireLeasedDatabaseUrl(
  process.env.DATABASE_URL_PLATFORM_ADMISSION_TEST,
);
const assetDataPlaneDatabaseUrl = requireLeasedDatabaseUrl(
  process.env.DATABASE_URL_PLATFORM_ASSET_DATA_PLANE_TEST,
);
const identityWorkerDatabaseUrl = requireLeasedDatabaseUrl(
  process.env.DATABASE_URL_PLATFORM_IDENTITY_WORKER_TEST,
);
const workerDatabaseUrl = requireLeasedDatabaseUrl(
  process.env.DATABASE_URL_PLATFORM_WORKER_TEST,
);
const adminDatabaseUrl = requireLeasedDatabaseUrl(
  process.env.DATABASE_URL_PLATFORM_ADMIN_TEST,
);
const modelGatewayDatabaseUrl = requireLeasedDatabaseUrl(
  process.env.DATABASE_URL_PLATFORM_MODEL_GATEWAY_TEST,
);
const migratorUser = decodeURIComponent(new URL(migratorDatabaseUrl).username);
const apiUser = decodeURIComponent(new URL(apiDatabaseUrl).username);
const authorizationUser = requireRole(process.env.PLATFORM_DATABASE_AUTHORIZATION_ROLE);
const admissionUser = requireRole(process.env.PLATFORM_DATABASE_ADMISSION_ROLE);
const assetDataPlaneUser = requireRole(process.env.PLATFORM_DATABASE_ASSET_DATA_PLANE_ROLE);
const workerUser = requireRole(process.env.PLATFORM_DATABASE_WORKER_ROLE);
const identityWorkerUser = requireRole(process.env.PLATFORM_DATABASE_IDENTITY_WORKER_ROLE);
const adminUser = requireRole(process.env.PLATFORM_DATABASE_ADMIN_ROLE);
const modelGatewayUser = requireRole(process.env.PLATFORM_DATABASE_MODEL_GATEWAY_ROLE);
const databaseName = decodeURIComponent(new URL(migratorDatabaseUrl).pathname.slice(1));
let database: PlatformDatabaseClient;
let identityWorkerDatabase: PlatformDatabaseClient;
let modelGatewayDatabase: ReturnType<typeof createPostgresModelGatewayDatabase>;

describe("Platform PostgreSQL foundation", () => {
  beforeAll(async () => {
    await runPlatformMigrations({
      environment: {
        DATABASE_URL_PLATFORM: migratorDatabaseUrl,
        PLATFORM_DATABASE_CREDENTIAL_CLASS: "migrator",
        PLATFORM_DATABASE_MIGRATOR_ROLE: migratorUser,
        PLATFORM_DATABASE_API_ROLE: apiUser,
        PLATFORM_DATABASE_ADMISSION_ROLE: admissionUser,
        PLATFORM_DATABASE_AUTHORIZATION_ROLE: authorizationUser,
        PLATFORM_DATABASE_ASSET_DATA_PLANE_ROLE: assetDataPlaneUser,
        PLATFORM_DATABASE_WORKER_ROLE: workerUser,
        PLATFORM_DATABASE_IDENTITY_WORKER_ROLE: identityWorkerUser,
        PLATFORM_DATABASE_ADMIN_ROLE: adminUser,
        PLATFORM_DATABASE_MODEL_GATEWAY_ROLE: modelGatewayUser,
        PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
        PATH: process.env.PATH,
      },
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
    identityWorkerDatabase = createPlatformDatabaseClient(
      loadPlatformDatabaseConfig("identity-worker", {
        DATABASE_URL_PLATFORM: identityWorkerDatabaseUrl,
        PLATFORM_DATABASE_CREDENTIAL_CLASS: "identity-worker",
        PLATFORM_DATABASE_IDENTITY_WORKER_ROLE: identityWorkerUser,
        PLATFORM_DATABASE_MIGRATOR_ROLE: migratorUser,
        PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
      }),
    );
    await identityWorkerDatabase.connect();
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
    await identityWorkerDatabase?.disconnect();
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
      await expect(direct.query(
        `INSERT INTO platform.outbox_event
         (event_id,owner,event_type,aggregate_id,payload,payload_digest,correlation_id)
         VALUES (
           '30000000-0000-4000-8000-000000000001','identity',
           'identity.totp.enrollment_started','component-local-fact','{}'::jsonb,
           repeat('d',64),'component-security-correlation'
         )`,
      )).rejects.toMatchObject({ code: "23514" });
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
      { name: "admin", url: adminDatabaseUrl,
        allowed: ["admin-execution", "commerce", "site"] },
      { name: "worker", url: workerDatabaseUrl,
        allowed: ["commerce", "credit", "site", "asset", "admin-execution"] },
    ] as const;
    const allOwners = [
      "identity", "commerce", "asset", "credit", "site", "admin-execution",
    ] as const satisfies readonly OutboxOwner[];
    const clients = producers.map((producer) => new Client({ connectionString: producer.url }));
    const insertedByOwner = new Map<string, string[]>();
    try {
      await Promise.all([
        migrator.connect(), identity.connect(), assetDataPlane.connect(),
        ...clients.map((client) => client.connect()),
      ]);
      await expect(migrator.query<{
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
      `)).resolves.toMatchObject({ rows: [{
        row_level_security: true,
        force_row_level_security: true,
        policy_count: "11",
        public_policy_count: "0",
        restrictive_policy_count: "0",
      }] });
      await expect(migrator.query<{
        function_owner: string;
        security_definer: boolean;
        fixed_search_path: boolean;
        public_can_execute: boolean;
        data_plane_can_execute: boolean;
      }>(`
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
      `, [assetDataPlaneUser])).resolves.toMatchObject({ rows: [{
        function_owner: migratorUser,
        security_definer: true,
        fixed_search_path: true,
        public_can_execute: false,
        data_plane_can_execute: true,
      }] });

      const assetCompletionEventId = randomUUID();
      const assetSessionRef = `asset-session-${randomUUID()}`;
      const assetPayload = {
        kind: "asset_upload_completion_requested_v1",
        siteRef: "site-component",
        intentRef: `asset-intent-${randomUUID()}`,
        sessionRef: assetSessionRef,
        expectedVersion: "1",
      };
      await assetDataPlane.query(
        `SELECT set_config('app.operation','asset.multipart.complete',false),
                set_config('app.workload_kind','site_product',false),
                set_config('app.actor_kind','user',false),
                set_config('app.scopes','["asset:upload"]',false),
                set_config('app.site_id',$1,false)`,
        [assetPayload.siteRef],
      );
      await expect(assetDataPlane.query(
        `SELECT platform.enqueue_asset_upload_completion_event(
          $1::uuid,$2,$3::jsonb,$4::char(64),$5,$6
        )`,
        [assetCompletionEventId, assetSessionRef, JSON.stringify(assetPayload),
          "a".repeat(64), "asset-component-correlation", "asset-component-causation"],
      )).resolves.toMatchObject({ rowCount: 1 });
      await expect(assetDataPlane.query(
        `SELECT platform.enqueue_asset_upload_completion_event(
          $1::uuid,$2,$3::jsonb,$4::char(64),$5,$6
        )`,
        [assetCompletionEventId, assetSessionRef, JSON.stringify(assetPayload),
          "a".repeat(64), "asset-component-correlation", "asset-component-causation"],
      )).rejects.toMatchObject({ code: "23505" });
      await expect(assetDataPlane.query(
        "SELECT event_id FROM platform.outbox_event LIMIT 1",
      )).rejects.toMatchObject({ code: "42501" });
      await expect(insertOutboxEvent(
        assetDataPlane,
        randomUUID(),
        "asset",
        "asset-data-plane-forged-direct",
      )).rejects.toMatchObject({ code: "42501" });

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
          await expect(insertOutboxEvent(client, randomUUID(), owner, `${producer.name}-forged`))
            .rejects.toMatchObject({ code: "42501" });
        }
      }

      await expect(identity.query(
        "SELECT DISTINCT owner FROM platform.outbox_event ORDER BY owner",
      )).resolves.toMatchObject({ rows: [{ owner: "identity" }] });
      const worker = clients[3];
      if (worker === undefined) throw new Error("COMPONENT_WORKER_CLIENT_MISSING");
      await expect(worker.query("SELECT DISTINCT owner FROM platform.outbox_event ORDER BY owner"))
        .resolves.toMatchObject({ rows: [
          { owner: "admin-execution" }, { owner: "asset" }, { owner: "commerce" },
          { owner: "credit" }, { owner: "site" },
        ] });
      await expect(worker.query(
        "SELECT event_id FROM platform.outbox_event WHERE event_id=$1",
        [assetCompletionEventId],
      )).resolves.toMatchObject({ rows: [{ event_id: assetCompletionEventId }] });
      await expect(migrator.query(
        "SELECT event_id FROM platform.outbox_event WHERE event_id=$1",
        [assetCompletionEventId],
      )).resolves.toMatchObject({ rowCount: 0 });
      await expect(migrator.query(
        "UPDATE platform.outbox_event SET state='dead_letter' WHERE event_id=$1",
        [assetCompletionEventId],
      )).resolves.toMatchObject({ rowCount: 0 });
      await expect(migrator.query(
        "DELETE FROM platform.outbox_event WHERE event_id=$1",
        [assetCompletionEventId],
      )).resolves.toMatchObject({ rowCount: 0 });
      const identityEvent = insertedByOwner.get("identity")?.[0];
      const commerceEvent = insertedByOwner.get("commerce")?.[0];
      if (identityEvent === undefined || commerceEvent === undefined) {
        throw new Error("COMPONENT_OUTBOX_SEED_MISSING");
      }
      await expect(identity.query(
        "UPDATE platform.outbox_event SET state='dead_letter' WHERE event_id=$1",
        [commerceEvent],
      )).resolves.toMatchObject({ rowCount: 0 });
      await expect(worker.query(
        "UPDATE platform.outbox_event SET state='dead_letter' WHERE event_id=$1",
        [identityEvent],
      )).resolves.toMatchObject({ rowCount: 0 });
      await expect(identity.query(
        "UPDATE platform.outbox_event SET owner='commerce' WHERE event_id=$1",
        [identityEvent],
      )).rejects.toMatchObject({ code: "42501" });
    } finally {
      await migrator.query("TRUNCATE TABLE platform.outbox_event").catch(() => undefined);
      await Promise.allSettled([
        migrator.end(), identity.end(), assetDataPlane.end(),
        ...clients.map((client) => client.end()),
      ]);
    }
  });

  it("fails runtime startup for extra PUBLIC or same-name widened policies", async () => {
    const migrator = new Client({ connectionString: migratorDatabaseUrl });
    await migrator.connect();
    try {
      await migrator.query(
        "CREATE POLICY outbox_public_probe ON platform.outbox_event FOR SELECT TO PUBLIC USING (FALSE)",
      );
      const invalidApi = createPlatformDatabaseClient(loadPlatformDatabaseConfig("api", {
        DATABASE_URL_PLATFORM: apiDatabaseUrl,
        PLATFORM_DATABASE_CREDENTIAL_CLASS: "api",
        PLATFORM_DATABASE_API_ROLE: apiUser,
        PLATFORM_DATABASE_MIGRATOR_ROLE: migratorUser,
        PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
      }));
      try {
        await expect(invalidApi.connect())
          .rejects.toThrowError("PLATFORM_RUNTIME_DATABASE_ROLE_INVALID");
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
        await expect(invalidIdentity.connect())
          .rejects.toThrowError("PLATFORM_RUNTIME_DATABASE_ROLE_INVALID");
      } finally {
        await invalidIdentity.disconnect();
      }
      await restorePolicy(migrator, "outbox_identity_worker_select", identityWorkerUser,
        "USING", ["identity"]);

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
        await expect(invalidModelGateway.connect())
          .rejects.toThrowError("MODEL_GATEWAY_DATABASE_ROLE_INVALID");
      } finally {
        await invalidModelGateway.disconnect();
      }
      await restorePolicy(migrator, "outbox_admin_insert", adminUser,
        "WITH CHECK", ["admin-execution", "commerce", "site"]);

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
        await expect(restrictiveIdentity.connect())
          .rejects.toThrowError("PLATFORM_RUNTIME_DATABASE_ROLE_INVALID");
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
      await migrator.query("DROP POLICY IF EXISTS outbox_public_probe ON platform.outbox_event")
        .catch(() => undefined);
      await replaceSelectPolicy(
        migrator,
        "outbox_identity_worker_select",
        identityWorkerUser,
        ["identity"],
        "PERMISSIVE",
      ).catch(() => undefined);
      await restorePolicy(migrator, "outbox_admin_insert", adminUser,
        "WITH CHECK", ["admin-execution", "commerce", "site"]).catch(() => undefined);
      await migrator.end();
    }
  });
});

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

async function replaceSelectPolicy(
  client: Client,
  policyName: string,
  roleName: string,
  owners: readonly string[],
  mode: "PERMISSIVE" | "RESTRICTIVE",
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(policyName) ||
      !/^[a-z_][a-z0-9_]{0,62}$/u.test(roleName) || owners.length < 1) {
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
    [eventId, owner, OUTBOX_ROUTE_CATALOG[owner].eventTypes[0], `${producer}:${eventId}`,
      "0".repeat(64), `${producer}:correlation`, `${producer}:causation`],
  );
}

async function restorePolicy(
  client: Client,
  policyName: string,
  roleName: string,
  clause: "USING" | "WITH CHECK",
  owners: readonly string[],
): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(policyName) ||
      !/^[a-z_][a-z0-9_]{0,62}$/u.test(roleName) || owners.length < 1) {
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
