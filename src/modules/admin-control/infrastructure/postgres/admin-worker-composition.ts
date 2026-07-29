import { randomUUID } from "node:crypto";
import type { PlatformTransactionalDatabaseClient } from
  "../../../../infrastructure/postgres/client.js";
import { OutboxRepository } from "../../../../shared/outbox-inbox/outbox.js";
import { AdminExecutionService } from "../../application/admin-execution-service.js";
import { createAdminExecutionCycle } from "../../application/admin-execution-cycle.js";
import { AdminLocalCommandRegistry } from "../../application/admin-command-service.js";
import { PostgresAdminAuthorityRepository } from "./admin-authority-repository.js";
import { createAdminAuthorityCommandHandler } from "./admin-authority-command-handler.js";

export interface AdminWorkerExecutionRuntime {
  runOneCycle(context: Readonly<{ signal: AbortSignal }>): Promise<void>;
  stopClaiming(): Promise<void>;
  returnLeases(reason: "shutdown" | "shutdown-deadline" | "stop-claim-failed"): Promise<void>;
}

export function createAdminWorkerExecutionRuntime(input: Readonly<{
  database: Pick<PlatformTransactionalDatabaseClient,
    "internalTransaction" | "adminExecutionTransaction">;
  workerId: string;
}>): AdminWorkerExecutionRuntime {
  const outbox = new OutboxRepository();
  let acceptingClaims = true;
  const registry = new AdminLocalCommandRegistry([
    createAdminAuthorityCommandHandler(),
  ]);
  const executor = new AdminExecutionService({
    registry,
    repository: new PostgresAdminAuthorityRepository(),
    outbox: {
      complete: (transaction, eventId, leaseToken) => outbox.complete(transaction, {
        eventId,
        leaseToken,
        deliveryId: `admin-execution:${eventId}`,
        acknowledgedAt: new Date().toISOString(),
      }),
    },
  });
  const runOneCycle = createAdminExecutionCycle({
    database: input.database,
    executor,
    outbox,
    workerId: input.workerId,
    reference: randomUUID,
    canClaim: () => acceptingClaims,
  });
  return Object.freeze({
    runOneCycle,
    stopClaiming: async () => {
      acceptingClaims = false;
    },
    returnLeases: async () => {
      await input.database.internalTransaction("admin.execution.retry", (transaction) =>
        outbox.releaseOwnedLeases(transaction, {
          workerId: input.workerId,
          owners: ["admin-execution"],
        }));
    },
  });
}
