import { createHash } from "node:crypto";
import {
  modelProducts,
  type CanonicalizedModelInventory,
  type ModelProduct,
} from "./model-catalog.js";
import type { LegacyModelOptionMigrationArtifact } from "../migration/legacy-model-option-artifact.js";

export type ProductModelSurface = ModelProduct;
export type ModelOptionRoleKey =
  | "assistant.primary"
  | "music.assistant"
  | "music.generation"
  | "image.assistant"
  | "image.generation"
  | "video.assistant"
  | "video.generation";

export interface ModelOptionRoleBinding {
  readonly roleKey: ModelOptionRoleKey;
  readonly primaryModelKey: string;
  readonly fallbackModelKeys: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly fallbackPolicy: "ordered_pre_effect_only";
}

export interface ModelOptionRevision {
  readonly schemaVersion: 1;
  readonly modelOptionRevisionRef: string;
  readonly revisionDigest: string;
  readonly inventoryDigest: string;
  readonly optionKey: string;
  readonly surface: ProductModelSurface;
  readonly label: string;
  readonly description: string | null;
  readonly tier: string | null;
  readonly lifecycle: "active" | "disabled";
  readonly inputModalities: readonly string[];
  readonly outputModalities: readonly string[];
  readonly supportedEfforts: readonly string[];
  readonly badges: readonly string[];
  readonly composition: {
    readonly orchestration: ModelOptionRoleBinding;
    readonly generation: ModelOptionRoleBinding;
  };
}

export interface SiteReleaseModelSurfaceCatalogRevision {
  readonly surfaceId: ProductModelSurface;
  readonly catalogRevisionRef: string;
  readonly catalogDigest: string;
  readonly defaultModelOptionRevisionRef: string;
  readonly allowedModelOptionRevisionRefs: readonly string[];
}

export interface SiteReleaseModelCatalogRevision {
  readonly schemaVersion: 1;
  readonly modelOptionCatalogRef: string;
  readonly catalogDigest: string;
  readonly siteId: string;
  readonly siteReleaseRef: string;
  readonly inventoryDigest: string;
  readonly publishedAt: string;
  readonly surfaces: readonly SiteReleaseModelSurfaceCatalogRevision[];
}

export interface PublishedModelOption {
  readonly modelOptionRevisionRef: string;
  readonly optionKey: string;
  readonly label: string;
  readonly description?: string;
  readonly inputModalities: readonly string[];
  readonly outputModalities: readonly string[];
  readonly supportedEfforts: readonly string[];
  readonly badges: readonly string[];
  readonly availability: "available" | "temporarily_unavailable";
}

export interface SurfaceModelOptionCatalog {
  readonly surfaceId: ProductModelSurface;
  readonly catalogRevisionRef: string;
  readonly defaultModelOptionRevisionRef: string;
  readonly options: readonly PublishedModelOption[];
  readonly publishedAt: string;
}

export interface ProductModelOptionCatalogProjection {
  readonly modelOptionCatalogRef: string;
  readonly modelOptionCatalogs: readonly SurfaceModelOptionCatalog[];
}

type LegacyOption = LegacyModelOptionMigrationArtifact["options"][number];

export function compileModelOptionRevision(input: {
  readonly inventory: CanonicalizedModelInventory;
  readonly option: LegacyOption;
}): ModelOptionRevision {
  digest(input.inventory.digest, "MODEL_OPTION_INVENTORY_DIGEST_INVALID");
  const optionKey = publicOptionKey(input.option.key);
  const surface = product(input.option.product);
  const label = publicLabel(input.option.displayName);
  const description =
    input.option.description === null ? null : boundedText(input.option.description, 512);
  const tier = input.option.tier === null ? null : publicToken(input.option.tier, 64);
  const generation = compileGenerationBinding(input.inventory, input.option, surface);
  const orchestration =
    surface === "chat" ? generation : compileOrchestrationBinding(input.inventory, surface);
  const generationContract = publicGenerationContract(input.inventory, generation);
  const payload = deepFreeze({
    schemaVersion: 1 as const,
    inventoryDigest: input.inventory.digest,
    optionKey,
    surface,
    label,
    description,
    tier,
    lifecycle: input.option.enabled ? ("active" as const) : ("disabled" as const),
    inputModalities: generationContract.inputModalities,
    outputModalities: generationContract.outputModalities,
    supportedEfforts: generationContract.supportedEfforts,
    badges: tier === null ? [] : [tier],
    composition: { orchestration, generation },
  });
  const revisionDigest = sha256(stableJson(payload));
  return deepFreeze({
    ...payload,
    modelOptionRevisionRef: `model-option:sha256:${revisionDigest}`,
    revisionDigest,
  });
}

