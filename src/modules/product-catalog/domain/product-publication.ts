import {
  canonicalDigest,
  sameCanonicalBytes,
  verifyCanonicalDocument,
  type ResolvedCanonicalDocument,
} from "./canonical-product-document.js";
import {
  validateLaunchProfileShape,
  validateProductCatalogShape,
} from "../../../interfaces/json-schema/generated-product-catalog/product-publication-schema-validator.js";

interface CatalogProduct {
  readonly productRef: string;
  readonly revision: string;
  readonly surfaceRefs: readonly string[];
  readonly requiredProductRefs: readonly string[];
  readonly canonicalJourneyRefs: readonly string[];
  readonly operationFamilyRefs: readonly string[];
}
interface CatalogSurface {
  readonly surfaceRef: string;
  readonly productRef: string;
  readonly revision: string;
  readonly scopeClass: "core-always" | "profile-selectable";
  readonly requiredSurfaceRefs: readonly string[];
  readonly canonicalJourneyRefs: readonly string[];
  readonly operationFamilyRefs: readonly string[];
  readonly requiredModelRoleRefs: readonly string[];
}
interface CatalogJourney {
  readonly journeyRef: string;
  readonly revision: string;
  readonly entrySurfaceRef: string;
  readonly requiredSurfaceRefs: readonly string[];
  readonly requiredJourneyRefs: readonly string[];
  readonly operationFamilyRefs: readonly string[];
}
export interface ProductSurfaceCatalogDocument {
  readonly contract: "kokoro.product-surface-catalog.v1";
  readonly schemaRevision: "1";
  readonly catalogRevisionRef: string;
  readonly revision: string;
  readonly state: "draft" | "validating" | "published" | "retired";
  readonly products: readonly CatalogProduct[];
  readonly surfaces: readonly CatalogSurface[];
  readonly canonicalJourneys: readonly CatalogJourney[];
  readonly operationFamilyRefs: readonly string[];
  readonly publishedAt: string | null;
}
export interface LaunchProductProfileDocument {
  readonly contract: "kokoro.launch-product-profile.v1";
  readonly schemaRevision: "1";
  readonly profileRevisionRef: string;
  readonly revision: string;
  readonly state: "published";
  readonly targetSiteKindRef: string;
  readonly productSurfaceCatalog: Readonly<{ ref: string; digest: string }>;
  readonly enabledSurfaceRefs: readonly string[];
  readonly journeyClosure: Readonly<{
    journeys: readonly Readonly<{ journeyRef: string; revision: string }>[];
    digest: string;
  }>;
  readonly shellRequirementRefs: readonly string[];
  readonly policies: Readonly<Record<string, string>>;
  readonly reviewApprovalRefs: readonly string[];
  readonly publishedAt: string;
}

export interface ImmutableRevisionBinding {
  readonly ref: string;
  readonly revision: bigint;
  readonly digest: string;
}

interface CanonicalRevision<Document> {
  readonly binding: ImmutableRevisionBinding;
  readonly canonicalBytes: Uint8Array;
  readonly document: Document;
  readonly publishedAt: string;
}

export type PublishedProductSurfaceCatalogRevision = CanonicalRevision<ProductSurfaceCatalogDocument>;
export type PublishedLaunchProductProfileRevision = CanonicalRevision<LaunchProductProfileDocument> &
  Readonly<{ productSurfaceCatalog: ImmutableRevisionBinding }>;

export type PublicationStateSnapshot<Revision> = Readonly<{
  headRevision: bigint;
  existing: Revision | null;
}>;

export type PublicationDecision<Revision> =
  | Readonly<{ kind: "publish"; revision: Revision }>
  | Readonly<{ kind: "replay"; revision: Revision }>;

export function resolveProductSurfaceCatalogRevision(
  binding: ImmutableRevisionBinding,
  source: ResolvedCanonicalDocument,
): PublishedProductSurfaceCatalogRevision {
  assertBinding(binding);
  const verified = verifyCanonicalDocument(source);
  if (verified.digest !== binding.digest) throw new Error("PRODUCT_CATALOG_BINDING_DIGEST_MISMATCH");
  if (!validateProductCatalogShape(verified.parsedDocument)) {
    throw new Error("PRODUCT_CATALOG_DOCUMENT_SCHEMA_INVALID");
  }
  const document = verified.parsedDocument as unknown as ProductSurfaceCatalogDocument;
  if (document.state !== "published" || document.publishedAt === null) {
    throw new Error("PRODUCT_CATALOG_DOCUMENT_NOT_PUBLISHED");
  }
  assertCanonicalInstant(document.publishedAt);
  if (document.catalogRevisionRef !== binding.ref || BigInt(document.revision) !== binding.revision) {
    throw new Error("PRODUCT_CATALOG_BINDING_MISMATCH");
  }
  validateCatalogClosure(document);
  return deepFreeze({ binding, canonicalBytes: verified.canonicalBytes, document,
    publishedAt: document.publishedAt });
}

