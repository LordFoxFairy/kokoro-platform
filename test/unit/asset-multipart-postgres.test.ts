import { describe, expect, it } from "vitest";
import { PostgresAssetMultipartRepository } from
  "../../src/modules/asset/infrastructure/postgres/asset-multipart-repository.js";
import type { AssetUploadCapabilityClaims } from
  "../../src/modules/asset/application/contracts/asset-upload-ports.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
  type PlatformSqlTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";

const claims: AssetUploadCapabilityClaims = Object.freeze({
  version: 1,
  audience: "asset-upload.production",
  storageTenantRef: "storage_tenant_01",
  storageRegion: "us-east-1",
  siteRef: "site_01",
  workloadIdentityId: "workload_01",
  siteReleaseRef: "release_01",
  bindingEpoch: "7",
  subjectRef: "subject_01",
  subjectGeneration: "4",
  projectRef: "project_01",
  purpose: "chat.attachment",
  intentRef: "upload_intent_01",
  sessionRef: "upload_session_01",
  quarantineObjectRef: "quarantine/opaque_0123456789",
  expectedSize: "1234",
  expectedChecksumSha256: "a".repeat(64),
  capabilityEpoch: "1",
  expiresAt: "2026-07-29T12:05:00.000Z",
  minimumPartBytes: "100",
  maximumPartBytes: "10000",
  allowedOrigins: ["https://chat.example.test"],
});

