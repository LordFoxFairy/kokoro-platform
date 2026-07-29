import { writeFile } from "node:fs/promises";
import mysql from "mysql2/promise";
import {
  canonicalizeModelInventory,
  type CanonicalModelInventory,
  type CanonicalProductRoute,
  type ModelProduct,
} from "../../src/modules/model-control/domain/model-catalog.js";
import { canonicalizeSiteModelPolicy } from "../../src/modules/model-control/domain/site-model-policy.js";

const outputPath = argument("--output");
const sitePoliciesOutputPath = argument("--site-policies-output");
const databaseUrl = process.env.DATABASE_URL_MODEL;
if (!databaseUrl) throw new Error("DATABASE_URL_MODEL_REQUIRED");
const connection = await mysql.createConnection({ uri: databaseUrl, rowsAsArray: false });
try {
  const [providerRows] = await connection.query<Record<string, unknown>[]>(
    `SELECT id, provider, \`key\`, secretRef, priority, transportKind, status FROM model_provider_accounts WHERE deletedAt IS NULL ORDER BY provider, \`key\``,
  );
  const [modelRows] = await connection.query<Record<string, unknown>[]>(
    `SELECT id, providerAccountId, provider, modelName, displayName, featureKey, labelKeys, inputModalities, outputModalities, transportKind, gatewayModelName, contextWindow, priority, status FROM model_bindings WHERE deletedAt IS NULL ORDER BY featureKey, priority, id`,
  );
  const [policyRows] = await connection.query<Record<string, unknown>[]>(
    `SELECT siteId, labelKey, status FROM model_site_policies ORDER BY siteId, labelKey`,
  );
  const providers = providerRows.map((row) => ({
    key: string(row.id),
    provider: string(row.provider),
    accountKey: string(row.key),
    secretRef: normalizeSecretRef(string(row.secretRef)),
    adapterKind: row.transportKind === "litellm" ? ("litellm" as const) : ("direct" as const),
    priority: number(row.priority),
  }));
  const providerIsActive = new Map(
    providerRows.map((row) => [string(row.id), row.status === "active"]),
  );
  const models = modelRows.map((row) => ({
    key: string(row.id),
    displayName: string(row.displayName),
    inputModalities: jsonStrings(row.inputModalities),
    outputModalities: jsonStrings(row.outputModalities),
    capabilities: capabilities(row),
    contextWindow: nullableNumber(row.contextWindow),
    enabled:
      row.status === "active" && providerIsActive.get(string(row.providerAccountId)) === true,
  }));
  const bindings = modelRows.map((row) => ({
    key: `binding:${string(row.id)}`,
    modelKey: string(row.id),
    providerKey: string(row.providerAccountId),
    upstreamModel: string(row.modelName),
    gatewayModelName:
      nullableString(row.gatewayModelName) ?? `${string(row.provider)}:${string(row.modelName)}`,
    priority: number(row.priority),
    enabled:
      row.status === "active" && providerIsActive.get(string(row.providerAccountId)) === true,
  }));
  const productRoutes = routes(modelRows);
  const sites = [...new Set(policyRows.map((row) => string(row.siteId)))].sort();
  const hiddenBySite = new Map(
    sites.map((site) => [
      site,
      new Set(
        policyRows
          .filter((row) => row.siteId === site && row.status === "hidden")
          .map((row) => string(row.labelKey)),
      ),
    ]),
  );
  const inventory: CanonicalModelInventory = {
    schemaVersion: 1,
    source: { kind: "legacy-kokoro-model", reference: argument("--source-ref") },
    providers,
    models,
    bindings,
    productRoutes,
  };
  const canonical = canonicalizeModelInventory(inventory);
  const sitePolicies = sites.flatMap((siteId) =>
    (["chat", "music", "image", "video"] as const).map((product) =>
      canonicalizeSiteModelPolicy({
        schemaVersion: 1,
        siteId,
        product,
        enabled: true,
        catalog: { mode: "pinned", digest: canonical.digest },
        assignmentMode: "replace",
        assignments: siteAssignments(productRoutes, modelRows, hiddenBySite.get(siteId)!, product),
      }),
    ),
  );
  await writeFile(outputPath, `${canonical.canonicalJson}\n`, { encoding: "utf8", flag: "wx" });
  await writeFile(
    sitePoliciesOutputPath,
    `${JSON.stringify({ schemaVersion: 1, catalogDigest: canonical.digest, policies: sitePolicies.map((policy) => ({ digest: policy.digest, document: policy.document })) })}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  process.stdout.write(
    `${JSON.stringify({ outputPath, sitePoliciesOutputPath, digest: canonical.digest, counts: canonical.counts, sitePolicies: sitePolicies.length })}\n`,
  );
} finally {
  await connection.end();
}

function routes(rows: Record<string, unknown>[]): CanonicalProductRoute[] {
  const chat = rows
    .filter((row) => row.featureKey === "chat" && row.status === "active")
    .sort(byPriority)
    .map((row, position) => ({
      product: "chat" as const,
      role: "main" as const,
      modelKey: string(row.id),
      position,
      requiredCapabilities: ["chat"],
    }));
  const result: CanonicalProductRoute[] = [...chat];
  for (const product of ["music", "image", "video"] as const) {
    result.push(...chat.map((route) => ({ ...route, product })));
    result.push(
      ...rows
        .filter((row) => row.featureKey === product && row.status === "active")
        .sort(byPriority)
        .map((row, position) => ({
          product,
          role: "generation" as const,
          modelKey: string(row.id),
          position,
          requiredCapabilities: [`${product}.generate`],
        })),
    );
  }
  return result;
}

function siteAssignments(
  productRoutes: readonly CanonicalProductRoute[],
  modelRows: readonly Record<string, unknown>[],
  hiddenLabels: ReadonlySet<string>,
  product: ModelProduct,
) {
  const visible = productRoutes.filter((route) => {
    if (route.product !== product) return false;
    const model = modelRows.find((row) => string(row.id) === route.modelKey);
    if (!model) throw new Error("LEGACY_ROUTE_MODEL_MISSING");
    return !jsonStrings(model.labelKeys).some((label) => hiddenLabels.has(label));
  });
  return (["main", "generation"] as const).flatMap((role) =>
    visible
      .filter((route) => route.role === role)
      .map((route, position) => ({
        role,
        modelKey: route.modelKey,
        position,
        requiredCapabilities: route.requiredCapabilities,
        enabled: true,
      })),
  );
}
function capabilities(row: Record<string, unknown>): string[] {
  const feature = string(row.featureKey) as ModelProduct;
  return [
    ...new Set([
      feature === "chat" ? "chat" : `${feature}.generate`,
      ...jsonStrings(row.outputModalities).map((item) => `output.${item}`),
    ]),
  ].sort();
}
function byPriority(a: Record<string, unknown>, b: Record<string, unknown>): number {
  return number(a.priority) - number(b.priority) || string(a.id).localeCompare(string(b.id));
}
function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || !value) throw new Error(`ARGUMENT_REQUIRED:${name}`);
  return value;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("LEGACY_STRING_INVALID");
  return value;
}
function number(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error("LEGACY_NUMBER_INVALID");
  return parsed;
}
function nullableString(value: unknown): string | null {
  return value === null ? null : string(value);
}
function nullableNumber(value: unknown): number | null {
  return value === null ? null : number(value);
}
function jsonStrings(value: unknown): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string"))
    throw new Error("LEGACY_JSON_LIST_INVALID");
  return parsed;
}
function normalizeSecretRef(value: string): string {
  return /^(?:secret|vault|env):\/\//u.test(value) ? value : `env://${value}`;
}
