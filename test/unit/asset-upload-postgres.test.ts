import { describe, expect, it } from "vitest";
import { issuePlatformTransaction, revokePlatformTransaction, type PlatformSqlTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";
import { PostgresAssetUploadRepository } from "../../src/modules/asset/infrastructure/postgres/asset-upload-repository.js";
import { createUploadIntent, createUploadSession } from "../../src/modules/asset/domain/upload-intent.js";

const intent = createUploadIntent({
  intentRef: "upload_intent_01", siteRef: "site_01", workloadIdentityId: "workload_01",
  siteReleaseRef: "release_01", bindingEpoch: 7n, subjectRef: "subject_01", subjectGeneration: 4n,
  projectRef: "project_01", purpose: "chat.attachment", filename: "photo.png",
  clientMediaType: "image/png", expectedSize: 1234n, expectedChecksumSha256: "a".repeat(64),
  policy: { policyRevisionRef: "asset_policy_01", purpose: "chat.attachment", storageRegion: "us-east-1",
    maximumFileBytes: 10_000_000n, maximumInflightBytes: 100_000_000n,
    allowedClientMediaTypes: ["image/png"], expiresAt: "2026-07-29T12:00:00.000Z" },
  now: "2026-07-28T12:00:00.000Z",
});
const session = createUploadSession({
  sessionRef: "upload_session_01", intent, quotaRevisionRef: "quota_revision_01",
  storageTenantRef: "storage_tenant_01", storageRegion: "us-east-1",
  quarantineObjectRef: "quarantine/opaque_0123456789", capabilityAudience: "https://upload.example.test",
  minimumPartBytes: 100n, maximumPartBytes: 10_000_000n, capabilityLifetimeSeconds: 300,
});
const requestDigest = "b".repeat(64);

describe("PostgresAssetUploadRepository", () => {
  it("locks current Site/project authority, reserves aggregate quota once, then persists the session", async () => {
    const statements: string[] = [];
    const sql: PlatformSqlTransaction = {
      query: async <Row extends Record<string, unknown>>(statement: string): Promise<readonly Row[]> => {
        statements.push(statement);
        if (statement.includes("SELECT TRUE AS allowed")) return result<Row>({ allowed: true });
        if (statement.includes("INSERT INTO platform.asset_upload_intent")) return result<Row>({ intentRef: intent.intentRef });
        if (statement.includes("FROM platform.asset_quota_account")) return result<Row>({
          quotaRevisionRef: "quota_revision_01", maximumInflightBytes: 100_000_000n,
          reservedInflightBytes: 0n,
        });
        throw new Error(`unexpected query: ${statement}`);
      },
      execute: async (statement) => { statements.push(statement); return 1; },
    };
    const lease = issuePlatformTransaction(sql);
    try {
      const result = await new PostgresAssetUploadRepository().claimUploadIntent(lease.transaction, {
        intent, session, idempotencyKey: "upload-command-01", requestDigest,
        maximumInflightBytes: 100_000_000n,
      });
      expect(result).toMatchObject({ disposition: "created", intent: { intentRef: "upload_intent_01" },
        session: { sessionRef: "upload_session_01" } });
      expect(statements.findIndex((value) => value.includes("SELECT TRUE AS allowed")))
        .toBeLessThan(statements.findIndex((value) => value.includes("INSERT INTO platform.asset_upload_intent")));
      expect(statements.filter((value) => value.includes("reserved_inflight_bytes=reserved_inflight_bytes"))).toHaveLength(1);
      expect(statements.some((value) => value.includes("INSERT INTO platform.asset_quota_reservation"))).toBe(true);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("does not reserve quota again when an exact command replays", async () => {
    const executed: string[] = [];
    const sql: PlatformSqlTransaction = {
      query: async <Row extends Record<string, unknown>>(statement: string): Promise<readonly Row[]> => {
        if (statement.includes("SELECT TRUE AS allowed")) return result<Row>({ allowed: true });
        if (statement.includes("INSERT INTO platform.asset_upload_intent")) return [];
        if (statement.includes("FROM platform.asset_upload_intent intent")) return result<Row>(databaseRow(requestDigest));
        throw new Error(`unexpected query: ${statement}`);
      },
      execute: async (statement) => { executed.push(statement); return 1; },
    };
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresAssetUploadRepository().claimUploadIntent(lease.transaction, {
        intent, session, idempotencyKey: "upload-command-01", requestDigest,
        maximumInflightBytes: 100_000_000n,
      })).resolves.toMatchObject({ disposition: "replay" });
      expect(executed).toHaveLength(0);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("activates only the next capability epoch after re-locking current authority", async () => {
    const statements: string[] = [];
    const sql: PlatformSqlTransaction = {
      query: async <Row extends Record<string, unknown>>(statement: string): Promise<readonly Row[]> => {
        statements.push(statement);
        if (statement.includes("FROM platform.asset_upload_intent intent")) return result<Row>(databaseRow(requestDigest));
        if (statement.includes("SELECT TRUE AS allowed")) return result<Row>({ allowed: true });
        if (statement.includes("UPDATE platform.asset_upload_session AS session")) return result<Row>(databaseSessionRow({
          capabilityEpoch: 1n, capabilityExpiresAt: "2026-07-28T12:05:00.000Z",
          sessionState: "uploading", sessionExpectedVersion: 2n,
        }));
        throw new Error(`unexpected query: ${statement}`);
      },
      execute: async () => 1,
    };
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresAssetUploadRepository().markCapabilityIssued(lease.transaction, {
        siteRef: "site_01", intentRef: "upload_intent_01", expectedVersion: 1n,
        capabilityEpoch: 1n, expiresAt: "2026-07-28T12:05:00.000Z",
      })).resolves.toMatchObject({ state: "uploading", capabilityEpoch: 1n, expectedVersion: 2n });
      expect(statements.findIndex((value) => value.includes("SELECT TRUE AS allowed")))
        .toBeLessThan(statements.findIndex((value) => value.includes("UPDATE platform.asset_upload_session AS session")));
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});

function databaseRow(digest: string) {
  return {
    assetIntentRef: intent.intentRef, assetSiteRef: intent.siteRef,
    workloadIdentityId: intent.workloadIdentityId, siteReleaseRef: intent.siteReleaseRef,
    bindingEpoch: intent.bindingEpoch, assetSubjectRef: intent.subjectRef,
    assetSubjectGeneration: intent.subjectGeneration, assetProjectRef: intent.projectRef,
    assetPurpose: intent.purpose, safeDisplayName: intent.safeDisplayName,
    clientMediaType: intent.clientMediaType, expectedSize: intent.expectedSize,
    expectedChecksumSha256: intent.expectedChecksumSha256, policyRevisionRef: intent.policyRevisionRef,
    intentState: intent.state, intentExpectedVersion: intent.expectedVersion,
    intentExpiresAt: intent.expiresAt, requestDigest: digest, ...databaseSessionRow({}),
  };
}

function databaseSessionRow(overrides: Record<string, unknown>) {
  return {
    sessionRef: session.sessionRef, sessionIntentRef: session.intentRef, sessionSiteRef: session.siteRef,
    sessionSubjectRef: session.subjectRef, sessionSubjectGeneration: session.subjectGeneration,
    sessionProjectRef: session.projectRef, sessionPurpose: session.purpose,
    quotaRevisionRef: session.quotaRevisionRef, storageTenantRef: session.storageTenantRef,
    storageRegion: session.storageRegion, quarantineObjectRef: session.quarantineObjectRef,
    protocolRevision: session.protocolRevision, capabilityAudience: session.capabilityAudience,
    minimumPartBytes: session.minimumPartBytes, maximumPartBytes: session.maximumPartBytes,
    capabilityLifetimeSeconds: session.capabilityLifetimeSeconds, capabilityEpoch: session.capabilityEpoch,
    capabilityExpiresAt: session.capabilityExpiresAt,
    completionRequestedAt: session.completionRequestedAt, sessionState: session.state,
    sessionExpectedVersion: session.expectedVersion, sessionExpiresAt: session.expiresAt,
    ...overrides,
  };
}

function result<Row extends Record<string, unknown>>(...values: Record<string, unknown>[]): readonly Row[] {
  return values as readonly Row[];
}