export function createSiteReleaseModelCatalogRevision(input: {
  readonly siteId: string;
  readonly siteReleaseRef: string;
  readonly inventoryDigest: string;
  readonly publishedAt: string;
  readonly surfaces: readonly {
    readonly surfaceId: ProductModelSurface;
    readonly allowedModelOptionRevisionRefs: readonly string[];
    readonly defaultModelOptionRevisionRef: string;
  }[];
  readonly optionRevisions: readonly ModelOptionRevision[];
}): SiteReleaseModelCatalogRevision {
  const siteId = identifier(input.siteId);
  const siteReleaseRef = boundedText(input.siteReleaseRef, 256);
  const inventoryDigest = digest(input.inventoryDigest, "MODEL_OPTION_INVENTORY_DIGEST_INVALID");
  const publishedAt = instant(input.publishedAt);
  const revisions = new Map(
    input.optionRevisions.map((candidate) => {
      const revision = verifyModelOptionRevision(candidate);
      return [revision.modelOptionRevisionRef, revision] as const;
    }),
  );
  if (revisions.size !== input.optionRevisions.length)
    throw new Error("MODEL_OPTION_REVISION_DUPLICATE");
  if (input.surfaces.length < 1 || input.surfaces.length > modelProducts.length)
    throw new Error("MODEL_OPTION_SURFACE_CATALOG_REQUIRED");

  const seenSurfaces = new Set<string>();
  const surfaces = input.surfaces.map((candidate) => {
    const surfaceId = product(candidate.surfaceId);
    if (seenSurfaces.has(surfaceId)) throw new Error("MODEL_OPTION_SURFACE_DUPLICATE");
    seenSurfaces.add(surfaceId);
    const allowedModelOptionRevisionRefs = candidate.allowedModelOptionRevisionRefs.map(
      modelOptionRevisionRef,
    );
    if (
      allowedModelOptionRevisionRefs.length < 1 ||
      allowedModelOptionRevisionRefs.length > 256 ||
      new Set(allowedModelOptionRevisionRefs).size !== allowedModelOptionRevisionRefs.length
    )
      throw new Error("MODEL_OPTION_ALLOWED_SET_INVALID");
    const defaultModelOptionRevisionRef = modelOptionRevisionRef(
      candidate.defaultModelOptionRevisionRef,
    );
    if (!allowedModelOptionRevisionRefs.includes(defaultModelOptionRevisionRef))
      throw new Error("MODEL_OPTION_DEFAULT_NOT_PUBLISHED");
    for (const revisionRef of allowedModelOptionRevisionRefs) {
      const revision = revisions.get(revisionRef);
      if (!revision) throw new Error("MODEL_OPTION_REVISION_NOT_FOUND");
      if (revision.surface !== surfaceId) throw new Error("MODEL_OPTION_SURFACE_MISMATCH");
      if (revision.inventoryDigest !== inventoryDigest)
        throw new Error("MODEL_OPTION_INVENTORY_MISMATCH");
      if (revision.lifecycle !== "active") throw new Error("MODEL_OPTION_NOT_ACTIVE");
    }
    const surfacePayload = deepFreeze({
      surfaceId,
      defaultModelOptionRevisionRef,
      allowedModelOptionRevisionRefs,
    });
    const catalogDigest = sha256(stableJson(surfacePayload));
    return deepFreeze({
      ...surfacePayload,
      catalogRevisionRef: `surface-model-catalog:${surfaceId}:sha256:${catalogDigest}`,
      catalogDigest,
    });
  });
  surfaces.sort(
    (left, right) => modelProducts.indexOf(left.surfaceId) - modelProducts.indexOf(right.surfaceId),
  );
  const payload = deepFreeze({
    schemaVersion: 1 as const,
    siteId,
    siteReleaseRef,
    inventoryDigest,
    publishedAt,
    surfaces,
  });
  const catalogDigest = sha256(stableJson(payload));
  return deepFreeze({
    ...payload,
    modelOptionCatalogRef: `site-release-model-catalog:sha256:${catalogDigest}`,
    catalogDigest,
  });
}

