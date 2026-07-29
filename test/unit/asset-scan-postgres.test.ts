import { describe, expect, it } from "vitest";
import { issuePlatformTransaction, revokePlatformTransaction, type PlatformSqlTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import { PostgresAssetScanRepository } from
  "../../src/modules/asset/infrastructure/postgres/asset-scan-repository.js";
import type { PersistedAssetScanDecision } from
  "../../src/modules/asset/application/contracts/asset-scan-worker-ports.js";

describe("PostgresAssetScanRepository", () => {
  it("claims only the scan event bound to the candidate and advances the fencing version", async () => {
    const statements: string[] = [];
    const sql: PlatformSqlTransaction = {
      query: async <Row extends Record<string, unknown>>(statement: string): Promise<readonly Row[]> => {
        statements.push(statement);
        if (statement.includes("FROM platform.asset_blob_candidate")) return rows<Row>(candidateRow());
        if (statement.includes("UPDATE platform.asset_blob_candidate")) {
          return rows<Row>(candidateRow({ state: "scanning", expectedVersion: 2n }));
        }
        throw new Error(`unexpected query: ${statement}`);
      },
      execute: async () => 1,
    };
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresAssetScanRepository().claimScanWork(lease.transaction, {
        eventId: "scan_event_01", siteRef: "site_01", candidateRef: "blob_candidate_01",
        expectedVersion: 1n,
      })).resolves.toMatchObject({ disposition: "work", candidate: {
        state: "scanning", expectedVersion: 2n,
      } });
      expect(statements.some((value) => value.includes("scan_event_id=$3::uuid"))).toBe(true);
      expect(statements.some((value) => value.includes("expected_version=expected_version+1"))).toBe(true);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("persists clean evidence, promotion intent and promotion outbox after one candidate CAS", async () => {
    const statements: string[] = [];
    const sql: PlatformSqlTransaction = {
      query: async () => [],
      execute: async (statement) => { statements.push(statement); return 1; },
    };
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresAssetScanRepository().recordDecision(lease.transaction, {
        expectedCandidateVersion: 2n,
        decision: cleanDecision,
      })).resolves.toBe("committed");
      const candidateCas = statements.findIndex((value) => value.includes("SET state='promotion_ready'"));
      const evaluationInsert = statements.findIndex((value) => value.includes("INSERT INTO platform.asset_scan_evaluation"));
      const outboxInsert = statements.findIndex((value) => value.includes("INSERT INTO platform.outbox_event"));
      const promotionInsert = statements.findIndex((value) => value.includes("INSERT INTO platform.asset_promotion_intent"));
      expect(candidateCas).toBeGreaterThanOrEqual(0);
      expect(evaluationInsert).toBeGreaterThan(candidateCas);
      expect(outboxInsert).toBeGreaterThan(evaluationInsert);
      expect(promotionInsert).toBeGreaterThan(outboxInsert);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("keeps unavailable evidence quarantined without creating a promotion", async () => {
    const statements: string[] = [];
    const sql: PlatformSqlTransaction = {
      query: async () => [],
      execute: async (statement) => { statements.push(statement); return 1; },
    };
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresAssetScanRepository().recordDecision(lease.transaction, {
        expectedCandidateVersion: 2n,
        decision: unavailableDecision,
      })).resolves.toBe("committed");
      expect(statements.some((value) => value.includes("SET state='scan_unavailable'"))).toBe(true);
      expect(statements.some((value) => value.includes("asset_scan_evaluation"))).toBe(true);
      expect(statements.some((value) => value.includes("asset_promotion_intent"))).toBe(false);
      expect(statements.some((value) => value.includes("asset_quota_account"))).toBe(false);
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});

const evaluation = Object.freeze({
  evaluationRef: "scan_evaluation_01", siteRef: "site_01", candidateRef: "blob_candidate_01",
  candidateVersion: 2n, policyRevisionRef: "asset_policy_01",
  scannerDefinitionRef: "scanner_clamav", scannerRevisionRef: "scanner_revision_01",
  signatureRevisionRef: "signature_revision_01", detectedMediaType: "image/png",
  magicSignatureRef: "png_signature_v1", containerSummaryDigest: "c".repeat(64),
  malwareDisposition: "clean" as const, contentSafetyDisposition: "allow" as const,
  evidenceRef: "scan_evidence_01", evidenceDigest: "d".repeat(64), outcome: "clean" as const,
  reasonCode: "ASSET_SCAN_CLEAN", occurredAt: "2026-07-28T12:02:00.000Z",
});
const promotion = Object.freeze({
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
  state: "pending_copy" as const, expectedVersion: 1n,
  createdAt: "2026-07-28T12:02:01.000Z",
});
const promotionEvent = Object.freeze({
  eventId: "0198577b-4a7c-7abc-8abc-0123456789ab", owner: "asset",
  eventType: "asset.blob.promotion.requested", aggregateId: "promotion_01",
  payload: { kind: "asset_blob_promotion_requested_v1" }, payloadDigest: "e".repeat(64),
  correlationId: "correlation_01", causationId: "scan_event_01",
});
const cleanDecision: PersistedAssetScanDecision = Object.freeze({
  disposition: "clean", evaluation, promotion, promotionEvent,
});
const unavailableDecision: PersistedAssetScanDecision = Object.freeze({
  disposition: "unavailable", code: "ASSET_MALWARE_SCAN_UNAVAILABLE",
  evaluation: Object.freeze({ ...evaluation, evaluationRef: "scan_evaluation_02",
    malwareDisposition: "unavailable", outcome: "unavailable",
    reasonCode: "ASSET_MALWARE_SCAN_UNAVAILABLE" }),
});

function candidateRow(overrides: Record<string, unknown> = {}) {
  return {
    candidateRef: "blob_candidate_01", siteRef: "site_01", subjectRef: "subject_01",
    subjectGeneration: 4n, projectRef: "project_01", purpose: "chat.attachment",
    intentRef: "upload_intent_01", sessionRef: "upload_session_01",
    storageTenantRef: "storage_tenant_01", storageRegion: "us-east-1",
    quarantineObjectRef: "quarantine/opaque_0123456789", providerVersionRef: "provider_version_01",
    providerEtagDigest: "b".repeat(64), observedSize: 1234n, checksumSha256: "a".repeat(64),
    clientMediaType: "image/png", policyRevisionRef: "asset_policy_01",
    state: "checksum_verified", expectedVersion: 1n,
    completionRequestedAt: "2026-07-28T12:01:00.000Z",
    observedAt: "2026-07-28T12:01:05.000Z", scanEventId: "scan_event_01",
    ...overrides,
  };
}

function rows<Row extends Record<string, unknown>>(...values: Record<string, unknown>[]): readonly Row[] {
  return values as readonly Row[];
}
