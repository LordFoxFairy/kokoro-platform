import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/index.js";
import { projectProductModelOptionCatalogs } from "../../domain/product-model-option.js";
import type {
  ModelOptionCatalogRepository,
  ProductModelOptionCatalogApplication,
} from "../contracts/product-model-option-ports.js";

export class ReadProductModelOptionCatalogsService
  implements ProductModelOptionCatalogApplication
{
  constructor(
    private readonly unitOfWork: PlatformUnitOfWork,
    private readonly repository: ModelOptionCatalogRepository,
  ) {}

  readForProductContext(
    input: Parameters<ProductModelOptionCatalogApplication["readForProductContext"]>[0],
    context: VerifiedRequestSecurityContext,
  ): ReturnType<ProductModelOptionCatalogApplication["readForProductContext"]> {
    if (
      context.trustedCaller.kind !== "site_product" ||
      context.trustedCaller.siteId !== input.siteId ||
      context.target.siteId !== input.siteId
    )
      return Promise.reject(new Error("MODEL_OPTION_PRODUCT_CONTEXT_SITE_MISMATCH"));
    return this.unitOfWork.execute(
      { context, operation: "model.option-catalog.read" },
      async (transaction) => {
        const snapshot = await this.repository.loadProductCatalogSnapshot(transaction, input);
        if (
          !snapshot ||
          snapshot.release.siteId !== input.siteId ||
          snapshot.release.siteReleaseRef !== input.siteReleaseRef
        )
          throw new Error("MODEL_OPTION_RELEASE_CATALOG_NOT_FOUND");
        return projectProductModelOptionCatalogs(snapshot);
      },
    );
  }
}
