import { Client } from "pg";
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

const migratorDatabaseUrl = requireLeasedDatabaseUrl(
  process.env.DATABASE_URL_PLATFORM_MIGRATOR_TEST,
);
const apiDatabaseUrl = requireLeasedDatabaseUrl(process.env.DATABASE_URL_PLATFORM_API_TEST);
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
    const direct = new Client({ connectionString: apiDatabaseUrl });
    await direct.connect();
    await direct.query("BEGIN");
    try {
      await direct.query(`
        INSERT INTO platform.authorization_site
          (site_ref,state,security_epoch,policy_epoch,revocation_epoch)
        VALUES ('component-security-site','active',1,1,1);
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
    }
  });

  it("fences shared outbox reads and updates by authenticated worker role and owner", async () => {
    const migrator = new Client({ connectionString: migratorDatabaseUrl });
    const api = new Client({ connectionString: apiDatabaseUrl });
    const admin = new Client({ connectionString: adminDatabaseUrl });
    const modelGateway = new Client({ connectionString: modelGatewayDatabaseUrl });
    const identity = new Client({ connectionString: identityWorkerDatabaseUrl });
    const worker = new Client({ connectionString: workerDatabaseUrl });
    const identityEvent = randomUUID();
    const commerceEvent = randomUUID();
    const adminEvent = randomUUID();
    const siteEvent = randomUUID();
    const usageEvent = randomUUID();
    const forbiddenEvent = randomUUID();
    try {
      await Promise.all([
        migrator.connect(), api.connect(), admin.connect(), modelGateway.connect(),
        identity.connect(), worker.connect(),
      ]);
      await migrator.query(
        `INSERT INTO platform.outbox_event
         (event_id,owner,event_type,aggregate_id,payload,payload_digest,correlation_id)
         VALUES ($1,'commerce','commerce.test','commerce-test','{}'::jsonb,$2,'test')`,
        [commerceEvent, "0".repeat(64)],
      );
      await api.query(
        `INSERT INTO platform.outbox_event
         (event_id,owner,event_type,aggregate_id,payload,payload_digest,correlation_id)
         VALUES ($1,'identity','identity.test','identity-test','{}'::jsonb,$2,'test')`,
        [identityEvent, "0".repeat(64)],
      );
      await admin.query(
        `INSERT INTO platform.outbox_event
         (event_id,owner,event_type,aggregate_id,payload,payload_digest,correlation_id)
         VALUES ($1,'admin-control','admin.test','admin-test','{}'::jsonb,$2,'test')`,
        [adminEvent, "0".repeat(64)],
      );
      await worker.query(
        `INSERT INTO platform.outbox_event
         (event_id,owner,event_type,aggregate_id,payload,payload_digest,correlation_id)
         VALUES ($1,'site','site.test','site-test','{}'::jsonb,$2,'test')`,
        [siteEvent, "0".repeat(64)],
      );
      await modelGateway.query(
        `INSERT INTO platform.outbox_event
         (event_id,owner,event_type,aggregate_id,payload,payload_digest,correlation_id)
         VALUES ($1,'credit-usage-rating','credit.test','credit-test','{}'::jsonb,$2,'test')`,
        [usageEvent, "0".repeat(64)],
      );

      await expect(identity.query(
        "SELECT owner FROM platform.outbox_event WHERE event_id=ANY($1::uuid[]) ORDER BY owner",
        [[identityEvent, commerceEvent, adminEvent, siteEvent, usageEvent]],
      )).resolves.toMatchObject({ rows: [{ owner: "identity" }] });
      await expect(worker.query(
        "SELECT owner FROM platform.outbox_event WHERE event_id=ANY($1::uuid[]) ORDER BY owner",
        [[identityEvent, commerceEvent, adminEvent, siteEvent, usageEvent]],
      )).resolves.toMatchObject({ rows: [{ owner: "commerce" }, { owner: "site" }] });
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
      await expect(modelGateway.query(
        `INSERT INTO platform.outbox_event
         (event_id,owner,event_type,aggregate_id,payload,payload_digest,correlation_id)
         VALUES ($1,'identity','identity.test','identity-forbidden','{}'::jsonb,$2,'test')`,
        [forbiddenEvent, "0".repeat(64)],
      )).rejects.toMatchObject({ code: "42501" });
    } finally {
      await migrator.query(
        "DELETE FROM platform.outbox_event WHERE event_id=ANY($1::uuid[])",
        [[identityEvent, commerceEvent, adminEvent, siteEvent, usageEvent, forbiddenEvent]],
      ).catch(() => undefined);
      await Promise.allSettled([
        migrator.end(), api.end(), admin.end(), modelGateway.end(), identity.end(), worker.end(),
      ]);
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

function requireRole(value: string | undefined): string {
  if (!value) throw new Error("PLATFORM_DATABASE_RUNTIME_ROLE_REQUIRED");
  return value;
}
