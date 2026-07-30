import type { AdminQueryPermit } from
  "../../../admin/interfaces/connect/admin-query-service.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";

export interface ModelControlAdminQueryHost {
  adminQueryTransaction<Result>(permit: AdminQueryPermit,
    work: (transaction: PlatformTransaction) => Promise<Result>): Promise<Result>;
  adminSiteQueryTransaction<Result>(permit: AdminQueryPermit, siteRef: string,
    work: (transaction: PlatformTransaction) => Promise<Result>): Promise<Result>;
}

export interface AdminModelInventoryRevision {
  readonly inventoryDigest: string; readonly sourceReference: string;
  readonly counts: Readonly<{ providers: number; models: number; bindings: number; productRoutes: number }>;
  readonly importedAt: string; readonly active: boolean; readonly activePointerRevision: string | null;
}
export interface AdminModelProvider {
  readonly providerKey: string; readonly provider: string; readonly accountKey: string;
  readonly adapterKind: "litellm" | "direct"; readonly priority: number;
  readonly secretReferencePresent: boolean; readonly status: "active" | "disabled";
  readonly health: "unknown" | "healthy" | "degraded" | "down";
  readonly availabilityEpoch: string; readonly observedAt: string | null;
}
export interface AdminModelDefinition {
  readonly modelKey: string; readonly displayName: string; readonly inputModalities: readonly string[];
  readonly outputModalities: readonly string[]; readonly capabilities: readonly string[];
  readonly contextWindow: number | null; readonly enabled: boolean;
}
export interface AdminModelBinding {
  readonly bindingKey: string; readonly modelKey: string; readonly providerKey: string;
  readonly upstreamModel: string; readonly gatewayModelName: string; readonly priority: number;
  readonly enabled: boolean;
}
export interface AdminModelProductRoute {
  readonly product: "chat" | "music" | "image" | "video";
  readonly role: "main" | "generation"; readonly modelKey: string; readonly position: number;
  readonly requiredCapabilities: readonly string[];
}
export interface AdminModelOption {
  readonly revisionRef: string; readonly inventoryDigest: string; readonly optionKey: string;
  readonly surface: "chat" | "music" | "image" | "video"; readonly label: string;
  readonly description: string | null; readonly tier: string | null;
  readonly lifecycle: "active" | "disabled"; readonly inputModalities: readonly string[];
  readonly outputModalities: readonly string[]; readonly supportedEfforts: readonly string[];
  readonly badges: readonly string[]; readonly createdAt: string;
}
export interface AdminSiteModelPolicy {
  readonly siteId: string; readonly product: "chat" | "music" | "image" | "video";
  readonly revision: string; readonly policyDigest: string; readonly enabled: boolean;
  readonly catalogMode: "follow_active" | "pinned"; readonly catalogDigest: string | null;
  readonly assignmentMode: "inherit" | "replace"; readonly assignmentCount: number;
  readonly current: boolean; readonly changedAt: string;
}
export interface AdminSiteReleaseCatalog {
  readonly siteId: string; readonly siteReleaseRef: string; readonly modelOptionCatalogRef: string;
  readonly catalogDigest: string; readonly inventoryDigest: string; readonly surfaceCount: number;
  readonly publishedAt: string;
}
export interface AdminReadPage<Item> { readonly items: readonly Item[]; readonly asOf: string }

export class PostgresModelControlAdminReader {
  constructor(private readonly host: ModelControlAdminQueryHost) {}

  listInventoryRevisions(permit: AdminQueryPermit, page: Readonly<{
    before: Readonly<{ importedAt: string; inventoryDigest: string }> | null;
    limit: number; asOf: string | null;
  }>): Promise<AdminReadPage<AdminModelInventoryRevision>> {
    requireGlobal(permit, "model.inventory.read");
    return this.host.adminQueryTransaction(permit, async (transaction) => {
      const asOf = await watermark(transaction, page.asOf);
      const rows = await resolvePlatformTransaction(transaction).query<InventoryRow>(
        `SELECT imported.source_digest AS "inventoryDigest",imported.source_reference AS "sourceReference",
                imported.counts,imported.imported_at AS "importedAt",
                pointer.import_id IS NOT NULL AS active,pointer.revision AS "activePointerRevision"
         FROM platform.model_inventory_import imported
         LEFT JOIN platform.model_inventory_pointer pointer ON pointer.import_id=imported.import_id
         WHERE imported.imported_at<=$1::timestamptz
           AND ($2::timestamptz IS NULL OR (imported.imported_at,imported.source_digest)<($2::timestamptz,$3::text))
         ORDER BY imported.imported_at DESC,imported.source_digest DESC LIMIT $4`,
        [asOf, page.before?.importedAt ?? null, page.before?.inventoryDigest ?? "", page.limit],
      );
      return Object.freeze({ items: Object.freeze(rows.map(inventory)), asOf });
    });
  }

