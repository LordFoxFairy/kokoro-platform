import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPlatformDatabaseClient,
  loadPlatformDatabaseConfig,
  type PlatformDatabaseClient,
} from "../../src/infrastructure/postgres/client.js";
import { runPlatformMigrations } from "../../src/infrastructure/postgres/migrator.js";

const migratorDatabaseUrl = requireLeasedDatabaseUrl(
  process.env.DATABASE_URL_PLATFORM_MIGRATOR_TEST,
);
const apiDatabaseUrl = requireLeasedDatabaseUrl(process.env.DATABASE_URL_PLATFORM_API_TEST);
const migratorUser = decodeURIComponent(new URL(migratorDatabaseUrl).username);
const apiUser = decodeURIComponent(new URL(apiDatabaseUrl).username);
const workerUser = requireRole(process.env.PLATFORM_DATABASE_WORKER_ROLE);
const adminUser = requireRole(process.env.PLATFORM_DATABASE_ADMIN_ROLE);
const databaseName = decodeURIComponent(new URL(migratorDatabaseUrl).pathname.slice(1));
let database: PlatformDatabaseClient;

describe("Platform PostgreSQL foundation", () => {
  beforeAll(async () => {
    await runPlatformMigrations({
      environment: {
        DATABASE_URL_PLATFORM: migratorDatabaseUrl,
        PLATFORM_DATABASE_AUTHORITY_MODE: "transition-candidate",
        PLATFORM_DATABASE_CREDENTIAL_CLASS: "migrator",
        PLATFORM_DATABASE_MIGRATOR_ROLE: migratorUser,
        PLATFORM_DATABASE_API_ROLE: apiUser,
        PLATFORM_DATABASE_WORKER_ROLE: workerUser,
        PLATFORM_DATABASE_ADMIN_ROLE: adminUser,
        PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
        PATH: process.env.PATH,
      },
    });
    database = createPlatformDatabaseClient(
      loadPlatformDatabaseConfig("api", {
        DATABASE_URL_PLATFORM: apiDatabaseUrl,
        PLATFORM_DATABASE_AUTHORITY_MODE: "transition-candidate",
        PLATFORM_DATABASE_CREDENTIAL_CLASS: "api",
        PLATFORM_DATABASE_API_ROLE: apiUser,
        PLATFORM_DATABASE_MIGRATOR_ROLE: migratorUser,
        PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
      }),
    );
    await database.connect();
  }, 60_000);

  afterAll(async () => {
    await database?.disconnect();
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
