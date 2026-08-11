import { dirname } from "node:path";
import type { PlatformTransactionalDatabaseClient } from "../infrastructure/postgres/client.js";
import { CommerceAdministrationService } from "../modules/commerce/application/services/commerce-administration.js";
import { PostgresCommerceAdministrationRepository } from "../modules/commerce/infrastructure/postgres/commerce-administration-repository.js";
import { PlatformUnitOfWork } from "../shared/unit-of-work/index.js";
import { loadRedemptionSecretCodec } from "./platform-public-composition.js";
import { createPlatformApiRuntimeFileReader } from "./platform-api-runtime-contract.js";
import { createBoundedFileReaderWithinTrustRoot } from "./secret-files.js";
import { PostgresCreditGrantProgram } from "../modules/commerce/infrastructure/postgres/credit-program-repository.js";
import { PostgresCommerceAdministrationReader } from
  "../modules/commerce/infrastructure/postgres/commerce-administration-reader.js";
import { PostgresCreditGrantProgramAdministrationReader } from
  "../modules/commerce/infrastructure/postgres/credit-program-administration-reader.js";
import type { RedemptionCodeIssuancePort, RedemptionSecretPort } from
  "../modules/commerce/application/contracts/redemption-secret-port.js";
import type { RedemptionEntropySource } from
  "../modules/commerce/infrastructure/crypto/redemption-secret-codec.js";

export interface CommerceAdministrationComposition {
  readonly commerce: CommerceAdministrationService;
  readonly reader: PostgresCommerceAdministrationReader;
  readonly codes: RedemptionSecretPort & RedemptionCodeIssuancePort;
}

/** Production control-plane composition; caller owns the verified Admin context and process lifecycle. */
export async function createCommerceAdministrationComposition(input: Readonly<{
  database: PlatformTransactionalDatabaseClient;
  environment?: Readonly<Record<string, string | undefined>>;
  entropySource?: RedemptionEntropySource;
}>): Promise<CommerceAdministrationComposition> {
  const environment = input.environment ?? process.env;
  const keyRingPath = environment.PLATFORM_COMMERCE_REDEMPTION_KEY_RING_FILE;
  if (keyRingPath === undefined || keyRingPath.length === 0) {
    throw new Error("PLATFORM_COMMERCE_REDEMPTION_KEY_RING_FILE_REQUIRED");
  }
  const keyRingReader = createPlatformApiRuntimeFileReader(
    await createBoundedFileReaderWithinTrustRoot(
      dirname(keyRingPath),
      "PLATFORM_COMMERCE_REDEMPTION_KEY_RING_TRUST_ROOT_INVALID",
    ),
  );
  const codes = await loadRedemptionSecretCodec(keyRingPath, keyRingReader,
    input.entropySource === undefined ? {} : { entropySource: input.entropySource });
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
    codes,
  });
}