export function projectProductModelOptionCatalogs(input: {
  readonly release: SiteReleaseModelCatalogRevision;
  readonly optionRevisions: readonly ModelOptionRevision[];
  readonly runtimeAvailableModelKeys: readonly string[];
}): ProductModelOptionCatalogProjection {
  const release = verifySiteReleaseModelCatalogRevision(input.release);
  const revisions = new Map(
    input.optionRevisions.map((candidate) => {
      const revision = verifyModelOptionRevision(candidate);
      return [revision.modelOptionRevisionRef, revision] as const;
    }),
  );
  if (revisions.size !== input.optionRevisions.length)
    throw new Error("MODEL_OPTION_REVISION_DUPLICATE");
  const available = new Set(input.runtimeAvailableModelKeys.map(identifier));
  const modelOptionCatalogs = release.surfaces.map((surface) => {
    const options = surface.allowedModelOptionRevisionRefs.map((revisionRef) => {
      const revision = revisions.get(revisionRef);
      if (!revision) throw new Error("MODEL_OPTION_REVISION_NOT_FOUND");
      if (
        revision.surface !== surface.surfaceId ||
        revision.inventoryDigest !== release.inventoryDigest ||
        revision.lifecycle !== "active"
      )
        throw new Error("MODEL_OPTION_RELEASE_PROJECTION_INVALID");
      const availability = optionAvailable(revision, available)
        ? ("available" as const)
        : ("temporarily_unavailable" as const);
      return deepFreeze({
        modelOptionRevisionRef: revision.modelOptionRevisionRef,
        optionKey: revision.optionKey,
        label: revision.label,
        ...(revision.description === null ? {} : { description: revision.description }),
        inputModalities: revision.inputModalities,
        outputModalities: revision.outputModalities,
        supportedEfforts: revision.supportedEfforts,
        badges: revision.badges,
        availability,
      });
    });
    const defaultOption = options.find(
      (option) => option.modelOptionRevisionRef === surface.defaultModelOptionRevisionRef,
    );
    if (!defaultOption) throw new Error("MODEL_OPTION_DEFAULT_NOT_PUBLISHED");
    if (defaultOption.availability !== "available")
      throw new Error("MODEL_OPTION_DEFAULT_UNAVAILABLE");
    return deepFreeze({
      surfaceId: surface.surfaceId,
      catalogRevisionRef: surface.catalogRevisionRef,
      defaultModelOptionRevisionRef: surface.defaultModelOptionRevisionRef,
      options,
      publishedAt: release.publishedAt,
    });
  });
  return deepFreeze({
    modelOptionCatalogRef: release.modelOptionCatalogRef,
    modelOptionCatalogs,
  });
}