  getInventoryRevision(permit: AdminQueryPermit, inventoryDigest: string) {
    requireGlobal(permit, "model.inventory.read"); digest(inventoryDigest);
    return this.host.adminQueryTransaction(permit, async (transaction) => {
      const asOf = await watermark(transaction, null);
      const rows = await resolvePlatformTransaction(transaction).query<InventoryRow>(
        `SELECT imported.source_digest AS "inventoryDigest",imported.source_reference AS "sourceReference",
                imported.counts,imported.imported_at AS "importedAt",
                pointer.import_id IS NOT NULL AS active,pointer.revision AS "activePointerRevision"
         FROM platform.model_inventory_import imported
         LEFT JOIN platform.model_inventory_pointer pointer ON pointer.import_id=imported.import_id
         WHERE imported.source_digest=$1 AND imported.imported_at<=$2::timestamptz LIMIT 1`,
        [inventoryDigest, asOf],
      );
      return Object.freeze({ item: rows[0] === undefined ? null : inventory(rows[0]), asOf });
    });
  }

  listInventoryProviders(permit: AdminQueryPermit, inventoryDigest: string, page: Readonly<{
    afterProviderKey: string | null; limit: number; asOf: string | null;
  }>): Promise<AdminReadPage<AdminModelProvider>> {
    requireGlobal(permit, "model.inventory.read"); digest(inventoryDigest);
    return this.host.adminQueryTransaction(permit, async (transaction) => {
      const asOf = await watermark(transaction, page.asOf);
      const rows = await resolvePlatformTransaction(transaction).query<ProviderRow>(
        `SELECT provider.provider_key AS "providerKey",provider.provider,provider.account_key AS "accountKey",
                provider.adapter_kind AS "adapterKind",provider.priority,
                provider.secret_ref IS NOT NULL AS "secretReferencePresent",
                COALESCE(availability.status,'disabled') AS status,
                COALESCE(availability.health,'unknown') AS health,
                COALESCE(availability.epoch,0) AS "availabilityEpoch",availability.observed_at AS "observedAt"
         FROM platform.model_provider_snapshot provider
         JOIN platform.model_inventory_import imported ON imported.import_id=provider.import_id
         LEFT JOIN platform.model_provider_availability availability ON availability.provider_key=provider.provider_key
         WHERE imported.source_digest=$1 AND provider.provider_key>$2
           AND imported.imported_at<=$3::timestamptz
         ORDER BY provider.provider_key ASC LIMIT $4`,
        [inventoryDigest, page.afterProviderKey ?? "", asOf, page.limit],
      );
      return Object.freeze({ items: Object.freeze(rows.map(provider)), asOf });
    });
  }

  listInventoryModels(permit: AdminQueryPermit, inventoryDigest: string, page: Readonly<{
    afterModelKey: string | null; limit: number; asOf: string | null;
  }>): Promise<AdminReadPage<AdminModelDefinition>> {
    requireGlobal(permit, "model.inventory.read"); digest(inventoryDigest);
    return this.host.adminQueryTransaction(permit, async (transaction) => {
      const asOf = await watermark(transaction, page.asOf);
      const rows = await resolvePlatformTransaction(transaction).query<ModelRow>(
        `SELECT model.model_key AS "modelKey",model.display_name AS "displayName",
                model.input_modalities AS "inputModalities",model.output_modalities AS "outputModalities",
                model.capabilities,model.context_window AS "contextWindow",model.enabled
         FROM platform.model_definition_snapshot model
         JOIN platform.model_inventory_import imported ON imported.import_id=model.import_id
         WHERE imported.source_digest=$1 AND model.model_key>$2 AND imported.imported_at<=$3::timestamptz
         ORDER BY model.model_key ASC LIMIT $4`,
        [inventoryDigest, page.afterModelKey ?? "", asOf, page.limit],
      );
      return Object.freeze({ items: Object.freeze(rows.map(model)), asOf });
    });
  }

