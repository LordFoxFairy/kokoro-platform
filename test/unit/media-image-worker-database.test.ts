import { describe, expect, it } from "vitest";
import {
  PostgresMediaImageWorkerDatabase,
  loadMediaImageWorkerDatabaseConfig,
} from "../../src/modules/media/infrastructure/postgres/media-image-worker-database.js";

class FakePool {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  rows: readonly Record<string, unknown>[] = [];
  query(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values }); return Promise.resolve({ rows: this.rows, rowCount: this.rows.length });
  }
  end() { return Promise.resolve(); }
}

describe("Postgres Media image worker database", () => {
  it("refuses startup unless the function-only role can load the exact typed usage fact", async () => {
    const pool = new FakePool();
    const database = new PostgresMediaImageWorkerDatabase({ pool, expectedDatabaseUser: "platform_media_worker",
      expectedDatabaseName: "kokoro", migratorDatabaseUser: "platform_migrator", maxAttempts: 10 });
    const identity = { currentUser: "platform_media_worker", currentDatabase: "kokoro",
      databaseOwner: "platform_migrator", isSuperuser: false, canCreateDatabase: false, canCreateRole: false,
      canReplicate: false, canBypassRls: false, hasAnyMembership: false, isMigratorMember: false,
      hasAnyMediaTableAccess: false, canExecuteClaim: true, canExecuteSaga: true, canExecuteEvidence: true };

    pool.rows = [identity];
    await expect(database.connect()).rejects.toThrow("MEDIA_WORKER_DATABASE_ROLE_INVALID");

    pool.rows = [{ ...identity, canExecuteTypedUsage: true }];
    await expect(database.connect()).resolves.toBeUndefined();
    expect(pool.calls[0]?.sql).toContain("platform.load_media_image_effect_usage_fact");
    expect(pool.calls.at(-1)?.sql).toContain("platform.assert_media_runtime_role('worker')");
  });

  it("uses only function calls with the exact lease fence", async () => {
    const pool = new FakePool();
    const database = new PostgresMediaImageWorkerDatabase({ pool, expectedDatabaseUser: "platform_media_worker",
      expectedDatabaseName: "kokoro", migratorDatabaseUser: "platform_migrator", maxAttempts: 10 });
    pool.rows = [{ lateCancellationObserved: false }];

    await database.recordEffectView({ taskRef: "task:one", operationRef: "operation:one", leaseEpoch: 3n,
      leaseTokenHash: "a".repeat(64), requestDigest: "b".repeat(64), ownerResult: { receipt: {} },
      gatewayCommandReceiptRef: `image-effect-receipt:sha256:${"c".repeat(64)}`,
      gatewayCommandReceiptDigest: "c".repeat(64),
      recordedAt: "2026-07-31T00:00:00.000Z" });

    expect(pool.calls[0]?.sql).toContain("platform.record_media_image_gateway_view");
    expect(pool.calls[0]?.values.slice(0, 4)).toEqual(["task:one", "operation:one", "3", "a".repeat(64)]);
    expect(pool.calls[0]?.sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/iu);
  });

  it("passes the configured attempt limit only to the durable retry routine", async () => {
    const pool = new FakePool();
    const database = new PostgresMediaImageWorkerDatabase({ pool, expectedDatabaseUser: "platform_media_worker",
      expectedDatabaseName: "kokoro", migratorDatabaseUser: "platform_migrator", maxAttempts: 7 });
    pool.rows = [{ resolution: "retry" }];
    const resolution = await database.retryOrDeadLetter({ taskRef: "task:one", operationRef: "operation:one",
      leaseEpoch: 3n, leaseTokenHash: "a".repeat(64), errorCode: "MODEL_GATEWAY_UNAVAILABLE",
      retryAt: "2026-07-31T00:00:01.000Z", failedAt: "2026-07-31T00:00:00.000Z" });
    expect(resolution).toBe("retry");
    expect(pool.calls[0]?.values.at(-1)).toBe(7);
  });

  it("loads a dedicated least-privilege credential configuration", () => {
    const config = loadMediaImageWorkerDatabaseConfig({
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "media-worker",
      DATABASE_URL_PLATFORM: "postgresql://platform_media_worker:secret@db.example/kokoro",
      PLATFORM_DATABASE_MEDIA_WORKER_ROLE: "platform_media_worker",
      PLATFORM_DATABASE_EXPECTED_DATABASE: "kokoro",
      PLATFORM_DATABASE_MIGRATOR_ROLE: "platform_migrator",
      PLATFORM_MEDIA_WORKER_MAX_ATTEMPTS: "9",
    });
    expect(config).toMatchObject({ expectedDatabaseUser: "platform_media_worker",
      applicationName: "kokoro-platform-media-worker", maxAttempts: 9 });
  });
});
