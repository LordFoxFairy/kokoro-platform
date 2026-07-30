import {
  canonicalizeModelInventory,
  type CanonicalizedModelInventory,
  type CanonicalModelInventory,
} from "../../domain/model-catalog.js";
import {
  projectProductModelOptionCatalogs,
  verifyModelOptionRevision,
  verifySiteReleaseModelCatalogRevision,
} from "../../domain/product-model-option.js";
import type {
  AdmissionModelCatalogRepository,
  AdmissionModelRuntimeCandidate,
  ModelOptionCatalogRepository,
  ModelOptionMaterializationReceipt,
  ProductModelCatalogSnapshot,
  SiteReleaseModelCatalogPublishReceipt,
} from "../../application/contracts/product-model-option-ports.js";
import type { ModelOptionCatalogReadPort } from "../../../authorization/application/contracts/session-authorization-ports.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";

export class PostgresProductModelOptionRepository
  implements ModelOptionCatalogRepository, AdmissionModelCatalogRepository {
  async loadInventory(
    transaction: Parameters<ModelOptionCatalogRepository["loadInventory"]>[0],
    inventoryDigest: string,
  ): Promise<CanonicalizedModelInventory | null> {
    const rows = await resolvePlatformTransaction(transaction).query<InventoryRow>(
      `SELECT result_canonical_payload AS "canonicalPayload"
       FROM platform.load_model_option_inventory($1::text)`,
      [inventoryDigest],
    );
    const row = rows[0];
    if (!row) return null;
    const inventory = canonicalizeModelInventory(row.canonicalPayload as CanonicalModelInventory);
    if (inventory.digest !== inventoryDigest) throw new Error("MODEL_OPTION_INVENTORY_DIGEST_MISMATCH");
    return inventory;
  }

  async materializeOptions(
    transaction: Parameters<ModelOptionCatalogRepository["materializeOptions"]>[0],
    input: Parameters<ModelOptionCatalogRepository["materializeOptions"]>[1],
  ): Promise<ModelOptionMaterializationReceipt> {
    const rows = await resolvePlatformTransaction(transaction).query<MaterializationRow>(
      `SELECT result_materialization_id AS "materializationId",
              result_source_digest AS "sourceDigest",
              result_inventory_digest AS "inventoryDigest",
              result_materialization_digest AS "materializationDigest",
              result_option_revision_refs AS "optionRevisionRefs", replayed
       FROM platform.materialize_model_options(
         $1::uuid,$2::text,$3::text,$4::text,$5::text,$6::jsonb,$7::text
       )`,
      [
        input.materializationId,
        input.materialization.sourceDigest,
        input.materialization.inventoryDigest,
        input.materialization.materializationDigest,
        input.materialization.compilerVersion,
        JSON.stringify(input.materialization.optionRevisions),
        input.materializedBy,
      ],
    );
    const receipt = rows[0];
    const expectedRefs = input.materialization.optionRevisions.map(
      ({ modelOptionRevisionRef }) => modelOptionRevisionRef,
    );
    if (
      !receipt ||
      receipt.materializationId !== input.materializationId ||
      receipt.sourceDigest !== input.materialization.sourceDigest ||
      receipt.inventoryDigest !== input.materialization.inventoryDigest ||
      receipt.materializationDigest !== input.materialization.materializationDigest ||
      typeof receipt.replayed !== "boolean" ||
      !sameStrings(receipt.optionRevisionRefs, expectedRefs)
    ) {
      throw new Error("MODEL_OPTION_MATERIALIZATION_RECEIPT_INVALID");
    }
    return receipt;
  }

  async loadOptionRevisions(
    transaction: Parameters<ModelOptionCatalogRepository["loadOptionRevisions"]>[0],
    revisionRefs: readonly string[],
  ) {
    if (revisionRefs.length === 0) return [];
    const rows = await resolvePlatformTransaction(transaction).query<OptionRevisionRow>(
      `SELECT result_revision_payload AS "revisionPayload"
       FROM platform.load_model_option_revisions($1::text[])`,
      [revisionRefs],
    );
    const revisions = rows.map((row) => verifyModelOptionRevision(row.revisionPayload));
    if (!sameStrings(revisions.map(({ modelOptionRevisionRef }) => modelOptionRevisionRef), revisionRefs)) {
      throw new Error("MODEL_OPTION_REVISION_SET_INCOMPLETE");
    }
    return revisions;
  }

  async publishSiteReleaseCatalog(
    transaction: Parameters<ModelOptionCatalogRepository["publishSiteReleaseCatalog"]>[0],
    input: Parameters<ModelOptionCatalogRepository["publishSiteReleaseCatalog"]>[1],
  ): Promise<SiteReleaseModelCatalogPublishReceipt> {
    const rows = await resolvePlatformTransaction(transaction).query<PublicationRow>(
      `SELECT result_publication_id AS "publicationId", result_site_id AS "siteId",
              result_site_release_ref AS "siteReleaseRef",
              result_model_option_catalog_ref AS "modelOptionCatalogRef",
              result_catalog_digest AS "catalogDigest", replayed
       FROM platform.publish_site_release_model_catalog($1::uuid,$2::jsonb,$3::text)`,
      [input.publicationId, JSON.stringify(input.catalog), input.publishedBy],
    );
    const receipt = rows[0];
    if (
      !receipt ||
      receipt.publicationId !== input.publicationId ||
      receipt.siteId !== input.catalog.siteId ||
      receipt.siteReleaseRef !== input.catalog.siteReleaseRef ||
      receipt.modelOptionCatalogRef !== input.catalog.modelOptionCatalogRef ||
      receipt.catalogDigest !== input.catalog.catalogDigest ||
      typeof receipt.replayed !== "boolean"
    ) {
      throw new Error("MODEL_OPTION_SITE_RELEASE_RECEIPT_INVALID");
    }
    return receipt;
  }

  async loadProductCatalogSnapshot(
    transaction: Parameters<ModelOptionCatalogRepository["loadProductCatalogSnapshot"]>[0],
    input: Parameters<ModelOptionCatalogRepository["loadProductCatalogSnapshot"]>[1],
  ): Promise<ProductModelCatalogSnapshot | null> {
    const rows = await resolvePlatformTransaction(transaction).query<ProductSnapshotRow>(
      `SELECT result_release_payload AS "releasePayload",
              result_option_revision_payloads AS "optionRevisionPayloads",
              result_runtime_available_model_keys AS "runtimeAvailableModelKeys"
       FROM platform.resolve_product_model_option_catalog($1::text,$2::text)`,
      [input.siteId, input.siteReleaseRef],
    );
    const row = rows[0];
    if (!row) return null;
    return Object.freeze({
      release: verifySiteReleaseModelCatalogRevision(row.releasePayload),
      optionRevisions: Object.freeze(
        array(row.optionRevisionPayloads).map(verifyModelOptionRevision),
      ),
      runtimeAvailableModelKeys: Object.freeze(strings(row.runtimeAvailableModelKeys)),
    });
  }

  async loadAdmissionModelSnapshot(
    transaction: Parameters<AdmissionModelCatalogRepository["loadAdmissionModelSnapshot"]>[0],
    input: Parameters<AdmissionModelCatalogRepository["loadAdmissionModelSnapshot"]>[1],
  ): ReturnType<AdmissionModelCatalogRepository["loadAdmissionModelSnapshot"]> {
    const rows = await resolvePlatformTransaction(transaction).query<AdmissionModelSnapshotRow>(
      `SELECT result_site_id AS "siteId",
              result_site_release_ref AS "siteReleaseRef",
              result_inventory_digest AS "inventoryDigest",
              result_option_revision_payload AS "optionRevisionPayload",
              result_runtime_candidates AS "runtimeCandidates"
         FROM platform.resolve_admission_model_owner($1::text,$2::text,$3::text)`,
      [input.siteId, input.siteReleaseRef, input.modelOptionRevisionRef],
    );
    const row = rows[0];
    if (row === undefined) return null;
    if (rows.length !== 1) throw new Error("ADMISSION_MODEL_SNAPSHOT_INVALID");
    return Object.freeze({
      siteId: requiredText(row.siteId),
      siteReleaseRef: requiredText(row.siteReleaseRef),
      inventoryDigest: digest(row.inventoryDigest),
      optionRevision: verifyModelOptionRevision(row.optionRevisionPayload),
      runtimeCandidates: Object.freeze(
        array(row.runtimeCandidates).map(parseAdmissionRuntimeCandidate),
      ),
    });
  }
}

