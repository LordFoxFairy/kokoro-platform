import type { PlatformTransactionalDatabaseClient } from "../infrastructure/postgres/client.js";
import { PlatformUnitOfWork } from "../shared/unit-of-work/index.js";
import { CreditProgramCatalogService } from
  "../modules/credit/application/credit-program-catalog-service.js";
import { PostgresCreditProgramCatalog } from
  "../modules/credit/infrastructure/postgres/credit-program-catalog.js";
import { PostgresCreditProgramCatalogReader } from
  "../modules/credit/infrastructure/postgres/credit-program-catalog-reader.js";
import { canonicalCreditProgramDefinitionFromBytes } from
  "../modules/credit/infrastructure/protobuf/credit-program-codec.js";
import type { CreditProgramCatalogReader, CreditProgramCatalogReadTransactionHost } from
  "../modules/credit/application/contracts/credit-program-catalog-reader.js";
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

/** Credit-owned application ports only; transport/auth adapters bind outside this composition. */
export interface CreditOwnerComposition extends CreditExecutionOwnerFacade {
  readonly programCatalog: CreditProgramCatalogService;
  readonly programCatalogReader: CreditProgramCatalogReader;
}

export function createCreditOwnerComposition(input: Readonly<{
  database: PlatformTransactionalDatabaseClient;
  queryHost: CreditProgramCatalogReadTransactionHost;
  clock?: () => string;
}>): CreditOwnerComposition {
  const unitOfWork = new PlatformUnitOfWork(input.database);
  const execution = createCreditExecutionOwnerFacade();
  return Object.freeze({
    ...execution,
    programCatalog: new CreditProgramCatalogService({
      unitOfWork,
      repository: new PostgresCreditProgramCatalog(),
      decodeDefinitionBytes: canonicalCreditProgramDefinitionFromBytes,
      ...(input.clock === undefined ? {} : { clock: input.clock }),
    }),
    programCatalogReader: new PostgresCreditProgramCatalogReader(input.queryHost),
  });
}