export function verifyModelOptionRevision(input: unknown): ModelOptionRevision {
  const value = strictRecord(
    input,
    [
      "schemaVersion",
      "modelOptionRevisionRef",
      "revisionDigest",
      "inventoryDigest",
      "optionKey",
      "surface",
      "label",
      "description",
      "tier",
      "lifecycle",
      "inputModalities",
      "outputModalities",
      "supportedEfforts",
      "badges",
      "composition",
    ],
    "MODEL_OPTION_REVISION_INVALID",
  );
  if (value.schemaVersion !== 1) throw new Error("MODEL_OPTION_REVISION_INVALID");
  const revisionDigest = digest(value.revisionDigest, "MODEL_OPTION_REVISION_INVALID");
  const composition = strictRecord(
    value.composition,
    ["orchestration", "generation"],
    "MODEL_OPTION_REVISION_INVALID",
  );
  const payload = deepFreeze({
    schemaVersion: 1 as const,
    inventoryDigest: digest(value.inventoryDigest, "MODEL_OPTION_REVISION_INVALID"),
    optionKey: publicOptionKey(value.optionKey),
    surface: product(value.surface),
    label: publicLabel(value.label),
    description: value.description === null ? null : boundedText(value.description, 512),
    tier: value.tier === null ? null : publicToken(value.tier, 64),
    lifecycle: lifecycle(value.lifecycle),
    inputModalities: publicTokens(unknownArray(value.inputModalities), true),
    outputModalities: publicTokens(unknownArray(value.outputModalities), true),
    supportedEfforts: publicTokens(unknownArray(value.supportedEfforts), false),
    badges: publicTokens(unknownArray(value.badges), false),
    composition: {
      orchestration: parseRoleBinding(composition.orchestration),
      generation: parseRoleBinding(composition.generation),
    },
  });
  assertSurfaceComposition(payload);
  if (sha256(stableJson(payload)) !== revisionDigest)
    throw new Error("MODEL_OPTION_REVISION_DIGEST_MISMATCH");
  const revisionRef = modelOptionRevisionRef(value.modelOptionRevisionRef);
  if (revisionRef !== `model-option:sha256:${revisionDigest}`)
    throw new Error("MODEL_OPTION_REVISION_REF_MISMATCH");
  return deepFreeze({ ...payload, modelOptionRevisionRef: revisionRef, revisionDigest });
}

export function verifySiteReleaseModelCatalogRevision(
  input: unknown,
): SiteReleaseModelCatalogRevision {
  const value = strictRecord(
    input,
    [
      "schemaVersion",
      "modelOptionCatalogRef",
      "catalogDigest",
      "siteId",
      "siteReleaseRef",
      "inventoryDigest",
      "publishedAt",
      "surfaces",
    ],
    "MODEL_OPTION_RELEASE_CATALOG_INVALID",
  );
  if (value.schemaVersion !== 1) throw new Error("MODEL_OPTION_RELEASE_CATALOG_INVALID");
  const surfaces = unknownArray(value.surfaces).map((candidate) => {
    const surface = strictRecord(
      candidate,
      [
        "surfaceId",
        "catalogRevisionRef",
        "catalogDigest",
        "defaultModelOptionRevisionRef",
        "allowedModelOptionRevisionRefs",
      ],
      "MODEL_OPTION_RELEASE_CATALOG_INVALID",
    );
    const surfaceId = product(surface.surfaceId);
    const allowedModelOptionRevisionRefs = unknownArray(
      surface.allowedModelOptionRevisionRefs,
    ).map(modelOptionRevisionRef);
    if (
      allowedModelOptionRevisionRefs.length < 1 ||
      new Set(allowedModelOptionRevisionRefs).size !== allowedModelOptionRevisionRefs.length
    )
      throw new Error("MODEL_OPTION_RELEASE_CATALOG_INVALID");
    const defaultModelOptionRevisionRef = modelOptionRevisionRef(
      surface.defaultModelOptionRevisionRef,
    );
    if (!allowedModelOptionRevisionRefs.includes(defaultModelOptionRevisionRef))
      throw new Error("MODEL_OPTION_DEFAULT_NOT_PUBLISHED");
    const surfacePayload = deepFreeze({
      surfaceId,
      defaultModelOptionRevisionRef,
      allowedModelOptionRevisionRefs,
    });
    const catalogDigest = digest(surface.catalogDigest, "MODEL_OPTION_RELEASE_CATALOG_INVALID");
    if (sha256(stableJson(surfacePayload)) !== catalogDigest)
      throw new Error("MODEL_OPTION_RELEASE_CATALOG_DIGEST_MISMATCH");
    const catalogRevisionRef = boundedText(surface.catalogRevisionRef, 256);
    if (catalogRevisionRef !== `surface-model-catalog:${surfaceId}:sha256:${catalogDigest}`)
      throw new Error("MODEL_OPTION_RELEASE_CATALOG_REF_MISMATCH");
    return deepFreeze({ ...surfacePayload, catalogRevisionRef, catalogDigest });
  });
  if (
    surfaces.length < 1 ||
    surfaces.length > modelProducts.length ||
    new Set(surfaces.map(({ surfaceId }) => surfaceId)).size !== surfaces.length ||
    surfaces.some(
      (surface, index) =>
        index > 0 &&
        modelProducts.indexOf(surfaces[index - 1]!.surfaceId) >=
          modelProducts.indexOf(surface.surfaceId),
    )
  )
    throw new Error("MODEL_OPTION_RELEASE_CATALOG_INVALID");
  const payload = deepFreeze({
    schemaVersion: 1 as const,
    siteId: identifier(value.siteId),
    siteReleaseRef: boundedText(value.siteReleaseRef, 256),
    inventoryDigest: digest(value.inventoryDigest, "MODEL_OPTION_RELEASE_CATALOG_INVALID"),
    publishedAt: instant(value.publishedAt),
    surfaces,
  });
  const catalogDigest = digest(value.catalogDigest, "MODEL_OPTION_RELEASE_CATALOG_INVALID");
  if (sha256(stableJson(payload)) !== catalogDigest)
    throw new Error("MODEL_OPTION_RELEASE_CATALOG_DIGEST_MISMATCH");
  const modelOptionCatalogRef = boundedText(value.modelOptionCatalogRef, 256);
  if (modelOptionCatalogRef !== `site-release-model-catalog:sha256:${catalogDigest}`)
    throw new Error("MODEL_OPTION_RELEASE_CATALOG_REF_MISMATCH");
  return deepFreeze({ ...payload, modelOptionCatalogRef, catalogDigest });
}