  listInventoryBindings(permit: AdminQueryPermit, inventoryDigest: string, page: Readonly<{
    afterBindingKey: string | null; limit: number; asOf: string | null;
  }>): Promise<AdminReadPage<AdminModelBinding>> {
    requireGlobal(permit, "model.inventory.read"); digest(inventoryDigest);
    return this.host.adminQueryTransaction(permit, async (transaction) => {
      const asOf = await watermark(transaction, page.asOf);
      const rows = await resolvePlatformTransaction(transaction).query<BindingRow>(
        `SELECT binding.binding_key AS "bindingKey",binding.model_key AS "modelKey",
                binding.provider_key AS "providerKey",binding.upstream_model AS "upstreamModel",
                binding.gateway_model_name AS "gatewayModelName",binding.priority,binding.enabled
         FROM platform.model_provider_binding_snapshot binding
         JOIN platform.model_inventory_import imported ON imported.import_id=binding.import_id
         WHERE imported.source_digest=$1 AND binding.binding_key>$2 AND imported.imported_at<=$3::timestamptz
         ORDER BY binding.binding_key ASC LIMIT $4`,
        [inventoryDigest, page.afterBindingKey ?? "", asOf, page.limit],
      );
      return Object.freeze({ items: Object.freeze(rows.map(binding)), asOf });
    });
  }

  listInventoryProductRoutes(permit: AdminQueryPermit, inventoryDigest: string, page: Readonly<{
    after: Readonly<{ product: string; role: string; position: number; modelKey: string }> | null;
    limit: number; asOf: string | null;
  }>): Promise<AdminReadPage<AdminModelProductRoute>> {
    requireGlobal(permit, "model.inventory.read"); digest(inventoryDigest);
    return this.host.adminQueryTransaction(permit, async (transaction) => {
      const asOf = await watermark(transaction, page.asOf);
      const rows = await resolvePlatformTransaction(transaction).query<RouteRow>(
        `SELECT route.product,route.route_role AS role,route.model_key AS "modelKey",route.position,
                route.required_capabilities AS "requiredCapabilities"
         FROM platform.model_product_route_snapshot route
         JOIN platform.model_inventory_import imported ON imported.import_id=route.import_id
         WHERE imported.source_digest=$1 AND imported.imported_at<=$2::timestamptz
           AND ($3::text IS NULL OR (route.product,route.route_role,route.position,route.model_key)>
             ($3::text,$4::text,$5::integer,$6::text))
         ORDER BY route.product,route.route_role,route.position,route.model_key LIMIT $7`,
        [inventoryDigest, asOf, page.after?.product ?? null, page.after?.role ?? "",
          page.after?.position ?? 0, page.after?.modelKey ?? "", page.limit],
      );
      return Object.freeze({ items: Object.freeze(rows.map(route)), asOf });
    });
  }

  listModelOptions(permit: AdminQueryPermit, filter: Readonly<{
    inventoryDigest: string | null; surface: string | null;
  }>, page: Readonly<{
    before: Readonly<{ createdAt: string; revisionRef: string }> | null;
    limit: number; asOf: string | null;
  }>): Promise<AdminReadPage<AdminModelOption>> {
    requireGlobal(permit, "model.option.read");
    if (filter.inventoryDigest !== null) digest(filter.inventoryDigest);
    return this.host.adminQueryTransaction(permit, async (transaction) => {
      const asOf = await watermark(transaction, page.asOf);
      const rows = await resolvePlatformTransaction(transaction).query<OptionRow>(
        `SELECT option.revision_ref AS "revisionRef",option.inventory_digest AS "inventoryDigest",
                option.option_key AS "optionKey",option.surface,option.label,option.description,option.tier,
                option.lifecycle,option.input_modalities AS "inputModalities",
                option.output_modalities AS "outputModalities",option.supported_efforts AS "supportedEfforts",
                option.badges,option.created_at AS "createdAt"
         FROM platform.model_option_revision option
         WHERE option.created_at<=$1::timestamptz
           AND ($2::text IS NULL OR option.inventory_digest=$2)
           AND ($3::text IS NULL OR option.surface=$3)
           AND ($4::timestamptz IS NULL OR (option.created_at,option.revision_ref)<($4::timestamptz,$5::text))
         ORDER BY option.created_at DESC,option.revision_ref DESC LIMIT $6`,
        [asOf, filter.inventoryDigest, filter.surface, page.before?.createdAt ?? null,
          page.before?.revisionRef ?? "", page.limit],
      );
      return Object.freeze({ items: Object.freeze(rows.map(option)), asOf });
    });
  }

