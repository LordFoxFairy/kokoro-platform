import { PlatformUnitOfWork } from "../shared/unit-of-work/index.js";
import { ProductCatalogPublicationService } from
  "../modules/product-catalog/application/services/product-catalog-publication-service.js";
import type { ProductPublicationDocumentResolver } from
  "../modules/product-catalog/application/contracts/product-publication-document-resolver.js";
import { PostgresProductCatalogPublicationRepository } from
  "../modules/product-catalog/infrastructure/postgres/product-catalog-publication-repository.js";
import { PostgresProductCatalogPublicationJournal } from
  "../modules/product-catalog/infrastructure/postgres/product-catalog-publication-journal.js";
import type { PlatformTransactionalDatabaseClient } from
  "../infrastructure/postgres/client.js";

export function createProductCatalogAdministrationComposition(
  database: PlatformTransactionalDatabaseClient,
  documents: ProductPublicationDocumentResolver,
) {
  return new ProductCatalogPublicationService(
    new PlatformUnitOfWork(database),
    new PostgresProductCatalogPublicationRepository(),
    new PostgresProductCatalogPublicationJournal(),
    documents,
  );
}
