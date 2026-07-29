import { writeFile } from "node:fs/promises";
import mysql from "mysql2/promise";
import {
  canonicalizeModelInventory,
  type CanonicalModelInventory,
  type CanonicalProductRoute,
  type ModelProduct,
} from "../../src/modules/model-control/domain/model-catalog.js";
import { createModelControlMigrationBundle } from "../../src/modules/model-control/migration/model-control-migration-bundle.js";

const outputPath = argument("--output");
const modelDatabaseUrl = requiredEnv("DATABASE_URL_MODEL");
const siteDatabaseUrl = requiredEnv("DATABASE_URL_SITE");
const connection = await mysql.createConnection({ uri: modelDatabaseUrl, rowsAsArray: false });
const siteConnection = await mysql.createConnection({ uri: siteDatabaseUrl, rowsAsArray: false });
try {
  const [providerRows] = await connection.query<Record<string, unknown>[]>(
    `SELECT id, provider, \`key\`, secretRef, priority, transportKind, status, healthStatus, updatedAt FROM model_provider_accounts WHERE deletedAt IS NULL ORDER BY provider, \`key\``,
  );
  const [modelRows] = await connection.query<Record<string, unknown>[]>(
    `SELECT id, providerAccountId, provider, modelName, displayName, featureKey, labelKeys, inputModalities, outputModalities, transportKind, gatewayModelName, contextWindow, priority, status FROM model_bindings WHERE deletedAt IS NULL ORDER BY featureKey, priority, id`,
  );
  const [policyRows] = await connection.query<Record<string, unknown>[]>(
    `SELECT siteId, labelKey, status FROM model_site_policies ORDER BY siteId, labelKey`,
  );
  const [siteRows] = await siteConnection.query<Record<string, unknown>[]>(
    `SELECT id FROM site_sites WHERE deletedAt IS NULL ORDER BY id`,
  );
  const providers = providerRows.map((row) => ({
    key: string(row.id),
    provider: string(row.provider),
    accountKey: string(row.key),
    secretRef: normalizeSecretRef(string(row.secretRef)),
    adapterKind: row.transportKind === "litellm" ? ("litellm" as const) : ("direct" as const),
    priority: number(row.priority),
  }));
  const models = modelRows.map((row) => ({
    key: string(row.id),
    displayName: string(row.displayName),
    inputModalities: jsonStrings(row.inputModalities),
    outputModalities: jsonStrings(row.outputModalities),
    capabilities: capabilities(row),
    contextWindow: nullableNumber(row.contextWindow),
    enabled: row.status === "active",
  }));
  const bindings = modelRows.map((row) => ({
    key: `binding:${string(row.id)}`,
    modelKey: string(row.id),
    providerKey: string(row.providerAccountId),
    upstreamModel: string(row.modelName),
    gatewayModelName:
      nullableString(row.gatewayModelName) ?? `${string(row.provider)}:${string(row.modelName)}`,
    priority: number(row.priority),
    enabled: row.status === "active",
  }));
  const productRoutes = routes(modelRows);
  const siteIds = siteRows.map((row) => string(row.id));
  const siteIdSet = new Set(siteIds);
  if (policyRows.some((row) => !siteIdSet.has(string(row.siteId))))
    throw new Error("LEGACY_MODEL_POLICY_SITE_UNKNOWN");
  const inventory: CanonicalModelInventory = {
    schemaVersion: 1,
    source: { kind: "legacy-kokoro-model", reference: argument("--source-ref") },
    providers,
    models,
    bindings,
    productRoutes,
  };
  const canonical = canonicalizeModelInventory(inventory);
  const providerAvailability = providerRows.map((row) => ({
    providerKey: string(row.id),
    status: enumValue(row.status, ["active", "disabled"] as const),
    health: enumValue(row.healthStatus, ["unknown", "healthy", "degraded", "down"] as const),
    epoch: "0",
    observationRef: `legacy:model_provider_accounts:${string(row.id)}`,
    observedAt: instant(row.updatedAt),
  }));
  const bundle = createModelControlMigrationBundle({
    catalog: canonical,
    providerAvailability,
    sites: siteIds.map((siteId) => {
      const hiddenLabels = new Set(
        policyRows
          .filter((row) => string(row.siteId) === siteId && row.status === "hidden")
          .map((row) => string(row.labelKey)),
      );
      return {
        siteId,
        hiddenModelKeys: modelRows
          .filter((row) => jsonStrings(row.labelKeys).some((label) => hiddenLabels.has(label)))
          .map((row) => string(row.id)),
      };
    }),
  });
  await writeFile(outputPath, `${JSON.stringify(bundle)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(
    `${JSON.stringify({ outputPath, bundleDigest: bundle.bundleDigest, catalogDigest: canonical.digest, counts: canonical.counts, sitePolicies: bundle.sitePolicyCommands.length })}\n`,
  );
} finally {
  await Promise.all([connection.end(), siteConnection.end()]);
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
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
function enumValue<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
): Values[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error("LEGACY_ENUM_INVALID");
  return value;
}
function instant(value: unknown): string {
  const parsed = value instanceof Date ? value : new Date(string(value));
  if (!Number.isFinite(parsed.getTime())) throw new Error("LEGACY_INSTANT_INVALID");
  return parsed.toISOString();
}
