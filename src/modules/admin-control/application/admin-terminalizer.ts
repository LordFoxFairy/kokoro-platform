import type { PlatformTransactionalDatabaseClient } from
  "../../../infrastructure/postgres/client.js";
import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";
import { PostgresAdminAuthorityRepository } from
  "../infrastructure/postgres/admin-authority-repository.js";

export interface AdminTerminalizerRepositoryPort {
  terminalizeApprovals(transaction: PlatformTransaction, now: string): Promise<number>;
  terminalizePostEffectReviews(transaction: PlatformTransaction, now: string): Promise<number>;
}

export function createAdminTerminalizerCycle(input: Readonly<{
  database: Pick<PlatformTransactionalDatabaseClient, "internalTransaction">;
  repository?: AdminTerminalizerRepositoryPort;
  clock?: () => Date;
}>): (context: Readonly<{ signal: AbortSignal }>) => Promise<void> {
  const repository = input.repository ?? new PostgresAdminAuthorityRepository();
  const clock = input.clock ?? (() => new Date());
  return async ({ signal }) => {
    signal.throwIfAborted();
    const now = clock().toISOString();
    await input.database.internalTransaction("admin.terminalize", async (transaction) => {
      await repository.terminalizeApprovals(transaction, now);
      await repository.terminalizePostEffectReviews(transaction, now);
    });
  };
}