/**
 * Authorization calls this local adapter inside its existing ProductContext transaction. Keeping
 * the transaction explicit prevents a nested UoW and keeps model-control operations out of the
 * public workload allowlist.
 */
export class PostgresProductModelOptionCatalogReader implements ModelOptionCatalogReadPort {
  constructor(
    private readonly repository: Pick<ModelOptionCatalogRepository, "loadProductCatalogSnapshot"> =
      new PostgresProductModelOptionRepository(),
  ) {}

  async readForProductContext(
    input: Parameters<ModelOptionCatalogReadPort["readForProductContext"]>[0],
    context: Parameters<ModelOptionCatalogReadPort["readForProductContext"]>[1],
    transaction: Parameters<ModelOptionCatalogReadPort["readForProductContext"]>[2],
  ): ReturnType<ModelOptionCatalogReadPort["readForProductContext"]> {
    if (
      context.trustedCaller.kind !== "site_product" ||
      context.trustedCaller.siteId !== input.siteId ||
      context.target.siteId !== input.siteId
    ) {
      throw new Error("MODEL_OPTION_PRODUCT_CONTEXT_SITE_MISMATCH");
    }
    const snapshot = await this.repository.loadProductCatalogSnapshot(transaction, input);
    if (
      snapshot === null ||
      snapshot.release.siteId !== input.siteId ||
      snapshot.release.siteReleaseRef !== input.siteReleaseRef
    ) {
      throw new Error("MODEL_OPTION_RELEASE_CATALOG_NOT_FOUND");
    }
    return projectProductModelOptionCatalogs(snapshot);
  }
}