  listSiteModelPolicies(permit: AdminQueryPermit, siteId: string, page: Readonly<{
    before: Readonly<{ changedAt: string; product: string; revision: string }> | null;
    limit: number; asOf: string | null;
  }>): Promise<AdminReadPage<AdminSiteModelPolicy>> {
    requireSite(permit, siteId, "model.site-policy.read");
    return this.host.adminSiteQueryTransaction(permit, siteId, async (transaction) => {
      const asOf = await watermark(transaction, page.asOf);
      const rows = await resolvePlatformTransaction(transaction).query<PolicyRow>(
        `SELECT policy.site_id AS "siteId",policy.product,policy.revision,policy.policy_digest AS "policyDigest",
                policy.enabled,policy.catalog_mode AS "catalogMode",policy.catalog_digest AS "catalogDigest",
                policy.assignment_mode AS "assignmentMode",count(assignment.*)::integer AS "assignmentCount",
                COALESCE(pointer.revision=policy.revision,FALSE) AS current,
                policy.changed_at AS "changedAt"
         FROM platform.model_site_policy_revision policy
         LEFT JOIN platform.model_site_assignment_revision assignment
           ON assignment.site_id=policy.site_id AND assignment.product=policy.product
             AND assignment.policy_revision=policy.revision
         LEFT JOIN platform.model_site_policy_pointer pointer
           ON pointer.site_id=policy.site_id AND pointer.product=policy.product
         WHERE policy.site_id=$1 AND policy.changed_at<=$2::timestamptz
           AND ($3::timestamptz IS NULL OR (policy.changed_at,policy.product,policy.revision)<
             ($3::timestamptz,$4::text,$5::bigint))
         GROUP BY policy.site_id,policy.product,policy.revision,policy.policy_digest,policy.enabled,
           policy.catalog_mode,policy.catalog_digest,policy.assignment_mode,pointer.revision,policy.changed_at
         ORDER BY policy.changed_at DESC,policy.product DESC,policy.revision DESC LIMIT $6`,
        [siteId, asOf, page.before?.changedAt ?? null, page.before?.product ?? "",
          page.before?.revision ?? "0", page.limit],
      );
      return Object.freeze({ items: Object.freeze(rows.map(policy)), asOf });
    });
  }

  listSiteReleaseCatalogs(permit: AdminQueryPermit, siteId: string, page: Readonly<{
    before: Readonly<{ publishedAt: string; modelOptionCatalogRef: string }> | null;
    limit: number; asOf: string | null;
  }>): Promise<AdminReadPage<AdminSiteReleaseCatalog>> {
    requireSite(permit, siteId, "model.site-release-catalog.read");
    return this.host.adminSiteQueryTransaction(permit, siteId, async (transaction) => {
      const asOf = await watermark(transaction, page.asOf);
      const rows = await resolvePlatformTransaction(transaction).query<CatalogRow>(
        `SELECT publication.site_id AS "siteId",publication.site_release_ref AS "siteReleaseRef",
                publication.model_option_catalog_ref AS "modelOptionCatalogRef",
                publication.catalog_digest AS "catalogDigest",publication.inventory_digest AS "inventoryDigest",
                count(surface.*)::integer AS "surfaceCount",publication.published_at AS "publishedAt"
         FROM platform.site_release_model_catalog_publication publication
         LEFT JOIN platform.site_release_model_catalog_surface surface
           ON surface.publication_id=publication.publication_id
         WHERE publication.site_id=$1 AND publication.published_at<=$2::timestamptz
           AND ($3::timestamptz IS NULL OR (publication.published_at,publication.model_option_catalog_ref)<
             ($3::timestamptz,$4::text))
         GROUP BY publication.publication_id
         ORDER BY publication.published_at DESC,publication.model_option_catalog_ref DESC LIMIT $5`,
        [siteId, asOf, page.before?.publishedAt ?? null,
          page.before?.modelOptionCatalogRef ?? "", page.limit],
      );
      return Object.freeze({ items: Object.freeze(rows.map(catalog)), asOf });
    });
  }
}

async function watermark(transaction: PlatformTransaction, requested: string | null): Promise<string> {
  if (requested !== null) instant(requested);
  const rows = await resolvePlatformTransaction(transaction).query<{ asOf: unknown }>(
    `SELECT COALESCE($1::timestamptz,transaction_timestamp()) AS "asOf"`, [requested],
  );
  if (rows.length !== 1) throw new Error("MODEL_ADMIN_WATERMARK_INVALID");
  return instant(rows[0]!.asOf);
}

