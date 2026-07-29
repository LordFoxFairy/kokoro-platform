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
        readyEvent: { eventId: "0198577b-4a7c-7abc-8abc-0123456789ab", owner: "asset",
          eventType: "asset.version.ready", aggregateId: "asset_version_01",
          payload: { kind: "asset_version_ready_v1" }, payloadDigest: "e".repeat(64),
          correlationId: "correlation_01", causationId: "promotion_event_01" },
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
        "SET state='promoted'",
        "SET state='completed'",
        "INSERT INTO platform.outbox_event",
      ];
      for (const fragment of required) {
        expect(statements.some((value) => value.includes(fragment)), fragment).toBe(true);
      }
      expect(statements.at(-1)).toContain("asset_promotion_intent");
      expect(statements.at(-1)).toContain("state='completed'");
    } finally {
      revokePlatformTransaction(lease);
    }
  });
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
