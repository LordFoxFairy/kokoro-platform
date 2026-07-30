import { constants as fileSystemConstants } from "node:fs";
import { open } from "node:fs/promises";
import type { RequestListener } from "node:http";
import { createServer as createHttpsServer, type Server } from "node:https";
import type { ServerOptions } from "node:https";
import type { PlatformTransactionalDatabaseClient } from "../infrastructure/postgres/client.js";
import {
  createAssetDataPlaneHttpHandler,
  type AssetDataPlaneHttpHandler,
} from "../interfaces/http/asset-data-plane.js";
import { AssetMultipartService } from
  "../modules/asset/application/services/asset-multipart-service.js";
import { AssetMultipartUnitOfWork } from
  "../modules/asset/infrastructure/postgres/asset-multipart-unit-of-work.js";
import { PostgresAssetMultipartRepository } from
  "../modules/asset/infrastructure/postgres/asset-multipart-repository.js";
import {
  AssetUploadPolicyRegistry,
  parseAssetUploadPolicyRegistry,
} from "../modules/asset/infrastructure/config/asset-upload-policy-registry.js";
import {
  parseAssetUploadCapabilityKeyRing,
  SealedAssetUploadCapabilityIssuer,
} from "../modules/asset/infrastructure/crypto/asset-upload-capability.js";
import {
  S3AssetObjectStore,
  type AssetS3StorageRoute,
} from "../modules/asset/infrastructure/s3/asset-object-store.js";

export interface AssetDataPlaneProductionComposition {
  readonly handler: AssetDataPlaneHttpHandler;
  createServer(listener: RequestListener): Server;
}

/**
 * Production composition for the browser-facing upload listener. It owns only
 * the capability-authorized multipart boundary; owner intent creation remains
 * on Platform Public and provider credentials remain inside this process.
 */
