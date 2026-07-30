import { describe, expect, it } from "vitest";
import { issuePlatformTransaction, revokePlatformTransaction, type PlatformSqlTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import { PostgresAssetPromotionRepository } from
  "../../src/modules/asset/infrastructure/postgres/asset-promotion-repository.js";
import type { AssetPromotionIntent } from "../../src/modules/asset/domain/promotion-intent.js";

const promotion: AssetPromotionIntent = Object.freeze({
  promotionRef: "promotion_01", siteRef: "site_01", subjectRef: "subject_01",
  subjectGeneration: 4n, projectRef: "project_01", purpose: "chat.attachment",
  intentRef: "upload_intent_01", sessionRef: "upload_session_01",
  candidateRef: "blob_candidate_01", evaluationRef: "scan_evaluation_01",
  policyRevisionRef: "asset_policy_01", assetRef: "asset_01",
  assetVersionRef: "asset_version_01", blobRef: "blob_01",
  storageTenantRef: "storage_tenant_01", storageRegion: "us-east-1",
  quarantineObjectRef: "quarantine/opaque_0123456789",
  quarantineProviderVersionRef: "provider_version_01", trustedObjectRef: "trusted/blob_01",
  checksumSha256: "a".repeat(64), size: 1234n, detectedMediaType: "image/png",
  state: "pending_copy", expectedVersion: 1n, createdAt: "2026-07-28T12:02:01.000Z",
});

describe("PostgresAssetPromotionRepository", () => {
  it("claims only the event-bound promotion identity", async () => {
    const sql: PlatformSqlTransaction = {
      query: async <Row extends Record<string, unknown>>(statement: string): Promise<readonly Row[]> => {
        if (statement.includes("FROM platform.asset_promotion_intent")) return rows<Row>(promotionRow());
        throw new Error(`unexpected query: ${statement}`);
      },
      execute: async () => 1,
    };
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresAssetPromotionRepository().claimPromotionWork(lease.transaction, {
        eventId: "promotion_event_01", siteRef: "site_01", promotionRef: "promotion_01",
        expectedVersion: 1n,
      })).resolves.toMatchObject({ disposition: "work", promotion: {
        promotionRef: "promotion_01", state: "pending_copy",
      } });
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("atomically closes blob observation, AssetVersion readiness, quota and upload lifecycle", async () => {
    const statements: string[] = [];
    const sql: PlatformSqlTransaction = {
      query: async <Row extends Record<string, unknown>>(statement: string): Promise<readonly Row[]> =>
        statement.includes("SELECT TRUE AS allowed") ? rows<Row>({ allowed: true }) : [],
      execute: async (statement) => { statements.push(statement); return 1; },
    };
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresAssetPromotionRepository().finalizePromotion(lease.transaction, {
        promotion,
        expectedPromotionVersion: 1n,
        observation: { disposition: "present", providerVersionRef: "trusted_version_01",
          providerEtagDigest: "b".repeat(64), size: 1234n, checksumSha256: "a".repeat(64),
          observedAt: "2026-07-28T12:02:05.000Z" },
        receiptRef: "promotion_receipt_01", referenceRef: "asset_reference_01",
        eligibilityRef: "asset_eligibility_01",
        cleanupPlan: promotionCleanupPlan,
        completedAt: "2026-07-28T12:02:06.000Z",
      })).resolves.toBe("committed");
      const required = [
        "SET state='ready_to_finalize'",
        "INSERT INTO platform.asset_blob",
        "INSERT INTO platform.asset_resource",
        "INSERT INTO platform.asset_version",
        "INSERT INTO platform.asset_reference",
        "INSERT INTO platform.asset_eligibility_projection",
        "INSERT INTO platform.asset_promotion_receipt",
        "ready_asset_bytes=ready_asset_bytes+$4",
        "SET state='trash_retained'",
        "INSERT INTO platform.asset_cleanup_group",
        "INSERT INTO platform.asset_object_cleanup",
        "SET state='completed'",
        "INSERT INTO platform.outbox_event",
      ];
      for (const fragment of required) {
        expect(statements.some((value) => value.includes(fragment)), fragment).toBe(true);
      }
      expect(statements.filter((value) => value.includes("INSERT INTO platform.outbox_event")))
        .toHaveLength(1);
      expect(statements.at(-1)).toContain("asset_promotion_intent");
      expect(statements.at(-1)).toContain("state='completed'");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("terminalizes a mismatched copy and retains both exact versions until cleanup receipts", async () => {
    const statements: string[] = [];
    const sql: PlatformSqlTransaction = {
      query: async <Row extends Record<string, unknown>>(statement: string): Promise<readonly Row[]> => {
        statements.push(statement);
        if (statement.includes("FROM platform.asset_promotion_intent")) return rows<Row>({
          subjectRef: "subject_01", purpose: "chat.attachment",
          intentRef: "upload_intent_01", sessionRef: "upload_session_01",
          quarantineBytes: 1234n, storageTenantRef: "storage_tenant_01",
          storageRegion: "us-east-1", quarantineObjectRef: "quarantine/opaque_0123456789",
          quarantineProviderVersionRef: "provider_version_01", trustedObjectRef: "trusted/blob_01",
          state: "pending_copy", expectedVersion: 1n,
        });
        throw new Error(`unexpected query: ${statement}`);
      },
      execute: async (statement) => { statements.push(statement); return 1; },
    };
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresAssetPromotionRepository().rejectPromotion(lease.transaction, {
        promotionRef: "promotion_01", siteRef: "site_01", expectedVersion: 1n,
        reasonCode: "ASSET_TRUSTED_OBJECT_SIZE_MISMATCH", rejectionRef: "rejection_01",
        cleanupPlan: rejectionCleanupPlan,
      })).resolves.toBe("committed");
      expect(statements.some((value) => value.includes("candidate.state='promotion_ready'"))).toBe(true);
      expect(statements.some((value) => value.includes("quarantine_bytes=quarantine_bytes-$4")))
        .toBe(true);
      expect(statements.some((value) => value.includes("trash_retained_bytes=trash_retained_bytes+$5")))
        .toBe(true);
      expect(statements.filter((value) => value.includes("INSERT INTO platform.asset_object_cleanup")))
        .toHaveLength(2);
      expect(statements.some((value) => value.includes("INSERT INTO platform.asset_upload_rejection")))
        .toBe(true);
      const cleanupGroupInsert = statements.findIndex((value) =>
        value.includes("INSERT INTO platform.asset_cleanup_group"));
      const promotionRejection = statements.findIndex((value) =>
        value.includes("UPDATE platform.asset_promotion_intent") && value.includes("state='rejected'"));
      expect(cleanupGroupInsert).toBeGreaterThan(-1);
      expect(promotionRejection).toBeGreaterThan(cleanupGroupInsert);
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});

const promotionCleanupPlan = Object.freeze({
  cleanupGroupRef: "cleanup_group_01",
  terminalReservationState: "promoted" as const,
  targets: Object.freeze([Object.freeze({
    cleanupRef: "cleanup_quarantine_01",
    objectRole: "quarantine" as const,
    storageTenantRef: "storage_tenant_01",
    storageRegion: "us-east-1",
    objectRef: "quarantine/opaque_0123456789",
    providerVersionRef: "provider_version_01",
    retainedBytes: 1234n,
    cleanupEvent: Object.freeze({
      eventId: "0198577b-4a7c-7abc-8abc-0123456789ac",
      owner: "asset",
      eventType: "asset.object.cleanup.requested",
      aggregateId: "cleanup_quarantine_01",
      payload: { kind: "asset_object_cleanup_requested_v1" },
      payloadDigest: "f".repeat(64),
      correlationId: "correlation_01",
      causationId: "promotion_event_01",
    }),
  })]),
});

const rejectionCleanupPlan = Object.freeze({
  cleanupGroupRef: "cleanup_group_rejected_01",
  terminalReservationState: "released" as const,
  targets: Object.freeze([
    Object.freeze({
      cleanupRef: "cleanup_trusted_01", objectRole: "trusted_copy" as const,
      storageTenantRef: "storage_tenant_01", storageRegion: "us-east-1",
      objectRef: "trusted/blob_01", providerVersionRef: "trusted_version_bad_01",
      retainedBytes: 1235n,
      cleanupEvent: Object.freeze({ eventId: "0198577b-4a7c-7abc-8abc-0123456789ad",
        owner: "asset", eventType: "asset.object.cleanup.requested",
        aggregateId: "cleanup_trusted_01", payload: { kind: "asset_object_cleanup_requested_v1" },
        payloadDigest: "1".repeat(64), correlationId: "correlation_01",
        causationId: "promotion_event_01" }),
    }),
    Object.freeze({
      cleanupRef: "cleanup_quarantine_01", objectRole: "quarantine" as const,
      storageTenantRef: "storage_tenant_01", storageRegion: "us-east-1",
      objectRef: "quarantine/opaque_0123456789", providerVersionRef: "provider_version_01",
      retainedBytes: 1234n,
      cleanupEvent: Object.freeze({ eventId: "0198577b-4a7c-7abc-8abc-0123456789ae",
        owner: "asset", eventType: "asset.object.cleanup.requested",
        aggregateId: "cleanup_quarantine_01", payload: { kind: "asset_object_cleanup_requested_v1" },
        payloadDigest: "2".repeat(64), correlationId: "correlation_01",
        causationId: "promotion_event_01" }),
    }),
  ]),
});

function promotionRow(overrides: Record<string, unknown> = {}) {
  return {
    ...promotion,
    promotionEventId: "promotion_event_01",
    copiedProviderVersionRef: null,
    copiedProviderEtagDigest: null,
    copiedAt: null,
    ...overrides,
  };
}

function rows<Row extends Record<string, unknown>>(...values: Record<string, unknown>[]): readonly Row[] {
  return values as readonly Row[];
}
