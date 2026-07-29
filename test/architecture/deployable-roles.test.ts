import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadPlatformDatabaseConfig,
  type PlatformDatabaseClient,
} from "../../src/infrastructure/postgres/client.js";
import {
  MIGRATION_ADVISORY_LOCK,
  runPlatformMigrations,
  type MigrationLockClient,
} from "../../src/infrastructure/postgres/migrator.js";
import { createPlatformApiProcess } from "../../src/process/api.js";
import { createPlatformWorkerProcess } from "../../src/process/worker.js";

const apiUrl = "postgresql://platform_api:secret@localhost:5432/kokoro_platform";
const workerUrl = "postgresql://platform_worker:secret@localhost:5432/kokoro_platform";
const authorizationUrl = "postgresql://platform_authorization:secret@localhost:5432/kokoro_platform";
const adminUrl = "postgresql://platform_admin:secret@localhost:5432/kokoro_platform";
const migratorUrl = "postgresql://platform_migrator:secret@localhost:5432/kokoro_platform";
const commonEnvironment = {
  PLATFORM_DATABASE_AUTHORITY_MODE: "transition-candidate",
  PLATFORM_DATABASE_EXPECTED_DATABASE: "kokoro_platform",
  PLATFORM_DATABASE_MIGRATOR_ROLE: "platform_migrator",
  PLATFORM_DATABASE_ADMIN_ROLE: "platform_admin",
  PLATFORM_DATABASE_AUTHORIZATION_ROLE: "platform_authorization",
} as const;

describe("Platform PostgreSQL authority", () => {
  it("loads an API-only identity with bounded connection and transaction settings", () => {
    const config = loadPlatformDatabaseConfig("api", {
      ...commonEnvironment,
      DATABASE_URL_PLATFORM: apiUrl,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "api",
      PLATFORM_DATABASE_API_ROLE: "platform_api",
    });

    expect(config).toMatchObject({
      role: "api",
      credentialClass: "api",
      authorityMode: "transition-candidate",
      expectedDatabaseUser: "platform_api",
      expectedDatabaseName: "kokoro_platform",
      migratorDatabaseUser: "platform_migrator",
      applicationName: "kokoro-platform-api",
      schema: "platform",
      pool: { max: 20, connectionTimeoutMs: 5_000 },
      session: {
        statementTimeoutMs: 15_000,
        lockTimeoutMs: 3_000,
        idleTransactionTimeoutMs: 10_000,
      },
      transaction: { isolationLevel: "ReadCommitted", maxWaitMs: 5_000, timeoutMs: 10_000 },
    });
    expect(config.safeDatabaseIdentity).toBe("localhost:5432/kokoro_platform");
    expect(JSON.stringify(config)).not.toContain("secret");
  });

  it("requires URL, expected database, and explicit process identity to agree", () => {
    expect(() =>
      loadPlatformDatabaseConfig("worker", {
        ...commonEnvironment,
        DATABASE_URL_PLATFORM: workerUrl,
        PLATFORM_DATABASE_CREDENTIAL_CLASS: "worker",
        PLATFORM_DATABASE_WORKER_ROLE: "unexpected_worker",
      }),
    ).toThrowError("PLATFORM_DATABASE_URL_USER_MISMATCH");
  });

  it("keeps API, Authorization, Worker, Admin, and migrator credential classes independent", () => {
    const api = loadPlatformDatabaseConfig("api", {
      ...commonEnvironment,
      DATABASE_URL_PLATFORM: apiUrl,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "api",
      PLATFORM_DATABASE_API_ROLE: "platform_api",
    });
    const worker = loadPlatformDatabaseConfig("worker", {
      ...commonEnvironment,
      DATABASE_URL_PLATFORM: workerUrl,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "worker",
      PLATFORM_DATABASE_WORKER_ROLE: "platform_worker",
    });
    const authorization = loadPlatformDatabaseConfig("authorization", {
      ...commonEnvironment,
      DATABASE_URL_PLATFORM: authorizationUrl,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "authorization",
    });
    const admin = loadPlatformDatabaseConfig("admin", {
      ...commonEnvironment,
      DATABASE_URL_PLATFORM: adminUrl,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "admin",
    });
    expect(
      new Set([
        api.expectedDatabaseUser,
        worker.expectedDatabaseUser,
        authorization.expectedDatabaseUser,
        admin.expectedDatabaseUser,
        api.migratorDatabaseUser,
      ]).size,
    ).toBe(5);
  });
});

