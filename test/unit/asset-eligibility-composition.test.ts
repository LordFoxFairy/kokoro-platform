import { describe, expect, it } from "vitest";
import type { PlatformTransactionalDatabaseClient } from "../../src/infrastructure/postgres/client.js";
import { createAssetEligibilityApplicationComposition } from
  "../../src/process/admission-composition.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
  type PlatformSqlTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";

describe("Admission-hosted AssetEligibility composition", () => {
  it("uses the Admission role transaction, derived owner RLS scope, and existing Asset owner repository", async () => {
    const operations: string[] = [];
    const calls: Array<Readonly<{ statement: string; values: readonly unknown[] }>> = [];
    const sql: PlatformSqlTransaction = {
      async query<Row extends Record<string, unknown>>(
        statement: string,
        values: readonly unknown[] = [],
      ): Promise<readonly Row[]> {
        calls.push({ statement, values });
        if (statement.includes("authorization_session_access_grant")) {
          return [{
            siteId: "site-a", siteReleaseRef: "release-a", projectRef: "project-a",
            subjectRef: "subject-a", subjectGeneration: 7n,
            identitySessionRef: "identity-session-a",
            resource: { kind: "session", sessionRef: "session-a" },
          }] as unknown as readonly Row[];
        }
        if (statement.includes("platform.platform_foundation")) {
          return [{ active: true }] as unknown as readonly Row[];
        }
        if (statement.includes("WITH requested AS")) {
          return [{
            ordinal: 1n, assetRef: "asset-a", assetVersionRef: "version-a",
            assetGrantRef: "grant-a", projectRef: "project-a", purpose: "chat.attachment",
            subjectGeneration: 7n, eligibilityEpoch: 9n,
            checksumSha256: "a".repeat(64), safeDisplayName: "notes.txt",
            detectedMediaType: "text/plain", size: 42n,
          }] as unknown as readonly Row[];
        }
        return [];
      },
      async execute(): Promise<number> { throw new Error("read only"); },
    };
    const database = {
      internalTransaction: async (operation: string, work: (transaction: never) => Promise<unknown>) => {
        operations.push(operation);
        const lease = issuePlatformTransaction(sql);
        try { return await work(lease.transaction as never); } finally { revokePlatformTransaction(lease); }
      },
    } as unknown as Pick<PlatformTransactionalDatabaseClient, "internalTransaction">;
    const application = createAssetEligibilityApplicationComposition({
      database,
      sessionCallerIdentity: "spiffe://kokoro/session",
    });

    await expect(application.checkActive({
      identity: "spiffe://kokoro/session", environment: "production", region: "us-east-1",
    }, new AbortController().signal)).resolves.toEqual({
      contractRevision: "platform-asset-eligibility@v1",
    });

    await expect(application.resolveSessionAttachments({
      siteId: "site-a", sessionAccessGrant: "opaque-grant-a", sessionId: "session-a",
      purpose: "chat.attachment",
      attachments: [{ assetRef: "asset-a", assetVersionRef: "version-a", assetGrantRef: "grant-a" }],
    }, {
      identity: "spiffe://kokoro/session", environment: "production", region: "us-east-1",
    }, new AbortController().signal)).resolves.toMatchObject([{
      assetRef: "asset-a", checksumSha256: "a".repeat(64), eligibilityEpoch: 9n,
    }]);
    expect(operations).toEqual(["asset.eligibility.check-active", "asset.eligibility.resolve"]);
    expect(calls.find(({ statement }) => statement.includes("app.site_id"))).toMatchObject({
      values: ["site-a", "spiffe://kokoro/session"],
    });
    expect(calls.find(({ statement }) => statement.includes("app.site_id"))?.statement)
      .toContain("set_config('statement_timeout','5000',true)");
    expect(calls.find(({ statement }) => statement.includes("set_config('app.subject_id'"))?.values)
      .toEqual(["site-a", "subject-a", "7", "project-a", "chat.attachment"]);
  });
});
