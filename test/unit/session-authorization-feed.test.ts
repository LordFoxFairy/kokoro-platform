import { describe, expect, it } from "vitest";
import { PostgresAuthorizationFeedRepository } from "../../src/modules/authorization/infrastructure/postgres/authorization-feed-repository.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";

describe("PostgreSQL authorization feed", () => {
  it("uses the single global-stream then Site lock order for revocation", async () => {
    const statements: string[] = [];
    const lease = issuePlatformTransaction({
      query: async <Row extends Record<string, unknown>>(statement: string): Promise<readonly Row[]> => {
        statements.push(statement);
        const rows = statement.includes("authorization_stream_state")
          ? [{ streamSequence: 8n }]
          : [{ aggregateSequence: 3n, revocationEpoch: 7n }];
        return rows as unknown as readonly Row[];
      },
      execute: async () => 0,
    });
    try {
      const result = await new PostgresAuthorizationFeedRepository().reserveAndBumpRevocation(
        lease.transaction,
        {
          siteRef: "site-a",
          expectedRevocationEpoch: 6n,
          changedAt: "2026-07-29T00:00:00.000Z",
        },
      );
      expect(result).toEqual({ streamSequence: 8n, aggregateSequence: 3n, revocationEpoch: 7n });
      expect(statements).toHaveLength(2);
      expect(statements[0]).toContain("authorization_stream_state");
      expect(statements[1]).toContain("authorization_site");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("uses transactional counters and bounded authoritative snapshot materialization", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile("src/modules/authorization/infrastructure/postgres/authorization-feed-repository.ts", "utf8"));
    expect(source).not.toContain("nextval(");
    expect(source).toContain("FOR SHARE");
    expect(source).toContain("maximumRecords = 20_000");
    expect(source).toContain("offset += 500");
    expect(source).toContain("FROM platform.authorization_session_access_grant");
    expect(source).not.toContain("signing_payload_grant_ref");
  });

  it("retains events by append time and only deletes a safe stream prefix", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile("src/modules/authorization/infrastructure/postgres/authorization-feed-repository.ts", "utf8"));
    const retention = source.slice(source.indexOf("async retain("));
    expect(retention).toContain("created_at");
    expect(retention).toContain("MIN(stream_sequence)");
    expect(retention).not.toContain("WHERE occurred_at<");
  });
});
