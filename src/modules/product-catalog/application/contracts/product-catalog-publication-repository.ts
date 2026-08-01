import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type {
  ImmutableRevisionBinding,
  PublishedLaunchProductProfileRevision,
  PublishedProductSurfaceCatalogRevision,
  PublicationStateSnapshot,
} from "../../domain/product-publication.js";

export interface ProductPublicationAuditFacts {
  readonly commandId: string;
  readonly operation: "product.catalog.publish" | "product.launch-profile.publish";
  readonly reason: string;
  readonly actorSubjectId: string;
  readonly environment: string;
  readonly region: string;
  readonly expectedHeadRevision: bigint;
  readonly replayed: boolean;
}

export interface ProductCatalogPublicationRepository {
  loadCatalogStateForUpdate(
    transaction: PlatformTransaction,
    binding: ImmutableRevisionBinding,
  ): Promise<PublicationStateSnapshot<PublishedProductSurfaceCatalogRevision>>;
  loadProfileStateForUpdate(
    transaction: PlatformTransaction,
    binding: ImmutableRevisionBinding,
  ): Promise<PublicationStateSnapshot<PublishedLaunchProductProfileRevision>>;
  loadPublishedCatalog(
    transaction: PlatformTransaction,
    binding: ImmutableRevisionBinding,
  ): Promise<PublishedProductSurfaceCatalogRevision | null>;
  persistCatalog(
    transaction: PlatformTransaction,
    revision: PublishedProductSurfaceCatalogRevision,
    audit: ProductPublicationAuditFacts,
  ): Promise<void>;
  persistProfile(
    transaction: PlatformTransaction,
    revision: PublishedLaunchProductProfileRevision,
    audit: ProductPublicationAuditFacts,
  ): Promise<void>;
  recordReplay(
    transaction: PlatformTransaction,
    binding: ImmutableRevisionBinding,
    catalogBinding: ImmutableRevisionBinding | null,
    audit: ProductPublicationAuditFacts,
  ): Promise<void>;
}
