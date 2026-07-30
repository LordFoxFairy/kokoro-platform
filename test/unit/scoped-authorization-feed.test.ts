import { describe, expect, it } from "vitest";

import { PostgresScopedAuthorizationFeedRepository } from "../../src/modules/authorization/infrastructure/postgres/scoped-authorization-feed-repository.js";
import { issuePlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";

describe("scoped authorization feed reservation", () => {
  it("reserves a contiguous batch while locking global stream before Site", async () => {
    const statements: string[] = [];
    const transaction = issuePlatformTransaction({
      async query<Row extends Record<string, unknown>>(statement: string) {
        statements.push(statement);
        return (statement.includes("authorization_scoped_stream_state")
          ? [{ firstStreamSequence: 9n }]
          : [{ firstAggregateSequence: 4n }]) as unknown as readonly Row[];
      },
      async execute() { return 0; },
    }).transaction;

    const reservations = await new PostgresScopedAuthorizationFeedRepository()
      .reserveOwnerMutations(transaction, "site-1", 2);

    expect(statements[0]).toContain("authorization_scoped_stream_state");
    expect(statements[1]).toContain("authorization_scoped_site_cursor");
    expect(reservations).toEqual([
      { siteRef: "site-1", streamSequence: 9n, aggregateSequence: 4n },
      { siteRef: "site-1", streamSequence: 10n, aggregateSequence: 5n },
    ]);
  });

  it("accepts a legitimately retained empty log but rejects a stale latest sequence", async () => {
    const rows: Array<Readonly<{ highWatermark: bigint; latestSequence: bigint | null }>> = [
      { highWatermark: 9n, latestSequence: null },
      { highWatermark: 9n, latestSequence: 8n },
    ];
    const transaction = issuePlatformTransaction({
      async query<Row extends Record<string, unknown>>() {
        return [rows.shift()!] as unknown as readonly Row[];
      },
      async execute() { return 0; },
    }).transaction;
    const repository = new PostgresScopedAuthorizationFeedRepository();
    await expect(repository.assertReady(transaction)).resolves.toBeUndefined();
    await expect(repository.assertReady(transaction)).rejects.toThrow("SCOPED_AUTHORIZATION_NOT_READY");
  });
});