function compileGenerationBinding(
  inventory: CanonicalizedModelInventory,
  option: LegacyOption,
  surface: ProductModelSurface,
): ModelOptionRoleBinding {
  const role = surface === "chat" ? "main" : "generation";
  const expectedCapability = surface === "chat" ? "chat" : `${surface}.generate`;
  const allowed = new Set(option.candidateModelKeys.map(identifier));
  const candidates = structurallyUsableRouteModels(inventory, surface, role, expectedCapability).filter(
    (modelKey) => allowed.has(modelKey),
  );
  if (candidates.length === 0) throw new Error("MODEL_OPTION_GENERATION_ROUTE_REQUIRED");
  const requestedDefault = option.defaultModelKey === null ? null : identifier(option.defaultModelKey);
  if (requestedDefault !== null && !candidates.includes(requestedDefault))
    throw new Error("MODEL_OPTION_DEFAULT_MODEL_UNAVAILABLE");
  const primaryModelKey = requestedDefault ?? candidates[0]!;
  return deepFreeze({
    roleKey: generationRole(surface),
    primaryModelKey,
    fallbackModelKeys: candidates.filter((modelKey) => modelKey !== primaryModelKey),
    requiredCapabilities: [expectedCapability],
    fallbackPolicy: "ordered_pre_effect_only" as const,
  });
}

function compileOrchestrationBinding(
  inventory: CanonicalizedModelInventory,
  surface: Exclude<ProductModelSurface, "chat">,
): ModelOptionRoleBinding {
  const candidates = structurallyUsableRouteModels(inventory, surface, "main", "chat");
  if (candidates.length === 0) throw new Error("MODEL_OPTION_ORCHESTRATION_ROLE_REQUIRED");
  return deepFreeze({
    roleKey: `${surface}.assistant` as ModelOptionRoleKey,
    primaryModelKey: candidates[0]!,
    fallbackModelKeys: candidates.slice(1),
    requiredCapabilities: ["chat"],
    fallbackPolicy: "ordered_pre_effect_only" as const,
  });
}

