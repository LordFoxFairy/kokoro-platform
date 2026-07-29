import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type {
  CanonicalizedModelInventory,
  ModelProduct,
  ProviderAdapterKind,
} from "../../domain/model-catalog.js";
import type {
  ModelOptionRevision,
  ProductModelOptionCatalogProjection,
  SiteReleaseModelCatalogRevision,
} from "../../domain/product-model-option.js";
import type { LegacyModelOptionMigrationArtifact } from "../../migration/legacy-model-option-artifact.js";
import type { LegacyModelOptionMaterialization } from "../../migration/legacy-model-option-materializer.js";

export interface ModelOptionMaterializationReceipt {
  readonly materializationId: string;
  readonly artifactDigest: string;
  readonly inventoryDigest: string;
  readonly materializationDigest: string;
  readonly optionRevisionRefs: readonly string[];
  readonly quarantineCount: number;
  readonly replayed: boolean;
}

export interface SiteReleaseModelCatalogPublishReceipt {
  readonly publicationId: string;
  readonly siteId: string;
  readonly siteReleaseRef: string;
  readonly modelOptionCatalogRef: string;
  readonly catalogDigest: string;
  readonly replayed: boolean;
}

export interface ProductModelCatalogSnapshot {
  readonly release: SiteReleaseModelCatalogRevision;
  readonly optionRevisions: readonly ModelOptionRevision[];
  readonly runtimeAvailableModelKeys: readonly string[];
}

export interface AdmissionModelRuntimeCandidate {
  readonly modelKey: string;
  readonly modelPosition: number;
  readonly bindingKey: string;
  readonly bindingPriority: number;
  readonly providerPriority: number;
  readonly adapterKind: ProviderAdapterKind;
  readonly provider: string;
  readonly upstreamModel: string;
  readonly gatewayModelName: string;
}

export interface AdmissionModelSnapshot {
  readonly siteId: string;
  readonly siteReleaseRef: string;
  readonly inventoryDigest: string;
  readonly optionRevision: ModelOptionRevision;
  readonly runtimeCandidates: readonly AdmissionModelRuntimeCandidate[];
}

export interface AdmissionModelCatalogRepository {
  loadAdmissionModelSnapshot(
    transaction: PlatformTransaction,
    input: Readonly<{
      siteId: string;
      siteReleaseRef: string;
      modelOptionRevisionRef: string;
    }>,
  ): Promise<AdmissionModelSnapshot | null>;
}

export interface ModelOptionCatalogRepository {
  loadInventory(
    transaction: PlatformTransaction,
    inventoryDigest: string,
  ): Promise<CanonicalizedModelInventory | null>;
  materializeLegacyOptions(
    transaction: PlatformTransaction,
    input: {
      readonly materializationId: string;
      readonly materializedBy: string;
      readonly materialization: LegacyModelOptionMaterialization;
    },
  ): Promise<ModelOptionMaterializationReceipt>;
  loadOptionRevisions(
    transaction: PlatformTransaction,
    revisionRefs: readonly string[],
  ): Promise<readonly ModelOptionRevision[]>;
  publishSiteReleaseCatalog(
    transaction: PlatformTransaction,
    input: {
      readonly publicationId: string;
      readonly publishedBy: string;
      readonly catalog: SiteReleaseModelCatalogRevision;
    },
  ): Promise<SiteReleaseModelCatalogPublishReceipt>;
  loadProductCatalogSnapshot(
    transaction: PlatformTransaction,
    input: { readonly siteId: string; readonly siteReleaseRef: string },
  ): Promise<ProductModelCatalogSnapshot | null>;
}

export interface ModelOptionMaterializationAdministration {
  materialize(
    input: {
      readonly materializationId: string;
      readonly inventoryDigest: string;
      readonly artifact: LegacyModelOptionMigrationArtifact;
    },
    context: VerifiedRequestSecurityContext,
  ): Promise<ModelOptionMaterializationReceipt>;
}

export interface SiteReleaseModelCatalogAdministration {
  publish(
    input: {
      readonly publicationId: string;
      readonly siteId: string;
      readonly siteReleaseRef: string;
      readonly inventoryDigest: string;
      readonly publishedAt: string;
      readonly surfaces: readonly {
        readonly surfaceId: ModelProduct;
        readonly allowedModelOptionRevisionRefs: readonly string[];
        readonly defaultModelOptionRevisionRef: string;
      }[];
    },
    context: VerifiedRequestSecurityContext,
  ): Promise<SiteReleaseModelCatalogPublishReceipt>;
}

export interface ProductModelOptionCatalogApplication {
  readForProductContext(
    input: { readonly siteId: string; readonly siteReleaseRef: string },
    context: VerifiedRequestSecurityContext,
  ): Promise<ProductModelOptionCatalogProjection>;
}
