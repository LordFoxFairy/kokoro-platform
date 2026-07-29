import { describe, expect, it } from "vitest";
import { PostgresAssetObjectCleanupRepository } from
  "../../src/modules/asset/infrastructure/postgres/asset-cleanup-repository.js";
import { issuePlatformTransaction, revokePlatformTransaction, type PlatformSqlTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";

describe("PostgresAssetObjectCleanupRepository", () => {
  it("reclaims retryable work from its durable current version instead of trusting stale event version", async () => {
    const statements: string[] = [];
    const sql: PlatformSqlTransaction = {
      query: async <Row extends Record<string, unknown>>(statement: string): Promise<readonly Row[]> => {
        statements.push(statement);
        if (statement.startsWith("SELECT")) return rows<Row>(cleanupRow({
          state: "delete_unavailable", expectedVersion: 4n,
        }));
        if (statement.startsWith("UPDATE")) return rows<Row>(cleanupRow({
          state: "deleting", expectedVersion: 5n,
        }));
        throw new Error(`unexpected query: ${statement}`);
      },
      execute: async () => 1,
    };
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresAssetObjectCleanupRepository().claimCleanupWork(lease.transaction, {
        eventId: "cleanup_event_01", siteRef: "site_01", cleanupRef: "cleanup_quarantine_01",
        expectedVersion: 1n,
      })).resolves.toMatchObject({ disposition: "work", cleanup: {
        state: "deleting", expectedVersion: 5n,
      } });
      expect(statements.at(-1)).toContain("expected_version=$3::bigint");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("releases exactly one object's trash bytes and closes the reservation only for the final receipt", async () => {
    const statements: string[] = [];
    const sql: PlatformSqlTransaction = {
      query: async <Row extends Record<string, unknown>>(statement: string): Promise<readonly Row[]> => {
        statements.push(statement);
        if (statement.includes("FROM platform.asset_cleanup_group")) return rows<Row>({
          subjectRef: "subject_01", purpose: "chat.attachment",
          terminalReservationState: "released", state: "cleaning",
        });
        if (statement.includes("UPDATE platform.asset_cleanup_group")) return rows<Row>({
          state: "completed",
        });
        throw new Error(`unexpected query: ${statement}`);
      },
      execute: async (statement) => { statements.push(statement); return 1; },
    };
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresAssetObjectCleanupRepository().completeCleanup(lease.transaction, {
        cleanup: cleanupRow(),
        expectedCleanupVersion: 2n,
        receiptRef: "cleanup_receipt_01",
        deletion: { disposition: "confirmed_absent", providerDisposition: "deleted",
          observedAt: "2026-07-28T12:03:00.000Z" },
      })).resolves.toBe("committed");
      expect(statements.some((value) => value.includes("INSERT INTO platform.asset_object_cleanup_receipt")))
        .toBe(true);
      expect(statements.some((value) => value.includes(
        "trash_retained_bytes=trash_retained_bytes-$4::bigint",
      ))).toBe(true);
      expect(statements.some((value) => value.includes("state=$4"))).toBe(true);
      expect(statements.some((value) => value.includes("state='released'"))).toBe(false);
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});

function cleanupRow(overrides: Record<string, unknown> = {}) {
  return {
    cleanupRef: "cleanup_quarantine_01", cleanupGroupRef: "cleanup_group_01",
    siteRef: "site_01", intentRef: "upload_intent_01", sessionRef: "upload_session_01",
    storageTenantRef: "storage_tenant_01", storageRegion: "us-east-1",
    objectRole: "quarantine" as const, objectRef: "quarantine/opaque_0123456789",
    providerVersionRef: "provider_version_01", retainedBytes: 1234n,
    state: "deleting" as const, expectedVersion: 2n,
    ...overrides,
  };
}

function rows<Row extends Record<string, unknown>>(...values: Record<string, unknown>[]): readonly Row[] {
  return values as readonly Row[];
}