function structurallyUsableRouteModels(
  inventory: CanonicalizedModelInventory,
  surface: ProductModelSurface,
  role: "main" | "generation",
  requiredCapability: string,
): string[] {
  const models = new Map(inventory.document.models.map((entry) => [entry.key, entry] as const));
  const boundModels = new Set(
    inventory.document.bindings.filter((binding) => binding.enabled).map((binding) => binding.modelKey),
  );
  return inventory.document.productRoutes
    .filter(
      (route) =>
        route.product === surface &&
        route.role === role &&
        route.requiredCapabilities.includes(requiredCapability),
    )
    .sort((left, right) => left.position - right.position || canonicalCompare(left.modelKey, right.modelKey))
    .map((route) => route.modelKey)
    .filter((modelKey) => {
      const candidate = models.get(modelKey);
      return candidate?.enabled === true && candidate.capabilities.includes(requiredCapability) && boundModels.has(modelKey);
    });
}

function optionAvailable(revision: ModelOptionRevision, available: ReadonlySet<string>): boolean {
  return [revision.composition.orchestration, revision.composition.generation].every((binding) =>
    [binding.primaryModelKey, ...binding.fallbackModelKeys].some((modelKey) => available.has(modelKey)),
  );
}

function publicGenerationContract(
  inventory: CanonicalizedModelInventory,
  binding: ModelOptionRoleBinding,
): {
  readonly inputModalities: readonly string[];
  readonly outputModalities: readonly string[];
  readonly supportedEfforts: readonly string[];
} {
  const candidates = [binding.primaryModelKey, ...binding.fallbackModelKeys].map((modelKey) =>
    model(inventory, modelKey),
  );
  const intersection = (values: (candidate: (typeof candidates)[number]) => readonly string[]) =>
    values(candidates[0]!).filter((value) =>
      candidates.slice(1).every((candidate) => values(candidate).includes(value)),
    );
  const sharedInputModalities = intersection((candidate) => candidate.inputModalities);
  const sharedOutputModalities = intersection((candidate) => candidate.outputModalities);
  if (sharedInputModalities.length === 0 || sharedOutputModalities.length === 0)
    throw new Error("MODEL_OPTION_PUBLIC_CONTRACT_INCOMPATIBLE");
  const inputModalities = publicTokens(sharedInputModalities, true);
  const outputModalities = publicTokens(sharedOutputModalities, true);
  const supportedEfforts = publicTokens(
    intersection((candidate) => candidate.capabilities)
      .filter((capability) => capability.startsWith("effort."))
      .map((capability) => capability.slice("effort.".length)),
    false,
  );
  return deepFreeze({ inputModalities, outputModalities, supportedEfforts });
}

function assertSurfaceComposition(revision: Omit<ModelOptionRevision, "modelOptionRevisionRef" | "revisionDigest">): void {
  const expectedGenerationRole = generationRole(revision.surface);
  const expectedOrchestrationRole =
    revision.surface === "chat" ? "assistant.primary" : `${revision.surface}.assistant`;
  if (
    revision.composition.generation.roleKey !== expectedGenerationRole ||
    revision.composition.orchestration.roleKey !== expectedOrchestrationRole
  )
    throw new Error("MODEL_OPTION_ROLE_SURFACE_MISMATCH");
  const generationCapability = revision.surface === "chat" ? "chat" : `${revision.surface}.generate`;
  if (
    stableJson(revision.composition.generation.requiredCapabilities) !==
      stableJson([generationCapability]) ||
    stableJson(revision.composition.orchestration.requiredCapabilities) !== stableJson(["chat"])
  )
    throw new Error("MODEL_OPTION_ROLE_CAPABILITY_MISMATCH");
  if (
    revision.surface === "chat" &&
    stableJson(revision.composition.orchestration) !== stableJson(revision.composition.generation)
  )
    throw new Error("MODEL_OPTION_CHAT_COMPOSITION_INVALID");
}

function model(inventory: CanonicalizedModelInventory, modelKey: string) {
  const candidate = inventory.document.models.find((entry) => entry.key === modelKey);
  if (!candidate) throw new Error("MODEL_OPTION_MODEL_UNKNOWN");
  return candidate;
}

function generationRole(surface: ProductModelSurface): ModelOptionRoleKey {
  return surface === "chat" ? "assistant.primary" : `${surface}.generation`;
}

