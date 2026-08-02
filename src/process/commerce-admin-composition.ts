import type { PlatformTransactionalDatabaseClient } from "../infrastructure/postgres/client.js";
import { CommerceAdministrationService } from "../modules/commerce/application/services/commerce-administration.js";
import { PostgresCommerceAdministrationRepository } from "../modules/commerce/infrastructure/postgres/commerce-administration-repository.js";
import { PlatformUnitOfWork } from "../shared/unit-of-work/index.js";
import { loadRedemptionSecretCodec } from "./platform-public-composition.js";
import { PostgresCreditGrantProgram } from "../modules/commerce/infrastructure/postgres/credit-program-repository.js";
import { CreditProgramCatalogService } from "../modules/commerce/application/credit-program-catalog-service.js";
import { PostgresCreditProgramCatalog } from "../modules/commerce/infrastructure/postgres/credit-program-catalog.js";
import { PostgresCreditProgramCatalogReader } from
  "../modules/commerce/infrastructure/postgres/credit-program-catalog-reader.js";
import { canonicalCreditProgramDefinitionFromBytes } from
  "../modules/commerce/infrastructure/protobuf/credit-program-codec.js";
import type { CreditProgramCatalogReader, CreditProgramCatalogReadTransactionHost } from
  "../modules/commerce/application/contracts/credit-program-catalog-reader.js";

export interface CommerceAdministrationComposition {
  readonly commerce: CommerceAdministrationService;
}

export interface CommerceProgramCatalogComposition {
  readonly programCatalog: CreditProgramCatalogService;
  readonly programCatalogReader: CreditProgramCatalogReader;
}

export function createCommerceProgramCatalogComposition(input: Readonly<{
  database: PlatformTransactionalDatabaseClient;
  queryHost: CreditProgramCatalogReadTransactionHost;
  clock?: () => string;
}>): CommerceProgramCatalogComposition {
  return Object.freeze({
    programCatalog: new CreditProgramCatalogService({
      unitOfWork: new PlatformUnitOfWork(input.database),
      repository: new PostgresCreditProgramCatalog(),
      decodeDefinitionBytes: canonicalCreditProgramDefinitionFromBytes,
      ...(input.clock === undefined ? {} : { clock: input.clock }),
    }),
    programCatalogReader: new PostgresCreditProgramCatalogReader(input.queryHost),
  });
}

/** Production control-plane composition; caller owns the verified Admin context and process lifecycle. */
export async function createCommerceAdministrationComposition(input: Readonly<{
  database: PlatformTransactionalDatabaseClient;
  environment?: Readonly<Record<string, string | undefined>>;
}>): Promise<CommerceAdministrationComposition> {
  const environment = input.environment ?? process.env;
  const keyRingPath = environment.PLATFORM_COMMERCE_REDEMPTION_KEY_RING_FILE;
  if (keyRingPath === undefined || keyRingPath.length === 0) {
    throw new Error("PLATFORM_COMMERCE_REDEMPTION_KEY_RING_FILE_REQUIRED");
  }
  const codes = await loadRedemptionSecretCodec(keyRingPath);
  return Object.freeze({
    commerce: new CommerceAdministrationService({
      unitOfWork: new PlatformUnitOfWork(input.database),
      repository: new PostgresCommerceAdministrationRepository(new PostgresCreditGrantProgram()),
      codes,
    }),
  });
}