export function resolveLaunchProductProfileRevision(
  binding: ImmutableRevisionBinding,
  productSurfaceCatalog: ImmutableRevisionBinding,
  source: ResolvedCanonicalDocument,
): PublishedLaunchProductProfileRevision {
  assertBinding(binding);
  assertBinding(productSurfaceCatalog);
  const verified = verifyCanonicalDocument(source);
  if (verified.digest !== binding.digest) throw new Error("LAUNCH_PRODUCT_PROFILE_BINDING_DIGEST_MISMATCH");
  if (!validateLaunchProfileShape(verified.parsedDocument)) {
    throw new Error("LAUNCH_PRODUCT_PROFILE_SCHEMA_INVALID");
  }
  const document = verified.parsedDocument as unknown as LaunchProductProfileDocument;
  assertCanonicalInstant(document.publishedAt);
  if (document.profileRevisionRef !== binding.ref || BigInt(document.revision) !== binding.revision) {
    throw new Error("LAUNCH_PRODUCT_PROFILE_BINDING_MISMATCH");
  }
  if (document.productSurfaceCatalog.ref !== productSurfaceCatalog.ref ||
      document.productSurfaceCatalog.digest !== productSurfaceCatalog.digest) {
    throw new Error("LAUNCH_PRODUCT_PROFILE_CATALOG_BINDING_MISMATCH");
  }
  return deepFreeze({
    binding,
    canonicalBytes: verified.canonicalBytes,
    document,
    publishedAt: document.publishedAt,
    productSurfaceCatalog,
  });
}

export function validateLaunchProductProfileClosure(
  profile: PublishedLaunchProductProfileRevision,
  catalog: PublishedProductSurfaceCatalogRevision,
): void {
  if (!sameBinding(profile.productSurfaceCatalog, catalog.binding)) {
    throw new Error("LAUNCH_PRODUCT_PROFILE_CATALOG_BINDING_MISMATCH");
  }
  const surfaces = new Map(catalog.document.surfaces.map((surface) => [surface.surfaceRef, surface]));
  const enabled = unique(profile.document.enabledSurfaceRefs, "LAUNCH_PRODUCT_PROFILE_SURFACE_DUPLICATE");
  for (const surface of catalog.document.surfaces) {
    if (surface.scopeClass === "core-always" && !enabled.has(surface.surfaceRef)) {
      throw new Error("LAUNCH_PRODUCT_PROFILE_CORE_SURFACE_MISSING");
    }
  }
  for (const surfaceRef of enabled) {
    const surface = surfaces.get(surfaceRef);
    if (surface === undefined || surface.requiredSurfaceRefs.some((required) => !enabled.has(required))) {
      throw new Error("LAUNCH_PRODUCT_PROFILE_SURFACE_CLOSURE_INVALID");
    }
  }
  const products = new Map(catalog.document.products.map((product) => [product.productRef, product]));
  const requiredProducts = new Set([...enabled].map((surfaceRef) => surfaces.get(surfaceRef)!.productRef));
  const visitProduct = (productRef: string): void => {
    const product = products.get(productRef);
    if (product === undefined || product.surfaceRefs.some((surfaceRef) => !enabled.has(surfaceRef))) {
      throw new Error("LAUNCH_PRODUCT_PROFILE_PRODUCT_CLOSURE_INVALID");
    }
    for (const dependency of product.requiredProductRefs) {
      if (!requiredProducts.has(dependency)) {
        requiredProducts.add(dependency);
        visitProduct(dependency);
      }
    }
  };
  for (const productRef of [...requiredProducts]) visitProduct(productRef);

  const journeyRefs = new Set<string>();
  for (const surfaceRef of enabled) {
    const surface = surfaces.get(surfaceRef)!;
    for (const journeyRef of surface.canonicalJourneyRefs) journeyRefs.add(journeyRef);
    for (const journeyRef of products.get(surface.productRef)!.canonicalJourneyRefs) {
      journeyRefs.add(journeyRef);
    }
  }
  const journeys = new Map(catalog.document.canonicalJourneys.map((journey) => [journey.journeyRef, journey]));
  const visitJourney = (journeyRef: string): void => {
    const journey = journeys.get(journeyRef);
    if (journey === undefined || !enabled.has(journey.entrySurfaceRef) ||
        journey.requiredSurfaceRefs.some((surfaceRef) => !enabled.has(surfaceRef))) {
      throw new Error("LAUNCH_PRODUCT_PROFILE_JOURNEY_CLOSURE_INVALID");
    }
    for (const dependency of journey.requiredJourneyRefs) {
      if (!journeyRefs.has(dependency)) {
        journeyRefs.add(dependency);
        visitJourney(dependency);
      }
    }
  };
  for (const journeyRef of [...journeyRefs]) visitJourney(journeyRef);
  unique(profile.document.journeyClosure.journeys.map(({ journeyRef }) => journeyRef),
    "LAUNCH_PRODUCT_PROFILE_JOURNEY_DUPLICATE");
  const expected = [...journeyRefs].sort(compare).map((journeyRef) => ({
    journeyRef,
    revision: journeys.get(journeyRef)!.revision,
  }));
  const declared = [...profile.document.journeyClosure.journeys]
    .sort((left, right) => compare(left.journeyRef, right.journeyRef));
  if (JSON.stringify(declared) !== JSON.stringify(expected) ||
      profile.document.journeyClosure.digest !== canonicalDigest(expected)) {
    throw new Error("LAUNCH_PRODUCT_PROFILE_JOURNEY_CLOSURE_DIGEST_INVALID");
  }
}

