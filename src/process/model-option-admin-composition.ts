import type { PlatformTransactionalDatabaseClient } from "../infrastructure/postgres/client.js";
import { MaterializeModelOptionsService } from "../modules/model-control/application/services/materialize-model-options.js";
import { PublishSiteReleaseModelCatalogService } from "../modules/model-control/application/services/publish-site-release-model-catalog.js";
import { ImportModelControlService } from
  "../modules/model-control/application/services/import-model-control.js";
import { ActivateModelInventoryService } from
  "../modules/model-control/application/services/activate-model-inventory.js";
import { ChangeSiteModelPolicyService } from
  "../modules/model-control/application/services/change-site-model-policy.js";
import { PostgresModelControlRepository } from
  "../modules/model-control/infrastructure/postgres/model-control-repository.js";
import { PostgresModelControlCommandJournal } from "../modules/model-control/infrastructure/postgres/model-control-command-journal.js";
import { PostgresProductModelOptionRepository } from "../modules/model-control/infrastructure/postgres/product-model-option-repository.js";
import { PlatformUnitOfWork } from "../shared/unit-of-work/index.js";

export interface ProductModelOptionAdministrationComposition {
  readonly importInventory: ImportModelControlService;
  readonly activateInventory: ActivateModelInventoryService;
  readonly changeSitePolicy: ChangeSiteModelPolicyService;
  readonly materialize: MaterializeModelOptionsService;
  readonly publishSiteRelease: PublishSiteReleaseModelCatalogService;
}

/** Production Admin composition. The caller owns connect/disconnect and the signed context. */
export function createProductModelOptionAdministrationComposition(
  database: PlatformTransactionalDatabaseClient,
  options: Readonly<{ now?: () => string }> = {},
): ProductModelOptionAdministrationComposition {
  const unitOfWork = new PlatformUnitOfWork(database);
  const repository = new PostgresProductModelOptionRepository();
  const journal = new PostgresModelControlCommandJournal();
  const controlRepository = new PostgresModelControlRepository();
  return Object.freeze({
    importInventory: new ImportModelControlService(unitOfWork, controlRepository, journal),
    activateInventory: new ActivateModelInventoryService(unitOfWork, controlRepository, journal),
    changeSitePolicy: new ChangeSiteModelPolicyService(unitOfWork, controlRepository, journal),
    materialize: new MaterializeModelOptionsService(unitOfWork, repository, journal),
    publishSiteRelease: new PublishSiteReleaseModelCatalogService(
      unitOfWork,
      repository,
      journal,
      options,
    ),
  });
}
