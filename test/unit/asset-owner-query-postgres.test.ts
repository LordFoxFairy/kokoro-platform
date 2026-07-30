import { describe, expect, it } from "vitest";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
  type PlatformSqlTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";
import { PostgresAssetOwnerQueryRepository } from "../../src/modules/asset/infrastructure/postgres/asset-owner-query-repository.js";

const authority = Object.freeze({
  siteRef: "site_01", workloadIdentityId: "workload_01", siteReleaseRef: "release_01",
  bindingEpoch: 7n, subjectRef: "subject_01", subjectGeneration: 4n, projectRef: "project_01",
});

describe("PostgresAssetOwnerQueryRepository", () => {
  it("loads status through every owner axis and publishes only closed eligibility", async () => {
    let statement = "";
    let values: readonly unknown[] = [];
    const sql: PlatformSqlTransaction = {
      query: async <Row extends Record<string, unknown>>(query: string, parameters = []): Promise<readonly Row[]> => {
        statement = query; values = parameters;
        return [{
          intentRef: "intent_01", sessionRef: "session_01", projectRef: "project_01",
          purpose: "chat.attachment", safeDisplayName: "photo.png", clientMediaType: "image/png",
          expectedSize: 1234n, expectedVersion: 6n, sessionState: "completed",
          candidateState: "promotion_ready", promotionState: "completed", rejected: false,
          updatedAt: "2026-07-28T12:00:00.000Z", assetRef: "asset_01",
          assetVersionRef: "version_01", assetGrantRef: "eligibility_01",
          grantSubjectGeneration: 4n, eligibilityEpoch: 9n, detectedMediaType: "image/png",
          grantSize: 1234n,
        }] as unknown as readonly Row[];
      },
      execute: async () => 0,
    };
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresAssetOwnerQueryRepository().loadUploadStatus(lease.transaction,
        { authority, intentRef: "intent_01" })).resolves.toMatchObject({
          trustedGrant: { assetGrantRef: "eligibility_01", eligibilityEpoch: 9n },
        });
      expect(statement).toContain("intent.subject_generation=$3::bigint");
      expect(statement).toContain("intent.project_ref=$4");
      expect(statement).toContain("eligibility.eligibility_epoch=version.eligibility_epoch");
      expect(values).toEqual(["site_01", "subject_01", 4n, "project_01", "intent_01",
        "workload_01", "release_01", 7n]);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("requires the exact grant, purpose, generation, project, and eligibility epoch", async () => {
    let statement = "";
    let values: readonly unknown[] = [];
    const sql: PlatformSqlTransaction = {
      query: async <Row extends Record<string, unknown>>(query: string, parameters = []): Promise<readonly Row[]> => {
        statement = query; values = parameters; return [];
      },
      execute: async () => 0,
    };
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresAssetOwnerQueryRepository().loadTrustedGrant(lease.transaction, {
        authority, assetRef: "asset_01", assetVersionRef: "version_01",
        assetGrantRef: "eligibility_01", purpose: "chat.attachment", eligibilityEpoch: 9n,
      })).resolves.toBeNull();
      for (const fragment of [
        "resource.subject_generation=$3::bigint", "resource.project_ref=$4",
        "eligibility.eligibility_ref=$7", "resource.purpose=$8", "eligibility.eligibility_epoch=$9::bigint",
        "resource.state='active'", "version.state='ready'", "eligibility.state='ready'",
      ]) expect(statement).toContain(fragment);
      expect(values).toEqual(["site_01", "subject_01", 4n, "project_01", "asset_01",
        "version_01", "eligibility_01", "chat.attachment", 9n]);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("resolves an exact bounded attachment set in caller order from the current owner projection", async () => {
    let statement = "";
    let values: readonly unknown[] = [];
    const sql: PlatformSqlTransaction = {
      query: async <Row extends Record<string, unknown>>(query: string, parameters = []): Promise<readonly Row[]> => {
        statement = query;
        values = parameters;
        return [{
          ordinal: 1n,
          assetRef: "asset_02",
          assetVersionRef: "version_02",
          assetGrantRef: "eligibility_02",
          projectRef: "project_01",
          purpose: "chat.attachment",
          subjectGeneration: 4n,
          eligibilityEpoch: 10n,
          checksumSha256: "b".repeat(64),
          safeDisplayName: "diagram.png",
          detectedMediaType: "image/png",
          size: 4321n,
        }, {
          ordinal: 2n,
          assetRef: "asset_01",
          assetVersionRef: "version_01",
          assetGrantRef: "eligibility_01",
          projectRef: "project_01",
          purpose: "chat.attachment",
          subjectGeneration: 4n,
          eligibilityEpoch: 9n,
          checksumSha256: "a".repeat(64),
          safeDisplayName: "notes.txt",
          detectedMediaType: "text/plain",
          size: 1234n,
        }] as unknown as readonly Row[];
      },
      execute: async () => 0,
    };
    const lease = issuePlatformTransaction(sql);
    try {
      const result = await new PostgresAssetOwnerQueryRepository().loadSessionAttachments(
        lease.transaction,
        {
          authority: {
            siteRef: "site_01", subjectRef: "subject_01", subjectGeneration: 4n,
            projectRef: "project_01",
          },
          purpose: "chat.attachment",
          attachments: [
            { assetRef: "asset_02", assetVersionRef: "version_02", assetGrantRef: "eligibility_02" },
            { assetRef: "asset_01", assetVersionRef: "version_01", assetGrantRef: "eligibility_01" },
          ],
        },
      );
      expect(result?.map((entry) => entry.assetRef)).toEqual(["asset_02", "asset_01"]);
      expect(result?.[0]).toMatchObject({
        checksumSha256: "b".repeat(64), safeDisplayName: "diagram.png",
        detectedMediaType: "image/png", size: 4321n, eligibilityEpoch: 10n,
      });
      for (const fragment of [
        "WITH ORDINALITY", "ORDER BY requested.ordinal", "resource.subject_ref=$2",
        "resource.subject_generation=$3::bigint", "resource.project_ref=$4",
        "resource.purpose=$5", "version.checksum_sha256", "intent.safe_display_name",
        "resource.state='active'", "version.state='ready'", "eligibility.state='ready'",
      ]) expect(statement).toContain(fragment);
      expect(values).toEqual([
        "site_01", "subject_01", 4n, "project_01", "chat.attachment",
        ["asset_02", "asset_01"], ["version_02", "version_01"],
        ["eligibility_02", "eligibility_01"],
      ]);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects the entire set when any exact attachment is stale, revoked, or cross-scope", async () => {
    const sql: PlatformSqlTransaction = {
      query: async <Row extends Record<string, unknown>>(): Promise<readonly Row[]> => [{
        ordinal: 1n,
        assetRef: "asset_01",
        assetVersionRef: "version_01",
        assetGrantRef: "eligibility_01",
        projectRef: "project_01",
        purpose: "chat.attachment",
        subjectGeneration: 4n,
        eligibilityEpoch: 9n,
        checksumSha256: "a".repeat(64),
        safeDisplayName: "notes.txt",
        detectedMediaType: "text/plain",
        size: 1234n,
      }] as unknown as readonly Row[],
      execute: async () => 0,
    };
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresAssetOwnerQueryRepository().loadSessionAttachments(
        lease.transaction,
        {
          authority: {
            siteRef: "site_01", subjectRef: "subject_01", subjectGeneration: 4n,
            projectRef: "project_01",
          },
          purpose: "chat.attachment",
          attachments: [
            { assetRef: "asset_01", assetVersionRef: "version_01", assetGrantRef: "eligibility_01" },
            { assetRef: "asset_02", assetVersionRef: "version_02", assetGrantRef: "eligibility_02" },
          ],
        },
      )).resolves.toBeNull();
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});
