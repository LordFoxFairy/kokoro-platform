import { createHash } from "node:crypto";
import { modelProducts, type ModelProduct, type ModelRouteRole } from "./model-catalog.js";

export interface SiteModelAssignment {
  readonly role: ModelRouteRole;
  readonly modelKey: string;
  readonly position: number;
  readonly requiredCapabilities: readonly string[];
  readonly enabled: boolean;
}

export interface SiteModelPolicy {
  readonly schemaVersion: 1;
  readonly siteId: string;
  readonly product: ModelProduct;
  readonly enabled: boolean;
  readonly catalog:
    | { readonly mode: "follow_active"; readonly digest: null }
    | { readonly mode: "pinned"; readonly digest: string };
  readonly assignmentMode: "inherit" | "replace";
  readonly assignments: readonly SiteModelAssignment[];
}

export interface CanonicalizedSiteModelPolicy {
  readonly document: SiteModelPolicy;
  readonly canonicalJson: string;
  readonly digest: string;
}

export function canonicalizeSiteModelPolicy(input: SiteModelPolicy): CanonicalizedSiteModelPolicy {
  if (input.schemaVersion !== 1) throw new Error("MODEL_SITE_POLICY_VERSION_UNSUPPORTED");
  const siteId = identifier(input.siteId);
  const product = parseProduct(input.product);
  const catalog = parseCatalog(input.catalog);
  if (input.assignmentMode !== "inherit" && input.assignmentMode !== "replace")
    throw new Error("MODEL_SITE_ASSIGNMENT_MODE_INVALID");
  if (catalog.mode === "follow_active" && input.assignmentMode !== "inherit")
    throw new Error("MODEL_SITE_REPLACE_REQUIRES_PINNED_CATALOG");

  const assignments = [...input.assignments]
    .map((assignment) =>
      Object.freeze({
        ...assignment,
        role: parseRole(assignment.role),
        modelKey: identifier(assignment.modelKey),
        position: position(assignment.position),
        requiredCapabilities: identifiers(assignment.requiredCapabilities),
      }),
    )
    .sort((left, right) =>
      `${left.role}:${String(left.position).padStart(6, "0")}:${left.modelKey}`.localeCompare(
        `${right.role}:${String(right.position).padStart(6, "0")}:${right.modelKey}`,
      ),
    );
  assertUnique(
    assignments,
    (item) => `${item.role}:${item.position}`,
    "MODEL_SITE_ASSIGNMENT_POSITION_DUPLICATE",
  );
  assertUnique(
    assignments,
    (item) => `${item.role}:${item.modelKey}`,
    "MODEL_SITE_ASSIGNMENT_MODEL_DUPLICATE",
  );
  if (input.assignmentMode === "inherit" && assignments.length > 0)
    throw new Error("MODEL_SITE_INHERIT_ASSIGNMENTS_FORBIDDEN");
  if (input.assignmentMode === "replace" && input.enabled) {
    if (
      !assignments.some(
        (item) =>
          item.enabled &&
          item.role === "main" &&
          item.position === 0 &&
          item.requiredCapabilities.includes("chat"),
      )
    )
      throw new Error("MODEL_SITE_MAIN_REQUIRED");
    if (
      product !== "chat" &&
      !assignments.some(
        (item) =>
          item.enabled &&
          item.role === "generation" &&
          item.position === 0 &&
          item.requiredCapabilities.includes(`${product}.generate`),
      )
    )
      throw new Error("MODEL_SITE_GENERATION_REQUIRED");
  }

  const document = deepFreeze({
    schemaVersion: 1 as const,
    siteId,
    product,
    enabled: input.enabled,
    catalog,
    assignmentMode: input.assignmentMode,
    assignments,
  });
  const canonicalJson = stableJson(document);
  return Object.freeze({
    document,
    canonicalJson,
    digest: createHash("sha256").update(canonicalJson).digest("hex"),
  });
}

function parseCatalog(value: SiteModelPolicy["catalog"]): SiteModelPolicy["catalog"] {
  if (value.mode === "follow_active") {
    if (value.digest !== null) throw new Error("MODEL_SITE_ACTIVE_CATALOG_DIGEST_FORBIDDEN");
    return Object.freeze({ mode: "follow_active", digest: null });
  }
  if (value.mode !== "pinned" || !/^[a-f0-9]{64}$/u.test(value.digest))
    throw new Error("MODEL_SITE_CATALOG_INVALID");
  return Object.freeze({ mode: "pinned", digest: value.digest });
}
function parseProduct(value: string): ModelProduct {
  if (!(modelProducts as readonly string[]).includes(value))
    throw new Error("MODEL_PRODUCT_INVALID");
  return value as ModelProduct;
}
function parseRole(value: string): ModelRouteRole {
  if (value !== "main" && value !== "generation") throw new Error("MODEL_ROUTE_ROLE_INVALID");
  return value;
}
function identifier(value: string): string {
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(value)) throw new Error("MODEL_IDENTIFIER_INVALID");
  return value;
}
function identifiers(values: readonly string[]): readonly string[] {
  const parsed = [...new Set(values.map(identifier))].sort();
  if (parsed.length !== values.length) throw new Error("MODEL_LIST_DUPLICATE");
  return Object.freeze(parsed);
}
function position(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 10_000)
    throw new Error("MODEL_POSITION_INVALID");
  return value;
}
function assertUnique<T>(items: readonly T[], key: (item: T) => string, code: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) throw new Error(code);
    seen.add(value);
  }
}
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
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