describe("Platform migrator", () => {
  it("preflights PG18/roles, locks migration, grants role-scoped access, and sanitizes env", async () => {
    const events: string[] = [];
    const lockClient: MigrationLockClient = {
      async connect() {
        events.push("connect");
      },
      async query(sql, values) {
        if (sql.includes("server_version_num")) {
          events.push("preflight-migrator");
          return {
            rows: [
              {
                serverMajor: 18,
                currentUser: "platform_migrator",
                currentDatabase: "kokoro_platform",
                databaseOwner: "platform_migrator",
                isSuperuser: false,
                canCreateDatabase: false,
                canCreateRole: false,
                canReplicate: false,
                canBypassRls: false,
                inheritsPrivileges: false,
                hasAnyMembership: false,
                isApiMember: false,
                isAuthorizationMember: false,
                isWorkerMember: false,
                isAdminMember: false,
                canCreateDatabaseObject: true,
                schemaExists: false,
                schemaOwner: null,
                publicCanUseSchema: false,
                publicCanCreateSchema: false,
              },
            ],
          };
        }
        if (sql.includes("isMigratorMember")) {
          events.push("preflight-runtime-roles");
          return {
            rows: [
              safeRole("platform_api"),
              safeRole("platform_authorization"),
              safeRole("platform_worker"),
              safeRole("platform_admin"),
            ],
          };
        }
        if (sql.includes("canReadFoundation")) {
          events.push("verify-authority");
          return {
            rows: [
              authority("platform_api"),
              authority("platform_authorization"),
              authority("platform_worker"),
              authority("platform_admin"),
            ],
          };
        }
        if (/^(?:REVOKE|GRANT|ALTER DEFAULT PRIVILEGES)/u.test(sql)) {
          events.push("grant");
          return {};
        }
        events.push(`${sql}:${values?.join(",") ?? ""}`);
        return {};
      },
      async end() {
        events.push("end");
      },
    };

    await runPlatformMigrations({
      environment: {
        ...commonEnvironment,
        DATABASE_URL_PLATFORM: migratorUrl,
        PLATFORM_DATABASE_CREDENTIAL_CLASS: "migrator",
        PLATFORM_DATABASE_API_ROLE: "platform_api",
        PLATFORM_DATABASE_WORKER_ROLE: "platform_worker",
        PATH: "/usr/bin",
        NODE_OPTIONS: "--inspect=0.0.0.0:9229",
        SITE_PROVIDER_SECRET: "must-not-leak",
      },
      createLockClient: () => lockClient,
      execute: async (command, args, environment) => {
        events.push("execute");
        expect(command).toBe(process.execPath);
        expect(args).toContain(resolve("dist/prisma.config.js"));
        expect(environment.DATABASE_URL_PLATFORM).toBe(migratorUrl);
        expect(environment.PATH).toBe("/usr/bin");
        expect(environment.NODE_OPTIONS).toBeUndefined();
        expect(environment.SITE_PROVIDER_SECRET).toBeUndefined();
        return 0;
      },
    });

    expect(events.slice(0, 5)).toEqual([
      "connect",
      "preflight-migrator",
      "preflight-runtime-roles",
      `SELECT pg_advisory_lock(hashtext($1)):${MIGRATION_ADVISORY_LOCK}`,
      "execute",
    ]);
    expect(events.filter((event) => event === "grant")).toHaveLength(61);
    expect(events.slice(-3)).toEqual([
      "verify-authority",
      `SELECT pg_advisory_unlock(hashtext($1)):${MIGRATION_ADVISORY_LOCK}`,
      "end",
    ]);
  });

  it("fails closed when a runtime role belongs to any other database role", async () => {
    const lockClient: MigrationLockClient = {
      async connect() {},
      async query(sql) {
        if (sql.includes("server_version_num")) {
          return { rows: [safeMigratorAuthority()] };
        }
        if (sql.includes("hasAnyMembership") || sql.includes("isMigratorMember")) {
          return {
            rows: [
              safeRole("platform_api"),
              safeRole("platform_authorization"),
              { ...safeRole("platform_worker"), hasAnyMembership: true },
              safeRole("platform_admin"),
            ],
          };
        }
        return {};
      },
      async end() {},
    };

    await expect(
      runPlatformMigrations({
        environment: migratorEnvironment(),
        createLockClient: () => lockClient,
        execute: async () => 0,
      }),
    ).rejects.toThrowError("PLATFORM_RUNTIME_ROLE_PREFLIGHT_FAILED");
  });

  it("fails closed when a runtime role can access any Platform object beyond marker SELECT", async () => {
    const lockClient: MigrationLockClient = {
      async connect() {},
      async query(sql) {
        if (sql.includes("server_version_num")) return { rows: [safeMigratorAuthority()] };
        if (sql.includes("hasAnyMembership") || sql.includes("isMigratorMember")) {
          return {
            rows: [
              safeRole("platform_api"),
              safeRole("platform_authorization"),
              safeRole("platform_worker"),
              safeRole("platform_admin"),
            ],
          };
        }
        if (sql.includes("hasUnexpectedPlatformPrivilege")) {
          return {
            rows: [
              authority("platform_api"),
              authority("platform_authorization"),
              { ...authority("platform_worker"), hasUnexpectedPlatformPrivilege: true },
              authority("platform_admin"),
            ],
          };
        }
        return {};
      },
      async end() {},
    };

    await expect(
      runPlatformMigrations({
        environment: migratorEnvironment(),
        createLockClient: () => lockClient,
        execute: async () => 0,
      }),
    ).rejects.toThrowError("PLATFORM_POST_MIGRATION_AUTHORITY_INVALID");
  });
});

