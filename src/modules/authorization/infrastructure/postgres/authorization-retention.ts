import type { PlatformTransactionalDatabaseClient } from "../../../../infrastructure/postgres/client.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import { PostgresScopedAuthorizationFeedRepository } from "./scoped-authorization-feed-repository.js";

type AuthorizationRetentionInput = Readonly<{
  database: Pick<PlatformTransactionalDatabaseClient, "internalTransaction">;
  repository?: Pick<PostgresScopedAuthorizationFeedRepository, "retain">;
  retentionMs: number;
  clock?: () => Date;
}>;

export type AuthorizationRetentionResult =
  | Readonly<{ status: "already-running" }>
  | Readonly<{ status: "completed"; snapshotsDeleted: number; eventsDeleted: number }>;

export function createAuthorizationRetentionRunOnce(
  input: AuthorizationRetentionInput,
): (context: Readonly<{ signal: AbortSignal }>) => Promise<AuthorizationRetentionResult> {
  if (
    !Number.isInteger(input.retentionMs) ||
    input.retentionMs < 60 * 60_000 ||
    input.retentionMs > 30 * 24 * 60 * 60_000
  ) throw new Error("AUTHORIZATION_EVENT_RETENTION_INVALID");
  const repository = input.repository ?? new PostgresScopedAuthorizationFeedRepository();
  const clock = input.clock ?? (() => new Date());
  return async ({ signal }) => {
    signal.throwIfAborted();
    const now = clock();
    return input.database.internalTransaction("authorization.retention", async (transaction) => {
      const lockRows = await resolvePlatformTransaction(transaction).query<{ acquired: boolean }>(
        `SELECT pg_catalog.pg_try_advisory_xact_lock(
           pg_catalog.hashtextextended($1,0)
         ) AS "acquired"`,
        ["platform.authorization.retention.v1"],
      );
      if (lockRows.length !== 1 || typeof lockRows[0]?.acquired !== "boolean") {
        throw new Error("AUTHORIZATION_RETENTION_LOCK_RESULT_INVALID");
      }
      if (!lockRows[0].acquired) return Object.freeze({ status: "already-running" as const });
      const result = await repository.retain(transaction, {
        now: now.toISOString(),
        appendedBefore: new Date(now.getTime() - input.retentionMs).toISOString(),
      });
      return Object.freeze({ status: "completed" as const, ...result });
    });
  };
}

export function createAuthorizationRetentionCycle(
  input: AuthorizationRetentionInput,
): (context: Readonly<{ signal: AbortSignal }>) => Promise<void> {
  const runOnce = createAuthorizationRetentionRunOnce(input);
  let attempted = false;
  return async (context) => {
    context.signal.throwIfAborted();
    if (attempted) return;
    attempted = true;
    await runOnce(context);
  };
}
