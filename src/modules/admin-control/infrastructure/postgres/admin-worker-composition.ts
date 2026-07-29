import { randomUUID } from "node:crypto";
import type { PlatformTransactionalDatabaseClient } from
  "../../../../infrastructure/postgres/client.js";
import { OutboxRepository } from "../../../../shared/outbox-inbox/outbox.js";
import { AdminExecutionService } from "../../application/admin-execution-service.js";
import { createAdminExecutionCycle } from "../../application/admin-execution-cycle.js";
import { AdminLocalCommandRegistry } from "../../application/admin-command-service.js";
import { PostgresAdminAuthorityRepository } from "./admin-authority-repository.js";
import { createAdminAuthorityCommandHandler } from "./admin-authority-command-handler.js";

export function createAdminWorkerExecutionCycle(input: Readonly<{
  database: Pick<PlatformTransactionalDatabaseClient,
    "internalTransaction" | "adminExecutionTransaction">;
  workerId: string;
}>): (context: Readonly<{ signal: AbortSignal }>) => Promise<void> {
  const outbox = new OutboxRepository();
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
  return createAdminExecutionCycle({
    database: input.database,
    executor,
    outbox,
    workerId: input.workerId,
    reference: randomUUID,
  });
}
