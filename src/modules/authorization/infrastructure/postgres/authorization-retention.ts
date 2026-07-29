import type { PlatformTransactionalDatabaseClient } from "../../../../infrastructure/postgres/client.js";
import { PostgresAuthorizationFeedRepository } from "./authorization-feed-repository.js";

export function createAuthorizationRetentionCycle(input: Readonly<{
  database: Pick<PlatformTransactionalDatabaseClient, "internalTransaction">;
  repository?: PostgresAuthorizationFeedRepository;
  retentionMs: number;
  clock?: () => Date;
}>): (context: Readonly<{ signal: AbortSignal }>) => Promise<void> {
  if (
    !Number.isInteger(input.retentionMs) ||
    input.retentionMs < 60 * 60_000 ||
    input.retentionMs > 30 * 24 * 60 * 60_000
  ) throw new Error("AUTHORIZATION_EVENT_RETENTION_INVALID");
  const repository = input.repository ?? new PostgresAuthorizationFeedRepository();
  const clock = input.clock ?? (() => new Date());
  return async ({ signal }) => {
    signal.throwIfAborted();
    const now = clock();
    await input.database.internalTransaction("authorization.retention", (transaction) =>
      repository.retain(transaction, {
        now: now.toISOString(),
        eventsBefore: new Date(now.getTime() - input.retentionMs).toISOString(),
      }));
  };
}
