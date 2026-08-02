import { ExecutionRootClosureService } from
  "../modules/credit/application/execution-root-closure-service.js";
import { PostgresExecutionRootClosureRepository } from
  "../modules/credit/infrastructure/postgres/execution-root-closure-repository.js";
import { CreditService } from "../modules/credit/application/credit-service.js";
import { UsageSettlementService } from "../modules/credit/application/usage-settlement-service.js";
import { PostgresCreditAuthorityRepository } from
  "../modules/credit/infrastructure/postgres/credit-authority-repository.js";
import { PostgresUsageSettlementRepository } from
  "../modules/credit/infrastructure/postgres/usage-settlement-repository.js";

export interface CreditExecutionOwnerFacade {
  readonly runBudget: CreditService;
  readonly usageSettlement: UsageSettlementService;
  readonly executionRootClosure: ExecutionRootClosureService;
}

export function createCreditExecutionOwnerFacade(): CreditExecutionOwnerFacade {
  return Object.freeze({
    runBudget: new CreditService({ repository: new PostgresCreditAuthorityRepository() }),
    usageSettlement: new UsageSettlementService({ repository: new PostgresUsageSettlementRepository() }),
    executionRootClosure: new ExecutionRootClosureService({
      repository: new PostgresExecutionRootClosureRepository(),
    }),
  });
}