export function decideCatalogPublication(
  candidate: PublishedProductSurfaceCatalogRevision,
  expectedHeadRevision: bigint,
  snapshot: PublicationStateSnapshot<PublishedProductSurfaceCatalogRevision>,
): PublicationDecision<PublishedProductSurfaceCatalogRevision> {
  return decidePublication(candidate, expectedHeadRevision, snapshot, "PRODUCT_CATALOG");
}

export function decideProfilePublication(
  candidate: PublishedLaunchProductProfileRevision,
  expectedHeadRevision: bigint,
  snapshot: PublicationStateSnapshot<PublishedLaunchProductProfileRevision>,
): PublicationDecision<PublishedLaunchProductProfileRevision> {
  return decidePublication(candidate, expectedHeadRevision, snapshot, "LAUNCH_PRODUCT_PROFILE");
}

function decidePublication<Revision extends CanonicalRevision<unknown>>(
  candidate: Revision,
  expectedHeadRevision: bigint,
  snapshot: PublicationStateSnapshot<Revision>,
  code: string,
): PublicationDecision<Revision> {
  if (expectedHeadRevision < 0n) throw new Error(`${code}_EXPECTED_HEAD_INVALID`);
  if (snapshot.existing !== null) {
    if (sameBinding(snapshot.existing.binding, candidate.binding) &&
        sameCanonicalBytes(snapshot.existing.canonicalBytes, candidate.canonicalBytes)) {
      return Object.freeze({ kind: "replay", revision: snapshot.existing });
    }
    throw new Error(`${code}_REVISION_CONFLICT`);
  }
  if (snapshot.headRevision !== expectedHeadRevision) throw new Error(`${code}_HEAD_CONFLICT`);
  if (candidate.binding.revision !== expectedHeadRevision + 1n) {
    throw new Error(`${code}_REVISION_SEQUENCE_INVALID`);
  }
  return Object.freeze({ kind: "publish", revision: candidate });
}