export async function createAssetDataPlaneProductionComposition(input: Readonly<{
  database: PlatformTransactionalDatabaseClient;
  environment?: Readonly<Record<string, string | undefined>>;
  clock?: () => Date;
}>): Promise<AssetDataPlaneProductionComposition> {
  const environment = input.environment ?? process.env;
  const audience = required(environment, "PLATFORM_ASSET_DATA_PLANE_AUDIENCE");
  const [policies, capabilityKeys, storageRoutes, tls] = await Promise.all([
    loadPolicies(required(environment, "PLATFORM_ASSET_UPLOAD_POLICY_REGISTRY_FILE")),
    loadCapabilityKeys(required(environment, "PLATFORM_ASSET_UPLOAD_CAPABILITY_KEY_RING_FILE")),
    loadStorageRoutes(required(environment, "PLATFORM_ASSET_STORAGE_ROUTE_FILE")),
    loadTls(environment),
  ]);
  // Startup fails when the listener audience has no single policy-owned endpoint.
  policies.resolveEndpoint(audience);
  const service = new AssetMultipartService({
    unitOfWork: new AssetMultipartUnitOfWork(input.database),
    repository: new PostgresAssetMultipartRepository(),
    store: new S3AssetObjectStore(storageRoutes),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  const capabilities = new SealedAssetUploadCapabilityIssuer(capabilityKeys, policies);
  const handler = createAssetDataPlaneHttpHandler({
    expectedAudience: audience,
    capabilities,
    policies,
    multipart: service,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  return Object.freeze({
    handler,
    createServer: (listener: RequestListener) => createHttpsServer(tls, listener),
  });
}

export function parseAssetStorageRouteRegistry(value: unknown): readonly AssetS3StorageRoute[] {
  const root = record(value);
  exact(root, ["version", "routes"]);
  if (root.version !== 1 || !Array.isArray(root.routes) ||
      root.routes.length < 1 || root.routes.length > 256) invalidRegistry();
  const routes = root.routes.map(parseStorageRoute);
  const identities = new Set(routes.map((route) => `${route.storageTenantRef}\0${route.storageRegion}`));
  if (identities.size !== routes.length) invalidRegistry();
  return Object.freeze(routes);
}

function parseStorageRoute(value: unknown): AssetS3StorageRoute {
  const route = record(value);
  exact(route, [
    "storageTenantRef", "storageRegion", "bucket", "endpoint", "forcePathStyle",
    "accessKeyId", "secretAccessKey", "maximumObjectBytes",
  ]);
  const storageTenantRef = boundedText(route.storageTenantRef, 3, 256);
  const storageRegion = boundedText(route.storageRegion, 3, 128);
  const bucket = boundedText(route.bucket, 3, 255);
  const maximumObjectBytes = positiveUint64(route.maximumObjectBytes);
  if (route.forcePathStyle !== undefined && typeof route.forcePathStyle !== "boolean") invalidRegistry();
  const accessKeyId = optionalSecret(route.accessKeyId, 1, 512);
  const secretAccessKey = optionalSecret(route.secretAccessKey, 1, 2_048);
  if ((accessKeyId === undefined) !== (secretAccessKey === undefined)) invalidRegistry();
  const endpoint = optionalEndpoint(route.endpoint);
  return Object.freeze({
    storageTenantRef,
    storageRegion,
    bucket,
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(route.forcePathStyle === undefined ? {} : { forcePathStyle: route.forcePathStyle }),
    ...(accessKeyId === undefined ? {} : { accessKeyId, secretAccessKey: secretAccessKey! }),
    maximumObjectBytes,
  });
}

async function loadPolicies(path: string): Promise<AssetUploadPolicyRegistry> {
  return parseAssetUploadPolicyRegistry(
    JSON.parse(await readBoundedFile(path, 2 * 1024 * 1024, false)) as unknown,
  );
}

async function loadCapabilityKeys(path: string) {
  return parseAssetUploadCapabilityKeyRing(
    JSON.parse(await readBoundedFile(path, 64 * 1024, true)) as unknown,
  );
}

async function loadStorageRoutes(path: string): Promise<readonly AssetS3StorageRoute[]> {
  return parseAssetStorageRouteRegistry(
    JSON.parse(await readBoundedFile(path, 512 * 1024, true)) as unknown,
  );
}

async function loadTls(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<ServerOptions> {
  const [key, cert] = await Promise.all([
    readBoundedFile(required(environment, "PLATFORM_ASSET_DATA_PLANE_TLS_KEY_FILE"), 64 * 1024, true),
    readBoundedFile(required(environment, "PLATFORM_ASSET_DATA_PLANE_TLS_CERT_FILE"), 256 * 1024, false),
  ]);
  if (!key.includes("BEGIN PRIVATE KEY") || !cert.includes("BEGIN CERTIFICATE")) {
    throw new Error("PLATFORM_ASSET_DATA_PLANE_TLS_MATERIAL_INVALID");
  }
  return Object.freeze({
    key,
    cert,
    requestCert: false,
    rejectUnauthorized: false,
    minVersion: "TLSv1.3" as const,
    honorCipherOrder: true,
  });
}

async function readBoundedFile(
  path: string,
  maximumBytes: number,
  privateFile: boolean,
): Promise<string> {
  if (!path.startsWith("/")) throw new Error("PLATFORM_ASSET_DATA_PLANE_FILE_MUST_BE_ABSOLUTE");
  let handle;
  try {
    handle = await open(path, fileSystemConstants.O_RDONLY | fileSystemConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() || metadata.size < 1 || metadata.size > maximumBytes ||
      (privateFile && (metadata.mode & 0o077) !== 0)
    ) throw new Error("PLATFORM_ASSET_DATA_PLANE_FILE_INVALID");
    const value = await handle.readFile("utf8");
    if (Buffer.byteLength(value, "utf8") > maximumBytes) {
      throw new Error("PLATFORM_ASSET_DATA_PLANE_FILE_INVALID");
    }
    return value;
  } catch (error) {
    if (error instanceof Error && [
      "PLATFORM_ASSET_DATA_PLANE_FILE_MUST_BE_ABSOLUTE",
      "PLATFORM_ASSET_DATA_PLANE_FILE_INVALID",
    ].includes(error.message)) throw error;
    throw new Error("PLATFORM_ASSET_DATA_PLANE_FILE_INVALID", { cause: error });
  } finally {
    await handle?.close();
  }
}

function optionalEndpoint(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 512) invalidRegistry();
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" ||
      parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "" || parsed.origin !== value
    ) invalidRegistry();
    return value;
  } catch {
    invalidRegistry();
  }
}

function optionalSecret(value: unknown, minimum: number, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return boundedText(value, minimum, maximum);
}

function boundedText(value: unknown, minimum: number, maximum: number): string {
  if (
    typeof value !== "string" || value.length < minimum || value.length > maximum ||
    value.trim() !== value || [...value].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point < 32 || point === 127;
    })
  ) invalidRegistry();
  return value;
}

function positiveUint64(value: unknown): bigint {
  if (
    typeof value !== "string" || !/^[1-9][0-9]{0,19}$/u.test(value) ||
    (value.length === 20 && value > "18446744073709551615")
  ) invalidRegistry();
  return BigInt(value);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalidRegistry();
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, names: readonly string[]): void {
  if (Object.keys(value).some((name) => !names.includes(name))) invalidRegistry();
}

function invalidRegistry(): never {
  throw new Error("ASSET_STORAGE_ROUTE_REGISTRY_INVALID");
}

function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
