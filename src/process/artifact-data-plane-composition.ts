import { randomUUID } from "node:crypto";
import type { RequestListener } from "node:http";
import { createServer as createHttpsServer, type Server, type ServerOptions } from "node:https";
import { S3Client } from "@aws-sdk/client-s3";
import {
  createArtifactDataPlaneHttpHandler,
  type ArtifactDataPlaneHttpHandler,
  type ArtifactDeliveryDataPlanePort,
} from "../interfaces/http/artifact-data-plane.js";
import {
  ArtifactDeliveryService,
  PostgresArtifactDeliveryRepository,
  S3ArtifactObjectStore,
} from "../modules/artifact/index.js";
import { parseArtifactDeliveryCapabilityKey } from
  "../modules/artifact/infrastructure/config/artifact-delivery-capability-key.js";
import { ArtifactDeliveryCapabilityCodec } from
  "../modules/artifact/infrastructure/crypto/artifact-delivery-capability.js";
import { ProductWorkloadRegistry } from
  "../modules/authorization/infrastructure/transport/product-workload-registry.js";
import { createBoundedFileReaderWithinTrustRoot } from "./secret-files.js";
import type { ArtifactDataPlaneDatabase } from "./artifact-data-plane-database.js";

export const ARTIFACT_DATA_PLANE_OWNER_ADAPTER_REVISION = "postgres-s3-v1";

export interface ArtifactDataPlaneRuntime extends ArtifactDeliveryDataPlanePort {
  checkHealth(): Promise<void>;
  close(): Promise<void>;
}

export interface ArtifactDataPlaneProductionComposition {
  readonly handler: ArtifactDataPlaneHttpHandler;
  checkHealth(): Promise<void>;
  close(): Promise<void>;
  createServer(listener: RequestListener): Server;
}

/** Certified built-in PostgreSQL owner + private S3 reader composition. */
export async function createArtifactDataPlaneProductionComposition(input: Readonly<{
  database: ArtifactDataPlaneDatabase;
  environment?: Readonly<Record<string, string | undefined>>;
  loadWorkloads?: () => Promise<ProductWorkloadRegistry>;
  loadRuntime?: () => Promise<ArtifactDataPlaneRuntime>;
  loadTls?: () => Promise<ServerOptions>;
}>): Promise<ArtifactDataPlaneProductionComposition> {
  const environment = input.environment ?? process.env;
  const revision = required(environment, "PLATFORM_ARTIFACT_DATA_PLANE_OWNER_ADAPTER_REVISION");
  if (revision !== ARTIFACT_DATA_PLANE_OWNER_ADAPTER_REVISION) {
    throw new Error("ARTIFACT_DATA_PLANE_OWNER_ADAPTER_NOT_CERTIFIED");
  }
  const needsReader = input.loadWorkloads === undefined || input.loadRuntime === undefined ||
    input.loadTls === undefined;
  const reader = needsReader ? await createBoundedFileReaderWithinTrustRoot(
    required(environment, "PLATFORM_ARTIFACT_DATA_PLANE_FILE_TRUST_ROOT"),
    "PLATFORM_ARTIFACT_DATA_PLANE_FILE_TRUST_ROOT_INVALID",
  ) : undefined;
  const [workloads, runtime, tls] = await Promise.all([
    input.loadWorkloads?.() ?? loadWorkloads(environment, reader!),
    input.loadRuntime?.() ?? loadRuntime(input.database, environment, reader!),
    input.loadTls?.() ?? loadTls(environment, reader!),
  ]);
  const handler = createArtifactDataPlaneHttpHandler({
    workloads,
    delivery: runtime,
    requestId: randomUUID,
  });
  return Object.freeze({
    handler,
    checkHealth: () => runtime.checkHealth(),
    close: () => runtime.close(),
    createServer: (listener: RequestListener) => createHttpsServer(tls, listener),
  });
}

type TrustedReader = Awaited<ReturnType<typeof createBoundedFileReaderWithinTrustRoot>>;

async function loadWorkloads(
  environment: Readonly<Record<string, string | undefined>>,
  reader: TrustedReader,
): Promise<ProductWorkloadRegistry> {
  const raw = await reader.readRegular(
    required(environment, "PLATFORM_ARTIFACT_DATA_PLANE_PRODUCT_WORKLOAD_REGISTRY_FILE"),
    2 * 1024 * 1024,
    "PLATFORM_ARTIFACT_DATA_PLANE_PRODUCT_WORKLOAD_REGISTRY_FILE_INVALID",
  );
  try { return ProductWorkloadRegistry.parse(JSON.parse(raw) as unknown); }
  catch { throw new Error("PLATFORM_ARTIFACT_DATA_PLANE_PRODUCT_WORKLOAD_REGISTRY_FILE_INVALID"); }
}

