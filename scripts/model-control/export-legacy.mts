import { createPublicKey } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import {
  canonicalizeModelInventory,
  type CanonicalModelInventory,
  type CanonicalProductRoute,
  type ModelProduct,
} from "../../src/modules/model-control/domain/model-catalog.js";
import { createModelControlMigrationBundle } from "../../src/modules/model-control/migration/model-control-migration-bundle.js";
import { createLegacyModelOptionMigrationArtifact } from "../../src/modules/model-control/migration/legacy-model-option-artifact.js";
import { parseLegacySecretReference } from "../../src/modules/model-control/migration/legacy-secret-reference.js";
import {
  captureFencedLegacySnapshots,
  createLegacySourceWatermark,
  legacyMysqlDatabaseIdentity,
  legacySnapshotReference,
  sameLegacyDatabaseIdentity,
  verifyLegacyExportFenceAttestation,
  type CapturedLegacySnapshot,
  type LegacySnapshotParticipant,
  type VerifiedLegacyExportFence,
} from "../../src/modules/model-control/migration/legacy-export-snapshot.js";

const outputPath = argument("--output");
const modelDatabaseUrl = requiredEnv("DATABASE_URL_MODEL");
const siteDatabaseUrl = requiredEnv("DATABASE_URL_SITE");
const connections: Connection[] = [];
try {
  const sameDatabase = sameLegacyDatabaseIdentity(modelDatabaseUrl, siteDatabaseUrl);
  const expectedSources = sameDatabase
    ? [{ name: "model+site", databaseIdentity: legacyMysqlDatabaseIdentity(modelDatabaseUrl) }]
    : [
        { name: "model", databaseIdentity: legacyMysqlDatabaseIdentity(modelDatabaseUrl) },
        { name: "site", databaseIdentity: legacyMysqlDatabaseIdentity(siteDatabaseUrl) },
      ];
  const fence = verifyLegacyExportFenceAttestation(
    JSON.parse(await readFile(argument("--fence-attestation"), "utf8")),
    {
      publicKey: createPublicKey(await readFile(argument("--fence-public-key"), "utf8")),
      expectedIssuer: requiredEnv("MODEL_CONTROL_FENCE_ISSUER"),
      expectedSources,
      now: new Date().toISOString(),
    },
  );
  const captures: readonly CapturedLegacySnapshot<unknown>[] = sameDatabase
    ? await captureSingleDatabase(modelDatabaseUrl, connections, fence)
    : await captureCrossDatabase(modelDatabaseUrl, siteDatabaseUrl, connections, fence);
  const modelPayload = sameDatabase
    ? payload<CombinedPayload>(captures, "model+site").model
    : payload<ModelPayload>(captures, "model");
  const sitePayload = sameDatabase
    ? payload<CombinedPayload>(captures, "model+site").site
    : payload<SitePayload>(captures, "site");
  const { providerRows, modelRows, labelRows, policyRows } = modelPayload;
  const { siteRows } = sitePayload;
  const providers = providerRows.map((row) => ({
    key: string(row.id),
    provider: string(row.provider),
    accountKey: string(row.key),
    secretRef: parseLegacySecretReference(row.secretRef),
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
    source: {
      kind: "legacy-kokoro-model",
      reference: legacySnapshotReference(argument("--source-ref"), fence, captures),
    },
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
  const modelOptionMigration = createLegacyModelOptionMigrationArtifact({
    labels: labelRows.map((row) => ({
      legacyLabelId: string(row.id),
      key: string(row.key),
      displayName: string(row.displayName),
      description: nullableString(row.description),
      featureKey: string(row.featureKey),
      tier: nullableString(row.tier),
      defaultBindingId: nullableString(row.defaultBindingId),
      status: enumValue(row.status, ["active", "disabled"] as const),
    })),
    bindings: modelRows.map((row) => ({
      legacyBindingId: string(row.id),
      modelKey: string(row.id),
      labelKeys: jsonStrings(row.labelKeys),
      priority: number(row.priority),
    })),
    referencedLabelKeys: policyRows.map((row) => string(row.labelKey)),
  });
  const bundle = createModelControlMigrationBundle({
    catalog: canonical,
    providerAvailability,
    modelOptionMigration,
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
    `${JSON.stringify({ outputPath, bundleDigest: bundle.bundleDigest, catalogDigest: canonical.digest, counts: canonical.counts, modelOptionMigration: { artifactDigest: modelOptionMigration.artifactDigest, options: modelOptionMigration.options.length, quarantine: modelOptionMigration.quarantine.length }, sitePolicies: bundle.sitePolicyCommands.length, fence: { fencedAt: fence.fencedAt, sources: captures.map(({ name, watermark }) => ({ name, watermark })) } })}\n`,
  );
} finally {
  await Promise.allSettled(connections.map((connection) => connection.end()));
}

interface ModelPayload {
  readonly providerRows: Record<string, unknown>[];
  readonly modelRows: Record<string, unknown>[];
  readonly labelRows: Record<string, unknown>[];
  readonly policyRows: Record<string, unknown>[];
}
interface SitePayload {
  readonly siteRows: Record<string, unknown>[];
}
interface CombinedPayload {
  readonly model: ModelPayload;
  readonly site: SitePayload;
}
type LegacyRow = RowDataPacket & Record<string, unknown>;

async function captureSingleDatabase(
  databaseUrl: string,
  connections: Connection[],
  fence: VerifiedLegacyExportFence,
): Promise<readonly CapturedLegacySnapshot<unknown>[]> {
  const snapshot = await openConnection(databaseUrl, connections);
  const verifier = await openConnection(databaseUrl, connections);
  return captureFencedLegacySnapshots<unknown>(
    [
      mysqlParticipant("model+site", snapshot, verifier, COMBINED_WATERMARK_SQL, async () => ({
        model: await readModelPayload(snapshot),
        site: await readSitePayload(snapshot),
      })),
    ],
    fence,
  );
}

async function captureCrossDatabase(
  modelDatabaseUrl: string,
  siteDatabaseUrl: string,
  connections: Connection[],
  fence: VerifiedLegacyExportFence,
): Promise<readonly CapturedLegacySnapshot<unknown>[]> {
  const modelSnapshot = await openConnection(modelDatabaseUrl, connections);
  const modelVerifier = await openConnection(modelDatabaseUrl, connections);
  const siteSnapshot = await openConnection(siteDatabaseUrl, connections);
  const siteVerifier = await openConnection(siteDatabaseUrl, connections);
  return captureFencedLegacySnapshots<unknown>(
    [
      mysqlParticipant("model", modelSnapshot, modelVerifier, MODEL_WATERMARK_SQL, () =>
        readModelPayload(modelSnapshot),
      ),
      mysqlParticipant("site", siteSnapshot, siteVerifier, SITE_WATERMARK_SQL, () =>
        readSitePayload(siteSnapshot),
      ),
    ],
    fence,
  );
}

function mysqlParticipant<Payload>(
  name: string,
  snapshot: Connection,
  verifier: Connection,
  watermarkSql: string,
  readPayload: () => Promise<Payload>,
): LegacySnapshotParticipant<Payload> {
  return {
    name,
    readCurrentWatermark: () => readWatermark(verifier, watermarkSql),
    beginConsistentSnapshot: async () => {
      await snapshot.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await snapshot.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
    },
    readSnapshotWatermark: () => readWatermark(snapshot, watermarkSql),
    readPayload,
    commit: () => snapshot.commit(),
    rollback: () => snapshot.rollback(),
  };
}

async function readModelPayload(connection: Connection): Promise<ModelPayload> {
  const [providerRows] = await connection.query<LegacyRow[]>(
    `SELECT id, provider, \`key\`, secretRef, priority, transportKind, status, healthStatus, updatedAt FROM model_provider_accounts WHERE deletedAt IS NULL ORDER BY provider, \`key\``,
  );
  const [modelRows] = await connection.query<LegacyRow[]>(
    `SELECT id, providerAccountId, provider, modelName, displayName, featureKey, labelKeys, inputModalities, outputModalities, transportKind, gatewayModelName, contextWindow, priority, status FROM model_bindings WHERE deletedAt IS NULL ORDER BY featureKey, priority, id`,
  );
  const [labelRows] = await connection.query<LegacyRow[]>(
    `SELECT id, \`key\`, displayName, description, featureKey, tier, defaultBindingId, status FROM model_labels ORDER BY \`key\`, id`,
  );
  const [policyRows] = await connection.query<LegacyRow[]>(
    `SELECT siteId, labelKey, status FROM model_site_policies ORDER BY siteId, labelKey`,
  );
  return { providerRows, modelRows, labelRows, policyRows };
}

async function readSitePayload(connection: Connection): Promise<SitePayload> {
  const [siteRows] = await connection.query<LegacyRow[]>(
    `SELECT id FROM site_sites WHERE deletedAt IS NULL ORDER BY id`,
  );
  return { siteRows };
}

async function readWatermark(connection: Connection, sql: string) {
  const [rows] = await connection.query<LegacyRow[]>(sql);
  return createLegacySourceWatermark(
    rows.map((row) => ({
      sourceName: string(row.sourceName),
      rowKey: string(row.rowKey),
      rowVersion: string(row.rowVersion),
      updatedAt: date(row.updatedAt),
    })),
  );
}

async function openConnection(databaseUrl: string, connections: Connection[]) {
  const connection = await mysql.createConnection({
    uri: databaseUrl,
    rowsAsArray: false,
    timezone: "Z",
  });
  connections.push(connection);
  return connection;
}

function payload<Payload>(
  captures: readonly CapturedLegacySnapshot<unknown>[],
  name: string,
): Payload {
  const capture = captures.find((candidate) => candidate.name === name);
  if (!capture) throw new Error(`MODEL_LEGACY_EXPORT_SOURCE_MISSING:${name}`);
  return capture.payload as Payload;
}

const MODEL_WATERMARK_ROWS = `
  SELECT 'model-provider' AS sourceName,id AS rowKey,updatedAt,
    SHA2(JSON_OBJECT('id',id,'provider',provider,'key',\`key\`,'secretRef',secretRef,'priority',priority,'transportKind',transportKind,'status',status,'healthStatus',healthStatus,'deletedAt',deletedAt),256) AS rowVersion
  FROM model_provider_accounts
  UNION ALL SELECT 'model-binding',id,updatedAt,
    SHA2(JSON_OBJECT('id',id,'providerAccountId',providerAccountId,'provider',provider,'modelName',modelName,'displayName',displayName,'featureKey',featureKey,'labelKeys',labelKeys,'inputModalities',inputModalities,'outputModalities',outputModalities,'transportKind',transportKind,'gatewayModelName',gatewayModelName,'contextWindow',contextWindow,'priority',priority,'status',status,'deletedAt',deletedAt),256)
  FROM model_bindings
  UNION ALL SELECT 'model-label',id,updatedAt,
    SHA2(JSON_OBJECT('id',id,'key',\`key\`,'displayName',displayName,'description',description,'featureKey',featureKey,'tier',tier,'defaultBindingId',defaultBindingId,'status',status),256)
  FROM model_labels
  UNION ALL SELECT 'model-site-policy',id,updatedAt,
    SHA2(JSON_OBJECT('id',id,'siteId',siteId,'labelKey',labelKey,'status',status),256)
  FROM model_site_policies`;
const SITE_WATERMARK_ROWS = `SELECT 'site' AS sourceName,id AS rowKey,updatedAt,
  SHA2(JSON_OBJECT('id',id,'deletedAt',deletedAt),256) AS rowVersion FROM site_sites`;
const MODEL_WATERMARK_SQL = `SELECT sourceName,rowKey,rowVersion,updatedAt FROM (${MODEL_WATERMARK_ROWS}) source_rows ORDER BY sourceName,rowKey`;
const SITE_WATERMARK_SQL = `SELECT sourceName,rowKey,rowVersion,updatedAt FROM (${SITE_WATERMARK_ROWS}) source_rows ORDER BY sourceName,rowKey`;
const COMBINED_WATERMARK_SQL = `SELECT sourceName,rowKey,rowVersion,updatedAt FROM (${MODEL_WATERMARK_ROWS} UNION ALL ${SITE_WATERMARK_ROWS}) source_rows ORDER BY sourceName,rowKey`;

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
    const generation = rows
      .filter((row) => row.featureKey === product && row.status === "active")
      .sort(byPriority)
      .map((row, position) => ({
        product,
        role: "generation" as const,
        modelKey: string(row.id),
        position,
        requiredCapabilities: [`${product}.generate`],
      }));
    if (generation.length > 0) {
      result.push(...chat.map((route) => ({ ...route, product })));
      result.push(...generation);
    }
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
  const left = string(a.id);
  const right = string(b.id);
  return number(a.priority) - number(b.priority) || (left < right ? -1 : left > right ? 1 : 0);
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
function date(value: unknown): string | Date {
  if (value instanceof Date || typeof value === "string") return value;
  throw new Error("LEGACY_DATE_INVALID");
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