describe("independent deployable roles", () => {
  it("serializes API start/drain and returns to stopped", async () => {
    const calls: string[] = [];
    const process = createPlatformApiProcess({ database: fakeDatabase(calls) });
    const address = await process.start({ host: "127.0.0.1", port: 0 });
    expect(process.status()).toEqual({
      state: "running",
      live: true,
      ready: true,
      draining: false,
    });
    expect(await fetch(`${address}/health/ready`).then((response) => response.status)).toBe(200);
    await process.shutdown();
    expect(process.status()).toEqual({
      state: "stopped",
      live: false,
      ready: false,
      draining: false,
    });
    expect(calls).toEqual(["connect", "health", "health", "disconnect"]);
  });

  it("lets API readiness recover after a transient database failure", async () => {
    let databaseAvailable = true;
    const database: PlatformDatabaseClient = {
      connect: async () => undefined,
      disconnect: async () => undefined,
      checkHealth: async () => {
        if (!databaseAvailable) throw new Error("database down");
      },
    };
    const process = createPlatformApiProcess({ database });
    const address = await process.start({ host: "127.0.0.1", port: 0 });
    databaseAvailable = false;
    expect(await fetch(`${address}/health/ready`).then((response) => response.status)).toBe(503);
    expect(process.status().ready).toBe(false);
    databaseAvailable = true;
    expect(await fetch(`${address}/health/ready`).then((response) => response.status)).toBe(200);
    expect(process.status().ready).toBe(true);
    await process.shutdown();
  });

  it("stops claims, aborts an in-flight cycle, and drains Worker", async () => {
    const calls: string[] = [];
    const worker = createPlatformWorkerProcess({
      database: fakeDatabase(calls),
      pollIntervalMs: 60_000,
      stopClaiming: async () => {
        calls.push("stop-claim");
      },
      returnLease: async (reason) => {
        calls.push(`return:${reason}`);
      },
      runOneCycle: ({ signal }) =>
        new Promise<void>((resolveCycle) => {
          calls.push("cycle");
          signal.addEventListener("abort", () => resolveCycle(), { once: true });
        }),
    });
    await worker.start();
    await worker.shutdown({ deadlineMs: 500 });
    expect(worker.status()).toEqual({
      state: "stopped",
      live: false,
      ready: false,
      draining: false,
    });
    expect(calls).toEqual([
      "connect",
      "health",
      "cycle",
      "stop-claim",
      "return:shutdown",
      "disconnect",
    ]);
  });

  it("returns a lease instead of waiting forever past the Worker deadline", async () => {
    const calls: string[] = [];
    const worker = createPlatformWorkerProcess({
      database: fakeDatabase(calls),
      runOneCycle: async () => new Promise<void>(() => undefined),
      returnLease: async (reason) => {
        calls.push(`return:${reason}`);
      },
    });
    await worker.start();
    await expect(worker.shutdown({ deadlineMs: 10 })).rejects.toThrowError(
      "PLATFORM_WORKER_SHUTDOWN_UNCONFIRMED",
    );
    expect(calls).toContain("return:shutdown-deadline");
    expect(worker.status().state).toBe("failed");
    await expect(worker.start()).rejects.toThrowError(
      "PLATFORM_WORKER_RESTART_REQUIRES_PROCESS_REPLACEMENT",
    );
  });

  it("fails API shutdown when the single drain deadline cannot stop startup", async () => {
    const database: PlatformDatabaseClient = {
      connect: async () => new Promise<void>(() => undefined),
      disconnect: async () => undefined,
      checkHealth: async () => undefined,
    };
    const process = createPlatformApiProcess({ database });
    void process.start({ host: "127.0.0.1", port: 0 }).catch(() => undefined);

    await expect(process.shutdown({ deadlineMs: 10 })).rejects.toThrowError(
      "PLATFORM_API_SHUTDOWN_UNCONFIRMED",
    );
    expect(process.status()).toEqual({
      state: "failed",
      live: false,
      ready: false,
      draining: false,
    });
  }, 100);

  it("publishes executable image selectors and distinct database roles", async () => {
    const manifest = await readFile(resolve("deployables.yaml"), "utf8");
    const entrypoint = await readFile(resolve("deploy/docker/runtime-entrypoint.mjs"), "utf8");
    for (const role of ["platform-api", "platform-authorization", "platform-worker", "platform-admin", "platform-migrator"]) {
      expect(manifest).toContain(`KOKORO_SERVICE_PACKAGE=${role}`);
      expect(entrypoint).toContain(`"${role}"`);
    }
    expect(manifest).toContain("credentialClass: platform-api");
    expect(manifest).toContain("credentialClass: platform-worker");
    expect(manifest).toContain("credentialClass: platform-authorization");
    expect(manifest).toContain("expectedUserEnvironmentVariable: PLATFORM_DATABASE_AUTHORIZATION_ROLE");
    expect(manifest).toContain("credentialClass: platform-admin");
    expect(manifest).toContain("credentialClass: platform-migrator");
  });
});