function requireGlobal(permit: AdminQueryPermit, operation: AdminQueryPermit["operation"]): void {
  if (permit.operation !== operation || permit.scope.kind !== "global") {
    throw new Error("MODEL_ADMIN_GLOBAL_SCOPE_REQUIRED");
  }
}
function requireSite(permit: AdminQueryPermit, siteId: string,
  operation: AdminQueryPermit["operation"]): void {
  if (permit.operation !== operation || (permit.scope.kind === "site" && !permit.scope.siteRefs.includes(siteId)) ||
      (permit.scope.kind === "breakglass" && !permit.scope.resourceRefs.includes(siteId))) {
    throw new Error("MODEL_ADMIN_SITE_SCOPE_DENIED");
  }
}

type InventoryRow = Record<string, unknown> & { inventoryDigest: unknown; sourceReference: unknown;
  counts: unknown; importedAt: unknown; active: unknown; activePointerRevision: unknown };
type ProviderRow = Record<string, unknown> & { providerKey: unknown; provider: unknown; accountKey: unknown;
  adapterKind: unknown; priority: unknown; secretReferencePresent: unknown; status: unknown; health: unknown;
  availabilityEpoch: unknown; observedAt: unknown };
type ModelRow = Record<string, unknown> & { modelKey: unknown; displayName: unknown; inputModalities: unknown;
  outputModalities: unknown; capabilities: unknown; contextWindow: unknown; enabled: unknown };
type BindingRow = Record<string, unknown> & { bindingKey: unknown; modelKey: unknown; providerKey: unknown;
  upstreamModel: unknown; gatewayModelName: unknown; priority: unknown; enabled: unknown };
type RouteRow = Record<string, unknown> & { product: unknown; role: unknown; modelKey: unknown;
  position: unknown; requiredCapabilities: unknown };
type OptionRow = Record<string, unknown> & { revisionRef: unknown; inventoryDigest: unknown; optionKey: unknown;
  surface: unknown; label: unknown; description: unknown; tier: unknown; lifecycle: unknown;
  inputModalities: unknown; outputModalities: unknown; supportedEfforts: unknown; badges: unknown; createdAt: unknown };
type PolicyRow = Record<string, unknown> & { siteId: unknown; product: unknown; revision: unknown;
  policyDigest: unknown; enabled: unknown; catalogMode: unknown; catalogDigest: unknown;
  assignmentMode: unknown; assignmentCount: unknown; current: unknown; changedAt: unknown };
type CatalogRow = Record<string, unknown> & { siteId: unknown; siteReleaseRef: unknown;
  modelOptionCatalogRef: unknown; catalogDigest: unknown; inventoryDigest: unknown;
  surfaceCount: unknown; publishedAt: unknown };