describe("PostgresAssetMultipartRepository", () => {
  it("does not transfer an active initiation effect lease to an exact concurrent retry", async () => {
    const statements: string[] = [];
    const active = uploadRow({
      providerUploadId: null,
      uploadState: "initiating",
      initiationEffectToken: "active_effect_token_01",
      initiationEffectLeaseExpiresAt: "2026-07-29T12:01:30.000Z",
    });
    const sql: PlatformSqlTransaction = {
      query: async <Row extends Record<string, unknown>>(statement: string): Promise<readonly Row[]> => {
        if (statement.includes("FROM platform.asset_upload_intent intent")) {
          return rows<Row>({ authoritySiteRef: claims.siteRef,
            authorityIntentRef: claims.intentRef, authoritySessionRef: claims.sessionRef });
        }
        if (statement.includes("FROM platform.asset_multipart_upload upload")) return rows<Row>(active);
        if (statement.includes("FROM platform.asset_multipart_part")) return [];
        throw new Error(`unexpected query: ${statement}`);
      },
      execute: async (statement) => { statements.push(statement); return 0; },
    };
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresAssetMultipartRepository().claimInitiation(lease.transaction, {
        claims,
        uploadRef: "losing_upload_ref_01",
        clientUploadId: "client_upload_0001",
        idempotencyKey: "initiation-key-0001",
        requestDigest: "b".repeat(64),
        receiptRef: "losing_receipt_ref_01",
        effectToken: "losing_effect_token_01",
        effectLeaseExpiresAt: "2026-07-29T12:01:40.000Z",
        now: "2026-07-29T12:01:00.000Z",
      })).resolves.toMatchObject({
        upload: { initiationEffectToken: "active_effect_token_01" },
      });
      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain("initiation_effect_lease_expires_at<=$7::timestamptz");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("reclaims an expired initiation lease with an expected-version fenced owner token", async () => {
    let uploadReads = 0;
    const sql: PlatformSqlTransaction = {
      query: async <Row extends Record<string, unknown>>(statement: string): Promise<readonly Row[]> => {
        if (statement.includes("FROM platform.asset_upload_intent intent")) {
          return rows<Row>({ authoritySiteRef: claims.siteRef,
            authorityIntentRef: claims.intentRef, authoritySessionRef: claims.sessionRef });
        }
        if (statement.includes("FROM platform.asset_multipart_upload upload")) {
          uploadReads += 1;
          return rows<Row>(uploadRow({
            providerUploadId: null,
            uploadState: "initiating",
            uploadExpectedVersion: uploadReads === 1 ? 1n : 2n,
            initiationEffectToken: uploadReads === 1
              ? "expired_effect_token_01"
              : "new_effect_token_01",
            initiationEffectLeaseExpiresAt: uploadReads === 1
              ? "2026-07-29T12:00:30.000Z"
              : "2026-07-29T12:01:30.000Z",
          }));
        }
        if (statement.includes("FROM platform.asset_multipart_part")) return [];
        throw new Error(`unexpected query: ${statement}`);
      },
      execute: async (statement, parameters) => {
        expect(statement).toContain("expected_version=$3::bigint");
        expect(parameters?.[4]).toBe("new_effect_token_01");
        return 1;
      },
    };
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresAssetMultipartRepository().claimInitiation(lease.transaction, {
        claims,
        uploadRef: "multipart_upload_01",
        clientUploadId: "client_upload_0001",
        idempotencyKey: "initiation-key-0001",
        requestDigest: "b".repeat(64),
        receiptRef: "initiation_receipt_01",
        effectToken: "new_effect_token_01",
        effectLeaseExpiresAt: "2026-07-29T12:01:30.000Z",
        now: "2026-07-29T12:01:00.000Z",
      })).resolves.toMatchObject({
        upload: { expectedVersion: 2n, initiationEffectToken: "new_effect_token_01" },
      });
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("does not transfer a live completion effect lease to an exact concurrent retry", async () => {
    const active = uploadRow({
      uploadState: "completing",
      uploadExpectedVersion: 2n,
      completionIdempotencyKey: "completion-key-0001",
      completionRequestDigest: "c".repeat(64),
      completionReceiptRef: "completion_receipt_01",
      completionEffectToken: "active_completion_effect_01",
      completionEffectLeaseExpiresAt: "2026-07-29T12:03:00.000Z",
    });
    const sql = multipartSql(active, 0);
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresAssetMultipartRepository().claimCompletionEffect(
        lease.transaction,
        {
          claims,
          uploadRef: "multipart_upload_01",
          expectedVersion: 2n,
          effectToken: "losing_completion_effect_01",
          effectLeaseExpiresAt: "2026-07-29T12:04:00.000Z",
          now: "2026-07-29T12:01:00.000Z",
        },
      )).resolves.toMatchObject({
        upload: { completionEffectToken: "active_completion_effect_01" },
      });
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("reclaims an expired abort effect lease with version and token fencing", async () => {
    let reads = 0;
    const before = uploadRow({
      uploadState: "outcome_unknown",
      outcomeOperation: "abort",
      uploadExpectedVersion: 3n,
      abortIdempotencyKey: "abort-idempotency-01",
      abortRequestDigest: "d".repeat(64),
      abortReceiptRef: "abort_receipt_0001",
      abortEffectToken: null,
      abortEffectLeaseExpiresAt: null,
    });
    const after = { ...before, uploadExpectedVersion: 4n,
      abortEffectToken: "new_abort_effect_01",
      abortEffectLeaseExpiresAt: "2026-07-29T12:03:00.000Z" };
    const sql: PlatformSqlTransaction = {
      query: async <Row extends Record<string, unknown>>(statement: string): Promise<readonly Row[]> => {
        if (statement.includes("FROM platform.asset_upload_intent intent")) {
          return rows<Row>({ authoritySiteRef: claims.siteRef,
            authorityIntentRef: claims.intentRef, authoritySessionRef: claims.sessionRef });
        }
        if (statement.includes("FROM platform.asset_multipart_upload upload")) {
          reads += 1;
          return rows<Row>(reads === 1 ? before : after);
        }
        if (statement.includes("FROM platform.asset_multipart_part")) return [];
        throw new Error(`unexpected query: ${statement}`);
      },
      execute: async (statement, parameters) => {
        expect(statement).toContain("abort_effect_token=$5");
        expect(parameters?.[4]).toBe("new_abort_effect_01");
        return 1;
      },
    };
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresAssetMultipartRepository().claimAbortEffect(lease.transaction, {
        claims,
        uploadRef: "multipart_upload_01",
        expectedVersion: 3n,
        effectToken: "new_abort_effect_01",
        effectLeaseExpiresAt: "2026-07-29T12:03:00.000Z",
        now: "2026-07-29T12:01:00.000Z",
      })).resolves.toMatchObject({
        upload: { expectedVersion: 4n, abortEffectToken: "new_abort_effect_01" },
      });
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("locks owner authority before locking the non-null multipart row separately", async () => {
    const statements: string[] = [];
    const sql: PlatformSqlTransaction = {
      query: async <Row extends Record<string, unknown>>(statement: string): Promise<readonly Row[]> => {
        statements.push(statement);
        if (statement.includes("FROM platform.asset_upload_intent intent")) {
          return rows<Row>({
            authoritySiteRef: claims.siteRef,
            authorityIntentRef: claims.intentRef,
            authoritySessionRef: claims.sessionRef,
          });
        }
        if (statement.includes("FROM platform.asset_multipart_upload upload")) {
          return rows<Row>(uploadRow());
        }
        if (statement.includes("FROM platform.asset_multipart_part")) return [];
        throw new Error(`unexpected query: ${statement}`);
      },
      execute: async () => 1,
    };
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresAssetMultipartRepository().readAuthorized(
        lease.transaction,
        claims,
        "multipart_upload_01",
      )).resolves.toMatchObject({ upload: { uploadRef: "multipart_upload_01" } });
      expect(statements[0]).not.toContain("LEFT JOIN platform.asset_multipart_upload");
      expect(statements[0]).toContain("FOR UPDATE OF intent,session,binding,subject,project,membership");
      expect(statements[1]).toContain("FROM platform.asset_multipart_upload upload");
      expect(statements[1]).toContain("FOR UPDATE OF upload");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("returns the winning session upload after a concurrent initiation insert", async () => {
    let uploadReads = 0;
    const sql: PlatformSqlTransaction = {
      query: async <Row extends Record<string, unknown>>(statement: string): Promise<readonly Row[]> => {
        if (statement.includes("FROM platform.asset_upload_intent intent")) {
          return rows<Row>({ authoritySiteRef: claims.siteRef,
            authorityIntentRef: claims.intentRef, authoritySessionRef: claims.sessionRef });
        }
        if (statement.includes("FROM platform.asset_multipart_upload upload")) {
          uploadReads += 1;
          return uploadReads === 1 ? [] : rows<Row>(uploadRow());
        }
        if (statement.includes("FROM platform.asset_multipart_part")) return [];
        throw new Error(`unexpected query: ${statement}`);
      },
      execute: async () => 0,
    };
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresAssetMultipartRepository().claimInitiation(lease.transaction, {
        claims,
        uploadRef: "losing_upload_ref_01",
        clientUploadId: "client_upload_0001",
        idempotencyKey: "initiation-key-0001",
        requestDigest: "b".repeat(64),
        receiptRef: "losing_receipt_ref_01",
        effectToken: "losing_effect_token_01",
        effectLeaseExpiresAt: "2026-07-29T12:00:30.000Z",
        now: "2026-07-29T12:00:00.000Z",
      })).resolves.toMatchObject({ upload: { uploadRef: "multipart_upload_01" } });
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("persists integrity rejection before atomically handing owner cleanup to the outbox", async () => {
    const statements: string[] = [];
    const sql: PlatformSqlTransaction = {
      query: async <Row extends Record<string, unknown>>(statement: string): Promise<readonly Row[]> => {
        statements.push(statement);
        if (statement.includes("FROM platform.asset_upload_intent intent")) {
          return rows<Row>({ authoritySiteRef: claims.siteRef,
            authorityIntentRef: claims.intentRef, authoritySessionRef: claims.sessionRef });
        }
        if (statement.includes("FROM platform.asset_multipart_upload upload")) {
          return rows<Row>(uploadRow({ uploadState: "completing", uploadExpectedVersion: 2n,
            completionIdempotencyKey: "completion-key-0001",
            completionRequestDigest: "c".repeat(64),
            completionReceiptRef: "completion_receipt_01",
            completionEffectToken: "completion_effect_token_01",
            completionEffectLeaseExpiresAt: "2026-07-29T12:01:30.000Z" }));
        }
        if (statement.includes("UPDATE platform.asset_multipart_upload upload")) {
          return rows<Row>(uploadRow({ uploadState: "integrity_rejected", uploadExpectedVersion: 3n,
            completionIdempotencyKey: "completion-key-0001",
            completionRequestDigest: "c".repeat(64),
            completionReceiptRef: "completion_receipt_01",
            completionEffectToken: null, completionEffectLeaseExpiresAt: null }));
        }
        if (statement.includes("UPDATE platform.asset_upload_session session")) {
          return rows<Row>({ expectedVersion: 3n });
        }
        if (statement.includes("INSERT INTO platform.outbox_event")) {
          return rows<Row>({ payloadDigest: "d".repeat(64) });
        }
        if (statement.includes("FROM platform.asset_multipart_part")) return [];
        throw new Error(`unexpected query: ${statement}`);
      },
      execute: async () => 1,
    };
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresAssetMultipartRepository().rejectIntegrity(lease.transaction, {
        claims,
        uploadRef: "multipart_upload_01",
        expectedVersion: 2n,
        safeReasonCode: "UPLOAD_PART_INVALID",
        effectOperation: "complete",
        effectToken: "completion_effect_token_01",
        eventId: "0198577b-4a7c-7abc-8abc-0123456789ab",
        correlationId: "completion_receipt_01",
        now: "2026-07-29T12:01:00.000Z",
      })).resolves.toMatchObject({ upload: { state: "integrity_rejected", expectedVersion: 3n } });
      expect(statements.findIndex((value) =>
        value.includes("UPDATE platform.asset_multipart_upload upload"))).toBeLessThan(
        statements.findIndex((value) => value.includes("UPDATE platform.asset_upload_session session")),
      );
      expect(statements.findIndex((value) =>
        value.includes("UPDATE platform.asset_upload_session session"))).toBeLessThan(
        statements.findIndex((value) => value.includes("INSERT INTO platform.outbox_event")),
      );
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});

function uploadRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    uploadRef: "multipart_upload_01",
    uploadSiteRef: claims.siteRef,
    uploadIntentRef: claims.intentRef,
    uploadSessionRef: claims.sessionRef,
    clientUploadId: "client_upload_0001",
    providerUploadId: "provider_upload_01",
    uploadCapabilityEpoch: 1n,
    uploadState: "uploading",
    outcomeOperation: null,
    uploadExpectedVersion: 1n,
    initiationIdempotencyKey: "initiation-key-0001",
    initiationRequestDigest: "b".repeat(64),
    initiationReceiptRef: "initiation_receipt_01",
    initiationEffectToken: null,
    initiationEffectLeaseExpiresAt: null,
    completionIdempotencyKey: null,
    completionRequestDigest: null,
    completionReceiptRef: null,
    completionEffectToken: null,
    completionEffectLeaseExpiresAt: null,
    abortIdempotencyKey: null,
    abortRequestDigest: null,
    abortReceiptRef: null,
    abortEffectToken: null,
    abortEffectLeaseExpiresAt: null,
    uploadCreatedAt: "2026-07-29T12:00:00.000Z",
    uploadUpdatedAt: "2026-07-29T12:00:00.000Z",
    ...overrides,
  } as const;
}

function rows<Row extends Record<string, unknown>>(value: Record<string, unknown>): readonly Row[] {
  return [value as Row];
}

function multipartSql(
  upload: Readonly<Record<string, unknown>>,
  changed: number,
): PlatformSqlTransaction {
  return {
    query: async <Row extends Record<string, unknown>>(statement: string): Promise<readonly Row[]> => {
      if (statement.includes("FROM platform.asset_upload_intent intent")) {
        return rows<Row>({ authoritySiteRef: claims.siteRef,
          authorityIntentRef: claims.intentRef, authoritySessionRef: claims.sessionRef });
      }
      if (statement.includes("FROM platform.asset_multipart_upload upload")) return rows<Row>(upload);
      if (statement.includes("FROM platform.asset_multipart_part")) return [];
      throw new Error(`unexpected query: ${statement}`);
    },
    execute: async () => changed,
  };
}