function validateCatalogClosure(document: ProductSurfaceCatalogDocument): void {
  const products = unique(document.products.map(({ productRef }) => productRef), "PRODUCT_CATALOG_PRODUCT_DUPLICATE");
  const surfaces = unique(document.surfaces.map(({ surfaceRef }) => surfaceRef), "PRODUCT_CATALOG_SURFACE_DUPLICATE");
  const journeys = unique(document.canonicalJourneys.map(({ journeyRef }) => journeyRef), "PRODUCT_CATALOG_JOURNEY_DUPLICATE");
  const operations = unique(document.operationFamilyRefs, "PRODUCT_CATALOG_OPERATION_DUPLICATE");
  const ensureKnown = (values: readonly string[], known: ReadonlySet<string>): void => {
    if (values.some((value) => !known.has(value))) throw new Error("PRODUCT_CATALOG_REFERENCE_INVALID");
  };
  for (const product of document.products) {
    unique(product.surfaceRefs, "PRODUCT_CATALOG_PRODUCT_SURFACE_DUPLICATE");
    unique(product.requiredProductRefs, "PRODUCT_CATALOG_PRODUCT_DEPENDENCY_DUPLICATE");
    unique(product.canonicalJourneyRefs, "PRODUCT_CATALOG_PRODUCT_JOURNEY_DUPLICATE");
    unique(product.operationFamilyRefs, "PRODUCT_CATALOG_PRODUCT_OPERATION_DUPLICATE");
    ensureKnown(product.surfaceRefs, surfaces);
    ensureKnown(product.requiredProductRefs, products);
    ensureKnown(product.canonicalJourneyRefs, journeys);
    ensureKnown(product.operationFamilyRefs, operations);
  }
  const surfaceOwners = new Map<string, string>();
  for (const product of document.products) {
    for (const surfaceRef of product.surfaceRefs) {
      if (surfaceOwners.has(surfaceRef)) throw new Error("PRODUCT_CATALOG_SURFACE_OWNER_CONFLICT");
      surfaceOwners.set(surfaceRef, product.productRef);
    }
  }
  for (const surface of document.surfaces) {
    unique(surface.requiredSurfaceRefs, "PRODUCT_CATALOG_SURFACE_DEPENDENCY_DUPLICATE");
    unique(surface.canonicalJourneyRefs, "PRODUCT_CATALOG_SURFACE_JOURNEY_DUPLICATE");
    unique(surface.operationFamilyRefs, "PRODUCT_CATALOG_SURFACE_OPERATION_DUPLICATE");
    unique(surface.requiredModelRoleRefs, "PRODUCT_CATALOG_SURFACE_MODEL_ROLE_DUPLICATE");
    ensureKnown([surface.productRef], products);
    ensureKnown(surface.requiredSurfaceRefs, surfaces);
    ensureKnown(surface.canonicalJourneyRefs, journeys);
    ensureKnown(surface.operationFamilyRefs, operations);
    const product = document.products.find(({ productRef }) => productRef === surface.productRef);
    if (product === undefined || !product.surfaceRefs.includes(surface.surfaceRef) ||
        surfaceOwners.get(surface.surfaceRef) !== surface.productRef) {
      throw new Error("PRODUCT_CATALOG_SURFACE_OWNER_INVALID");
    }
  }
  for (const journey of document.canonicalJourneys) {
    unique(journey.requiredSurfaceRefs, "PRODUCT_CATALOG_JOURNEY_SURFACE_DUPLICATE");
    unique(journey.requiredJourneyRefs, "PRODUCT_CATALOG_JOURNEY_DEPENDENCY_DUPLICATE");
    unique(journey.operationFamilyRefs, "PRODUCT_CATALOG_JOURNEY_OPERATION_DUPLICATE");
    ensureKnown([journey.entrySurfaceRef, ...journey.requiredSurfaceRefs], surfaces);
    ensureKnown(journey.requiredJourneyRefs, journeys);
    ensureKnown(journey.operationFamilyRefs, operations);
  }
  assertDag(new Map(document.products.map((value) => [value.productRef, value])),
    "requiredProductRefs", "PRODUCT_CATALOG_PRODUCT_CYCLE");
  assertDag(new Map(document.surfaces.map((value) => [value.surfaceRef, value])),
    "requiredSurfaceRefs", "PRODUCT_CATALOG_SURFACE_CYCLE");
  assertDag(new Map(document.canonicalJourneys.map((value) => [value.journeyRef, value])),
    "requiredJourneyRefs", "PRODUCT_CATALOG_JOURNEY_CYCLE");
}

function assertDag<Node>(
  nodes: ReadonlyMap<string, Node>,
  dependencyField: keyof Node,
  code: string,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (ref: string): void => {
    if (visiting.has(ref)) throw new Error(code);
    if (visited.has(ref)) return;
    const node = nodes.get(ref);
    if (node === undefined || node === null) throw new Error("PRODUCT_CATALOG_REFERENCE_INVALID");
    visiting.add(ref);
    const dependencies: unknown = node[dependencyField];
    if (!Array.isArray(dependencies)) throw new Error("PRODUCT_CATALOG_DEPENDENCY_INVALID");
    for (const dependency of dependencies) {
      if (typeof dependency !== "string") throw new Error("PRODUCT_CATALOG_DEPENDENCY_INVALID");
      visit(dependency);
    }
    visiting.delete(ref);
    visited.add(ref);
  };
  for (const ref of nodes.keys()) visit(ref);
}

function assertBinding(binding: ImmutableRevisionBinding): void {
  if (binding.ref.length < 3 || binding.ref.length > 256 || binding.revision < 1n ||
      binding.revision > 18_446_744_073_709_551_615n || !/^sha256:[a-f0-9]{64}$/u.test(binding.digest)) {
    throw new Error("PRODUCT_PUBLICATION_REVISION_BINDING_INVALID");
  }
}

function sameBinding(left: ImmutableRevisionBinding, right: ImmutableRevisionBinding): boolean {
  return left.ref === right.ref && left.revision === right.revision && left.digest === right.digest;
}

function unique(values: readonly string[], code: string): ReadonlySet<string> {
  const result = new Set(values);
  if (result.size !== values.length) throw new Error(code);
  return result;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertCanonicalInstant(value: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("PRODUCT_PUBLICATION_TIMESTAMP_INVALID");
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    if (ArrayBuffer.isView(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