async function loadRuntime(
  database: ArtifactDataPlaneDatabase,
  environment: Readonly<Record<string, string | undefined>>,
  reader: TrustedReader,
): Promise<ArtifactDataPlaneRuntime> {
  const [keyText, routeText] = await Promise.all([
    reader.readPrivate(required(environment, "PLATFORM_ARTIFACT_DELIVERY_CAPABILITY_KEY_FILE"),
      8 * 1024, "PLATFORM_ARTIFACT_DELIVERY_CAPABILITY_KEY_FILE_INVALID"),
    reader.readRegular(required(environment, "PLATFORM_ARTIFACT_PRIVATE_OBJECT_ROUTE_FILE"),
      64 * 1024, "PLATFORM_ARTIFACT_PRIVATE_OBJECT_ROUTE_FILE_INVALID"),
  ]);
  const capabilityKey = parseArtifactDeliveryCapabilityKey(keyText);
  const route = parseStorageRoute(routeText);
  const client = new S3Client({
    region: route.region,
    ...(route.endpoint === undefined ? {} : { endpoint: route.endpoint }),
    ...(route.forcePathStyle === undefined ? {} : { forcePathStyle: route.forcePathStyle }),
  });
  const repository = new PostgresArtifactDeliveryRepository(database);
  const service = new ArtifactDeliveryService({
    repository,
    audit: repository,
    objectStore: new S3ArtifactObjectStore({ client, bucket: route.bucket,
      ...(route.prefix === undefined ? {} : { prefix: route.prefix }) }),
    capabilities: new ArtifactDeliveryCapabilityCodec(capabilityKey),
    reference: (kind) => `${kind}:${randomUUID()}`,
  });
  return Object.freeze({
    redeem: (delivery: Parameters<ArtifactDeliveryDataPlanePort["redeem"]>[0]) =>
      service.redeemForWorkload(delivery),
    checkHealth: () => database.checkHealth(),
    close: async () => { client.destroy(); },
  });
}

function parseStorageRoute(value: string): Readonly<{
  region: string;
  bucket: string;
  prefix?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
}> {
  let root: unknown;
  try { root = JSON.parse(value); } catch { invalidStorageRoute(); }
  if (!record(root) || Object.keys(root).some((key) =>
    !["version", "revision", "region", "bucket", "prefix", "endpoint", "forcePathStyle"].includes(key)) ||
    root.version !== 1 || root.revision !== "artifact-private-s3-v1") invalidStorageRoute();
  const region = bounded(root.region, 1, 128);
  const bucket = bounded(root.bucket, 3, 63);
  const prefix = root.prefix === undefined ? undefined : bounded(root.prefix, 1, 256);
  const endpoint = root.endpoint === undefined ? undefined : secureEndpoint(root.endpoint);
  if (root.forcePathStyle !== undefined && typeof root.forcePathStyle !== "boolean") invalidStorageRoute();
  return Object.freeze({ region, bucket,
    ...(prefix === undefined ? {} : { prefix }), ...(endpoint === undefined ? {} : { endpoint }),
    ...(root.forcePathStyle === undefined ? {} : { forcePathStyle: root.forcePathStyle }) });
}

function invalidStorageRoute(): never {
  throw new Error("PLATFORM_ARTIFACT_PRIVATE_OBJECT_ROUTE_FILE_INVALID");
}

function secureEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length > 512) invalidStorageRoute();
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.pathname !== "/" ||
        endpoint.search || endpoint.hash || endpoint.origin !== value) invalidStorageRoute();
    return value;
  } catch { invalidStorageRoute(); }
}

async function loadTls(
  environment: Readonly<Record<string, string | undefined>>,
  reader: TrustedReader,
): Promise<ServerOptions> {
  const [key, cert, ca] = await Promise.all([
    reader.readPrivate(required(environment, "PLATFORM_ARTIFACT_DATA_PLANE_TLS_KEY_FILE"), 64 * 1024,
      "PLATFORM_ARTIFACT_DATA_PLANE_TLS_KEY_FILE_INVALID"),
    reader.readRegular(required(environment, "PLATFORM_ARTIFACT_DATA_PLANE_TLS_CERT_FILE"), 256 * 1024,
      "PLATFORM_ARTIFACT_DATA_PLANE_TLS_CERT_FILE_INVALID"),
    reader.readRegular(required(environment, "PLATFORM_ARTIFACT_DATA_PLANE_TLS_CLIENT_CA_FILE"), 512 * 1024,
      "PLATFORM_ARTIFACT_DATA_PLANE_TLS_CLIENT_CA_FILE_INVALID"),
  ]);
  if (!key.includes("BEGIN PRIVATE KEY") || !cert.includes("BEGIN CERTIFICATE") ||
      !ca.includes("BEGIN CERTIFICATE")) throw new Error("PLATFORM_ARTIFACT_DATA_PLANE_TLS_MATERIAL_INVALID");
  return Object.freeze({ key, cert, ca, requestCert: true, rejectUnauthorized: true,
    minVersion: "TLSv1.3" as const, honorCipherOrder: true });
}

function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function bounded(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum ||
      value.trim() !== value || [...value].some((character) => {
        const point = character.codePointAt(0) ?? 0; return point < 32 || point === 127;
      })) invalidStorageRoute();
  return value;
}