function safeRole(roleName: string): Record<string, unknown> {
  return {
    roleName,
    isSuperuser: false,
    canCreateDatabase: false,
    canCreateRole: false,
    canReplicate: false,
    canBypassRls: false,
    inheritsPrivileges: false,
    hasAnyMembership: false,
    isMigratorMember: false,
    isPeerMember: false,
  };
}

function authority(roleName: string): Record<string, unknown> {
  return {
    roleName,
    schemaOwner: "platform_migrator",
    foundationOwner: "platform_migrator",
    publicCanUseSchema: false,
    publicCanCreateSchema: false,
    canUseSchema: true,
    canCreateSchema: false,
    canReadFoundation: true,
    canMutateFoundation: false,
    ownsPlatformRelation: false,
    ownsPlatformFunction: false,
    hasRequiredPlatformWrites: true,
    canExecuteModelInventoryImport: roleName === "platform_admin",
    canExecuteModelInventoryActivate: roleName === "platform_admin",
    canExecuteModelSitePolicyChange: roleName === "platform_admin",
    canExecuteModelCandidatesProjection: roleName === "platform_api",
    canExecuteModelDecisionProjection: roleName === "platform_api",
    canExecuteModelAvailabilityReport: roleName === "platform_worker",
    hasRequiredModelOptionFunctions: true,
    canSelectModelCatalogTable: false,
    canReadModelSensitiveColumn: false,
    hasUnexpectedPlatformPrivilege: false,
  };
}

function safeMigratorAuthority(): Record<string, unknown> {
  return {
    serverMajor: 18,
    currentUser: "platform_migrator",
    currentDatabase: "kokoro_platform",
    databaseOwner: "platform_migrator",
    isSuperuser: false,
    canCreateDatabase: false,
    canCreateRole: false,
    canReplicate: false,
    canBypassRls: false,
    inheritsPrivileges: false,
    hasAnyMembership: false,
    isApiMember: false,
    isAuthorizationMember: false,
    isWorkerMember: false,
    isAdminMember: false,
    canCreateDatabaseObject: true,
    schemaExists: false,
    schemaOwner: null,
    publicCanUseSchema: false,
    publicCanCreateSchema: false,
  };
}

function migratorEnvironment(): Record<string, string> {
  return {
    ...commonEnvironment,
    DATABASE_URL_PLATFORM: migratorUrl,
    PLATFORM_DATABASE_CREDENTIAL_CLASS: "migrator",
    PLATFORM_DATABASE_API_ROLE: "platform_api",
    PLATFORM_DATABASE_WORKER_ROLE: "platform_worker",
    PLATFORM_DATABASE_ADMIN_ROLE: "platform_admin",
  };
}

function fakeDatabase(calls: string[]): PlatformDatabaseClient {
  return {
    async connect() {
      calls.push("connect");
    },
    async disconnect() {
      calls.push("disconnect");
    },
    async checkHealth() {
      calls.push("health");
    },
  };
}