function parseRoleBinding(input: unknown): ModelOptionRoleBinding {
  const value = strictRecord(
    input,
    [
      "roleKey",
      "primaryModelKey",
      "fallbackModelKeys",
      "requiredCapabilities",
      "fallbackPolicy",
    ],
    "MODEL_OPTION_ROLE_BINDING_INVALID",
  );
  const roleKey = boundedText(value.roleKey, 64);
  if (!isRoleKey(roleKey)) throw new Error("MODEL_OPTION_ROLE_BINDING_INVALID");
  if (value.fallbackPolicy !== "ordered_pre_effect_only")
    throw new Error("MODEL_OPTION_ROLE_BINDING_INVALID");
  const primaryModelKey = identifier(value.primaryModelKey);
  const fallbackModelKeys = unknownArray(value.fallbackModelKeys).map(identifier);
  if (
    new Set(fallbackModelKeys).size !== fallbackModelKeys.length ||
    fallbackModelKeys.includes(primaryModelKey)
  )
    throw new Error("MODEL_OPTION_ROLE_BINDING_INVALID");
  return deepFreeze({
    roleKey,
    primaryModelKey,
    fallbackModelKeys,
    requiredCapabilities: publicTokens(unknownArray(value.requiredCapabilities), true),
    fallbackPolicy: "ordered_pre_effect_only" as const,
  });
}

function isRoleKey(value: string): value is ModelOptionRoleKey {
  return [
    "assistant.primary",
    "music.assistant",
    "music.generation",
    "image.assistant",
    "image.generation",
    "video.assistant",
    "video.generation",
  ].includes(value);
}

function product(value: unknown): ProductModelSurface {
  if (typeof value !== "string" || !(modelProducts as readonly string[]).includes(value))
    throw new Error("MODEL_OPTION_SURFACE_INVALID");
  return value as ProductModelSurface;
}

function lifecycle(value: unknown): "active" | "disabled" {
  if (value !== "active" && value !== "disabled") throw new Error("MODEL_OPTION_LIFECYCLE_INVALID");
  return value;
}

function modelOptionRevisionRef(value: unknown): string {
  const result = boundedText(value, 256);
  if (!/^model-option:sha256:[a-f0-9]{64}$/u.test(result))
    throw new Error("MODEL_OPTION_REVISION_REF_INVALID");
  return result;
}

function publicOptionKey(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9._-]{1,127}$/u.test(value))
    throw new Error("MODEL_OPTION_KEY_INVALID");
  return value;
}

function publicLabel(value: unknown): string {
  return boundedText(value, 128);
}

function publicToken(value: unknown, maximumLength: number): string {
  const result = boundedText(value, maximumLength);
  if (!/^[a-z][a-z0-9._-]*$/u.test(result)) throw new Error("MODEL_OPTION_PUBLIC_TOKEN_INVALID");
  return result;
}

function publicTokens(values: readonly unknown[], nonEmpty: boolean): readonly string[] {
  const result = values.map((value) => publicToken(value, 64));
  if ((nonEmpty && result.length === 0) || result.length > 16 || new Set(result).size !== result.length)
    throw new Error("MODEL_OPTION_PUBLIC_TOKEN_LIST_INVALID");
  return deepFreeze(result);
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(value))
    throw new Error("MODEL_IDENTIFIER_INVALID");
  return value;
}

function boundedText(value: unknown, maximumLength: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    [...value].some(
      (character) => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127,
    )
  )
    throw new Error("MODEL_OPTION_TEXT_INVALID");
  return value;
}

function instant(value: unknown): string {
  const result = boundedText(value, 64);
  const timestamp = Date.parse(result);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== result)
    throw new Error("MODEL_OPTION_INSTANT_INVALID");
  return result;
}

function digest(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(code);
  return value;
}

function strictRecord(value: unknown, allowed: readonly string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !allowed.includes(key))) throw new Error(code);
  return result;
}

function unknownArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error("MODEL_OPTION_ARRAY_INVALID");
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => canonicalCompare(left, right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
