import { UsageSettlementService } from "../modules/credit/application/usage-settlement-service.js";
import type { UsageSettlementRepository } from
  "../modules/credit/application/contracts/usage-settlement-repository.js";
import { PostgresUsageSettlementRepository } from
  "../modules/credit/infrastructure/postgres/usage-settlement-repository.js";

/**
 * The single Platform owner used by Model Gateway, Capability and Job runtimes.
 * Callers provide a Platform transaction; no producer may write usage or credit
 * tables directly or derive a financial amount outside this owner.
 */
export function createUsageSettlementProductionComposition(input: Readonly<{
  repository?: UsageSettlementRepository;
}> = {}): Readonly<{ owner: UsageSettlementService }> {
  const repository = input.repository ?? new PostgresUsageSettlementRepository();
  return Object.freeze({ owner: new UsageSettlementService({ repository }) });
}
