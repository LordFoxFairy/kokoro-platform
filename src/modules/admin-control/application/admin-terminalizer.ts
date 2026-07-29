import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";

interface AdminTerminalizerDatabasePort {
  internalTransaction<Result>(
    operation: "admin.terminalize",
    work: (transaction: PlatformTransaction) => Promise<Result>,
  ): Promise<Result>;
}

export interface AdminTerminalizerRepositoryPort {
  terminalizeApprovals(transaction: PlatformTransaction, now: string): Promise<number>;
  terminalizePostEffectReviews(transaction: PlatformTransaction, now: string): Promise<number>;
}

export function createAdminTerminalizerCycle(input: Readonly<{
  database: AdminTerminalizerDatabasePort;
  repository: AdminTerminalizerRepositoryPort;
  clock?: () => Date;
}>): (context: Readonly<{ signal: AbortSignal }>) => Promise<void> {
  const clock = input.clock ?? (() => new Date());
  return async ({ signal }) => {
    signal.throwIfAborted();
    const now = clock().toISOString();
    await input.database.internalTransaction("admin.terminalize", async (transaction) => {
      await input.repository.terminalizeApprovals(transaction, now);
      await input.repository.terminalizePostEffectReviews(transaction, now);
    });
  };
}
