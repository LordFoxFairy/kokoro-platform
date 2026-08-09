import type { PlatformTransactionalDatabaseClient } from "../infrastructure/postgres/client.js";
import { CommerceAdministrationService } from "../modules/commerce/application/services/commerce-administration.js";
import { PostgresCommerceAdministrationRepository } from "../modules/commerce/infrastructure/postgres/commerce-administration-repository.js";
import { PlatformUnitOfWork } from "../shared/unit-of-work/index.js";
import { loadRedemptionSecretCodec } from "./platform-public-composition.js";
import { PostgresCreditGrantProgram } from "../modules/commerce/infrastructure/postgres/credit-program-repository.js";
import { PostgresCommerceAdministrationReader } from
  "../modules/commerce/infrastructure/postgres/commerce-administration-reader.js";
import { PostgresCreditGrantProgramAdministrationReader } from
  "../modules/commerce/infrastructure/postgres/credit-program-administration-reader.js";

export interface CommerceAdministrationComposition {
  readonly commerce: CommerceAdministrationService;
  readonly reader: PostgresCommerceAdministrationReader;
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
    reader: new PostgresCommerceAdministrationReader(
      input.database,
      new PostgresCreditGrantProgramAdministrationReader(input.database),
    ),
  });
}
