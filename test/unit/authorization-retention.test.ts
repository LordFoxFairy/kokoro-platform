import { describe, expect, it } from "vitest";
import {
  createAuthorizationRetentionCycle,
  createAuthorizationRetentionRunOnce,
} from "../../src/modules/authorization/infrastructure/postgres/authorization-retention.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
  type PlatformTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";

describe("Authorization retention", () => {
  it("exits explicitly without deleting when another retention cycle owns the advisory lock", async () => {
    const retained: unknown[] = [];
    const database = retentionDatabase(false);
    const runOnce = createAuthorizationRetentionRunOnce({
      database,
      repository: { retain: async (_transaction: PlatformTransaction, input: unknown) => {
        retained.push(input);
        return { snapshotsDeleted: 1, eventsDeleted: 2 };
      } } as never,
      retentionMs: 24 * 60 * 60_000,
      clock: () => new Date("2026-07-30T10:00:00.000Z"),
    });

    await expect(runOnce({ signal: new AbortController().signal })).resolves.toEqual({
      status: "already-running",
    });
    expect(retained).toEqual([]);
    expect(database.lockQueries[0]).toContain("pg_try_advisory_xact_lock");
  });

  it("holds the advisory lock in the deletion transaction and runs a composed cycle only once", async () => {
    const retained: unknown[] = [];
    const database = retentionDatabase(true);
    const cycle = createAuthorizationRetentionCycle({
      database,
      repository: { retain: async (_transaction: PlatformTransaction, input: unknown) => {
        retained.push(input);
        return { snapshotsDeleted: 1, eventsDeleted: 2 };
      } } as never,
      retentionMs: 24 * 60 * 60_000,
      clock: () => new Date("2026-07-30T10:00:00.000Z"),
    });

    await cycle({ signal: new AbortController().signal });
    await cycle({ signal: new AbortController().signal });

    expect(retained).toEqual([{
      now: "2026-07-30T10:00:00.000Z",
      appendedBefore: "2026-07-29T10:00:00.000Z",
    }]);
    expect(database.transactionCount).toBe(1);
  });
});

function retentionDatabase(acquired: boolean) {
  const state = { transactionCount: 0, lockQueries: [] as string[] };
  return Object.assign(state, {
    async internalTransaction<Result>(
      operation: "authorization.retention",
      work: (transaction: PlatformTransaction) => Promise<Result>,
    ): Promise<Result> {
      expect(operation).toBe("authorization.retention");
      state.transactionCount += 1;
      const lease = issuePlatformTransaction({
        query: async <Row extends Record<string, unknown>>(sql: string): Promise<readonly Row[]> => {
          state.lockQueries.push(sql);
          return [{ acquired }] as unknown as readonly Row[];
        },
        execute: async () => 0,
      });
      try {
        return await work(lease.transaction);
      } finally {
        revokePlatformTransaction(lease);
      }
    },
  });
}