interface InventoryRow extends Record<string, unknown> {
  canonicalPayload: unknown;
}
interface OptionRevisionRow extends Record<string, unknown> {
  revisionPayload: unknown;
}
interface ProductSnapshotRow extends Record<string, unknown> {
  releasePayload: unknown;
  optionRevisionPayloads: unknown;
  runtimeAvailableModelKeys: unknown;
}
interface AdmissionModelSnapshotRow extends Record<string, unknown> {
  siteId: unknown;
  siteReleaseRef: unknown;
  inventoryDigest: unknown;
  optionRevisionPayload: unknown;
  runtimeCandidates: unknown;
}
interface MaterializationRow extends Record<string, unknown>, ModelOptionMaterializationReceipt {}
interface PublicationRow extends Record<string, unknown>, SiteReleaseModelCatalogPublishReceipt {}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error("MODEL_OPTION_SNAPSHOT_INVALID");
  return value;
}

function strings(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(item)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("MODEL_OPTION_AVAILABILITY_INVALID");
  }
  return value;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseAdmissionRuntimeCandidate(value: unknown): AdmissionModelRuntimeCandidate {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ADMISSION_MODEL_RUNTIME_CANDIDATE_INVALID");
  }
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).sort().join(",") !==
      "adapterKind,bindingKey,bindingPriority,gatewayModelName,modelKey,modelPosition,provider,providerPriority,upstreamModel" ||
    !identifier(candidate.modelKey) || !identifier(candidate.bindingKey) ||
    !identifier(candidate.provider) || !boundedRuntimeName(candidate.upstreamModel) ||
    !boundedRuntimeName(candidate.gatewayModelName) ||
    !position(candidate.modelPosition) || !position(candidate.bindingPriority) ||
    !position(candidate.providerPriority) ||
    (candidate.adapterKind !== "litellm" && candidate.adapterKind !== "direct")
  ) throw new Error("ADMISSION_MODEL_RUNTIME_CANDIDATE_INVALID");
  return Object.freeze({
    modelKey: candidate.modelKey,
    modelPosition: candidate.modelPosition,
    bindingKey: candidate.bindingKey,
    bindingPriority: candidate.bindingPriority,
    providerPriority: candidate.providerPriority,
    adapterKind: candidate.adapterKind,
    provider: candidate.provider,
    upstreamModel: candidate.upstreamModel,
    gatewayModelName: candidate.gatewayModelName,
  });
}

function requiredText(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    throw new Error("ADMISSION_MODEL_SNAPSHOT_INVALID");
  }
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error("ADMISSION_MODEL_SNAPSHOT_INVALID");
  }
  return value;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(value);
}

function boundedRuntimeName(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 512 &&
    !Array.from(value).some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point < 32 || point === 127;
    });
}

function position(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000;
}