function inventory(row: InventoryRow): AdminModelInventoryRevision {
  const counts = record(row.counts); const result = {
    inventoryDigest: digest(row.inventoryDigest), sourceReference: text(row.sourceReference, 512),
    counts: Object.freeze({ providers: integer(counts.providers), models: integer(counts.models),
      bindings: integer(counts.bindings), productRoutes: integer(counts.productRoutes) }),
    importedAt: instant(row.importedAt), active: bool(row.active),
    activePointerRevision: row.activePointerRevision === null ? null : uint64(row.activePointerRevision),
  }; return Object.freeze(result);
}
function provider(row: ProviderRow): AdminModelProvider { return Object.freeze({
  providerKey: identifier(row.providerKey), provider: identifier(row.provider), accountKey: identifier(row.accountKey),
  adapterKind: oneOf(row.adapterKind, ["litellm", "direct"] as const), priority: position(row.priority),
  secretReferencePresent: bool(row.secretReferencePresent), status: oneOf(row.status, ["active", "disabled"] as const),
  health: oneOf(row.health, ["unknown", "healthy", "degraded", "down"] as const),
  availabilityEpoch: uint64(row.availabilityEpoch), observedAt: row.observedAt === null ? null : instant(row.observedAt),
}); }
function model(row: ModelRow): AdminModelDefinition { return Object.freeze({
  modelKey: identifier(row.modelKey), displayName: text(row.displayName, 512),
  inputModalities: identifiers(row.inputModalities), outputModalities: identifiers(row.outputModalities),
  capabilities: identifiers(row.capabilities), contextWindow: row.contextWindow === null ? null : positiveInteger(row.contextWindow),
  enabled: bool(row.enabled),
}); }
function binding(row: BindingRow): AdminModelBinding { return Object.freeze({
  bindingKey: identifier(row.bindingKey), modelKey: identifier(row.modelKey), providerKey: identifier(row.providerKey),
  upstreamModel: text(row.upstreamModel, 512), gatewayModelName: text(row.gatewayModelName, 256),
  priority: position(row.priority), enabled: bool(row.enabled),
}); }
function route(row: RouteRow): AdminModelProductRoute { return Object.freeze({
  product: product(row.product), role: oneOf(row.role, ["main", "generation"] as const),
  modelKey: identifier(row.modelKey), position: position(row.position),
  requiredCapabilities: identifiers(row.requiredCapabilities),
}); }
function option(row: OptionRow): AdminModelOption { return Object.freeze({
  revisionRef: text(row.revisionRef, 256), inventoryDigest: digest(row.inventoryDigest),
  optionKey: identifier(row.optionKey), surface: product(row.surface), label: text(row.label, 160),
  description: row.description === null ? null : text(row.description, 512),
  tier: row.tier === null ? null : text(row.tier, 64),
  lifecycle: oneOf(row.lifecycle, ["active", "disabled"] as const),
  inputModalities: identifiers(row.inputModalities), outputModalities: identifiers(row.outputModalities),
  supportedEfforts: identifiers(row.supportedEfforts), badges: identifiers(row.badges), createdAt: instant(row.createdAt),
}); }
function policy(row: PolicyRow): AdminSiteModelPolicy { return Object.freeze({
  siteId: text(row.siteId, 128), product: product(row.product), revision: uint64(row.revision),
  policyDigest: digest(row.policyDigest), enabled: bool(row.enabled),
  catalogMode: oneOf(row.catalogMode, ["follow_active", "pinned"] as const),
  catalogDigest: row.catalogDigest === null ? null : digest(row.catalogDigest),
  assignmentMode: oneOf(row.assignmentMode, ["inherit", "replace"] as const),
  assignmentCount: integer(row.assignmentCount), current: bool(row.current), changedAt: instant(row.changedAt),
}); }
function catalog(row: CatalogRow): AdminSiteReleaseCatalog { return Object.freeze({
  siteId: text(row.siteId, 128), siteReleaseRef: text(row.siteReleaseRef, 256),
  modelOptionCatalogRef: text(row.modelOptionCatalogRef, 256), catalogDigest: digest(row.catalogDigest),
  inventoryDigest: digest(row.inventoryDigest), surfaceCount: integer(row.surfaceCount), publishedAt: instant(row.publishedAt),
}); }

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("MODEL_ADMIN_ROW_INVALID");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || hasControl(value))
    throw new Error("MODEL_ADMIN_ROW_INVALID");
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(value))
    throw new Error("MODEL_ADMIN_ROW_INVALID");
  return value;
}
function identifiers(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error("MODEL_ADMIN_ROW_INVALID");
  return Object.freeze(value.map(identifier));
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error("MODEL_ADMIN_ROW_INVALID");
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 2_147_483_647)
    throw new Error("MODEL_ADMIN_ROW_INVALID");
  return value;
}
function positiveInteger(value: unknown): number { const result = integer(value); if (result === 0) throw new Error("MODEL_ADMIN_ROW_INVALID"); return result; }
function position(value: unknown): number { const result = integer(value); if (result > 10_000) throw new Error("MODEL_ADMIN_ROW_INVALID"); return result; }
function bool(value: unknown): boolean { if (typeof value !== "boolean") throw new Error("MODEL_ADMIN_ROW_INVALID"); return value; }
function uint64(value: unknown): string {
  const textValue = typeof value === "bigint" ? value.toString() : typeof value === "string" ? value : "";
  if (!/^(?:0|[1-9][0-9]*)$/u.test(textValue) || BigInt(textValue) > 9223372036854775807n)
    throw new Error("MODEL_ADMIN_ROW_INVALID");
  return textValue;
}
function instant(value: unknown): string {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (date === null || !Number.isFinite(date.getTime())) throw new Error("MODEL_ADMIN_ROW_INVALID");
  return date.toISOString();
}
function product(value: unknown) { return oneOf(value, ["chat", "music", "image", "video"] as const); }
function oneOf<const Values extends readonly string[]>(value: unknown, values: Values): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new Error("MODEL_ADMIN_ROW_INVALID");
  return value as Values[number];
}
function hasControl(value: string): boolean { return [...value].some((character) => {
  const point = character.codePointAt(0)!; return point < 32 || point === 127;
}); }
