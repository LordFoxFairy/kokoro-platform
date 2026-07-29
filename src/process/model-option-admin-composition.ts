import type { PlatformTransactionalDatabaseClient } from "../infrastructure/postgres/client.js";
import { MaterializeLegacyModelOptionsService } from "../modules/model-control/application/services/materialize-legacy-model-options.js";
import { PublishSiteReleaseModelCatalogService } from "../modules/model-control/application/services/publish-site-release-model-catalog.js";
import { PostgresModelControlCommandJournal } from "../modules/model-control/infrastructure/postgres/model-control-command-journal.js";
import { PostgresProductModelOptionRepository } from "../modules/model-control/infrastructure/postgres/product-model-option-repository.js";
import { PlatformUnitOfWork } from "../shared/unit-of-work/index.js";

export interface ProductModelOptionAdministrationComposition {
  readonly materializeLegacy: MaterializeLegacyModelOptionsService;
  readonly publishSiteRelease: PublishSiteReleaseModelCatalogService;
}

/** Production Admin composition. The caller owns connect/disconnect and the signed context. */
export function createProductModelOptionAdministrationComposition(
  database: PlatformTransactionalDatabaseClient,
): ProductModelOptionAdministrationComposition {
  const unitOfWork = new PlatformUnitOfWork(database);
  const repository = new PostgresProductModelOptionRepository();
  const journal = new PostgresModelControlCommandJournal();
  return Object.freeze({
    materializeLegacy: new MaterializeLegacyModelOptionsService(unitOfWork, repository, journal),
    publishSiteRelease: new PublishSiteReleaseModelCatalogService(unitOfWork, repository, journal),
  });
}
