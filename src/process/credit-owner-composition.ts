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

/** Credit-owned application ports only; transport/auth adapters bind outside this composition. */
export interface CreditOwnerComposition {
  readonly programCatalog: CreditProgramCatalogService;
  readonly programCatalogReader: CreditProgramCatalogReader;
}

export function createCreditOwnerComposition(input: Readonly<{
  database: PlatformTransactionalDatabaseClient;
  queryHost: CreditProgramCatalogReadTransactionHost;
  clock?: () => string;
}>): CreditOwnerComposition {
  const unitOfWork = new PlatformUnitOfWork(input.database);
  return Object.freeze({
    programCatalog: new CreditProgramCatalogService({
      unitOfWork,
      repository: new PostgresCreditProgramCatalog(),
      decodeDefinitionBytes: canonicalCreditProgramDefinitionFromBytes,
      ...(input.clock === undefined ? {} : { clock: input.clock }),
    }),
    programCatalogReader: new PostgresCreditProgramCatalogReader(input.queryHost),
  });
}
