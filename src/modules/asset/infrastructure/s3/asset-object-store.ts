import { createHash } from "node:crypto";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  type GetObjectOutput,
  type HeadObjectOutput,
} from "@aws-sdk/client-s3";
import type { AssetQuarantineObjectStorePort } from "../../application/contracts/asset-completion-worker-ports.js";
import type { AssetTrustedObjectStorePort } from "../../application/contracts/asset-promotion-worker-ports.js";
import type { AssetObjectCleanupStorePort } from
  "../../application/contracts/asset-cleanup-worker-ports.js";

export interface AssetS3StorageRoute {
  readonly storageTenantRef: string;
  readonly storageRegion: string;
  readonly bucket: string;
  readonly endpoint?: string;
  readonly forcePathStyle?: boolean;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly maximumObjectBytes: bigint;
}

type AssetS3Client = Pick<S3Client, "send">;

type ResolvedRoute = Readonly<{
  configuration: AssetS3StorageRoute;
  client: AssetS3Client;
}>;

export class S3AssetObjectStore implements
  AssetQuarantineObjectStorePort, AssetTrustedObjectStorePort, AssetObjectCleanupStorePort {
  private readonly routes = new Map<string, ResolvedRoute>();

  constructor(
    routes: readonly AssetS3StorageRoute[],
    clientFactory: (route: AssetS3StorageRoute) => AssetS3Client = createClient,
  ) {
    if (routes.length === 0) throw new Error("ASSET_STORAGE_ROUTE_REQUIRED");
    for (const route of routes) {
      validateRoute(route);
      const key = routeKey(route.storageTenantRef, route.storageRegion);
      if (this.routes.has(key)) throw new Error("ASSET_STORAGE_ROUTE_DUPLICATE");
      this.routes.set(key, Object.freeze({ configuration: route, client: clientFactory(route) }));
    }
  }

  async observe(input: Readonly<{
    storageTenantRef: string;
    storageRegion: string;
    quarantineObjectRef: string;
  }>) {
    const route = this.resolve(input.storageTenantRef, input.storageRegion);
    const head = await this.head(route, input.quarantineObjectRef);
    if (head === null) return Object.freeze({ disposition: "absent" as const,
      observedAt: new Date().toISOString() });
    const versionRef = immutableVersion(head);
    const size = objectSize(head, route.configuration.maximumObjectBytes);
    return Object.freeze({ disposition: "present" as const,
      providerVersionRef: versionRef,
      providerEtagDigest: etagDigest(head.ETag),
      size,
      checksumSha256: providerChecksum(head),
      observedAt: new Date().toISOString() });
  }

  async computeSha256(input: Readonly<{
    storageTenantRef: string;
    storageRegion: string;
    quarantineObjectRef: string;
    providerVersionRef: string;
    maximumBytes: bigint;
  }>): Promise<string> {
    const route = this.resolve(input.storageTenantRef, input.storageRegion);
    const maximumBytes = minimum(input.maximumBytes, route.configuration.maximumObjectBytes);
    return this.readChecksum(route, input.quarantineObjectRef, input.providerVersionRef,
      maximumBytes);
  }

  async copyExact(input: Readonly<{
    storageTenantRef: string;
    storageRegion: string;
    sourceObjectRef: string;
    sourceProviderVersionRef: string;
    targetObjectRef: string;
    expectedChecksumSha256: string;
    expectedSize: bigint;
    idempotencyKey: string;
  }>): Promise<Readonly<{ disposition: "accepted" | "outcome_unknown" }>> {
    digest(input.expectedChecksumSha256);
    const route = this.resolve(input.storageTenantRef, input.storageRegion);
    enforceMaximum(input.expectedSize, route.configuration.maximumObjectBytes);
    const existing = await this.head(route, input.targetObjectRef);
    if (existing !== null) {
      try {
        await this.assertExactTarget(route, input.targetObjectRef, existing,
          input.expectedSize, input.expectedChecksumSha256);
        return Object.freeze({ disposition: "accepted" });
      } catch (error) {
        if (error instanceof Error && error.message === "ASSET_TRUSTED_OBJECT_CONFLICT") {
          // The promotion service observes and freezes the conflicting target version, then
          // rejects the promotion and creates exact cleanup work for both physical copies.
          return Object.freeze({ disposition: "outcome_unknown" });
        }
        throw error;
      }
    }
    const source = await this.head(route, input.sourceObjectRef, input.sourceProviderVersionRef);
    if (source === null || immutableVersion(source) !== input.sourceProviderVersionRef) {
      throw new Error("ASSET_QUARANTINE_VERSION_NOT_FOUND");
    }
    const sourceSize = objectSize(source, route.configuration.maximumObjectBytes);
    const sourceChecksum = providerChecksum(source) ?? await this.readChecksum(route,
      input.sourceObjectRef, input.sourceProviderVersionRef, input.expectedSize);
    if (sourceSize !== input.expectedSize || sourceChecksum !== input.expectedChecksumSha256) {
      throw new Error("ASSET_QUARANTINE_VERSION_MISMATCH");
    }
    try {
      await route.client.send(new CopyObjectCommand({
        Bucket: route.configuration.bucket,
        Key: input.targetObjectRef,
        CopySource: copySource(route.configuration.bucket, input.sourceObjectRef,
          input.sourceProviderVersionRef),
        ChecksumAlgorithm: "SHA256",
        MetadataDirective: "COPY",
      }));
      return Object.freeze({ disposition: "accepted" });
    } catch {
      // Copy may have committed even when the response was lost. The durable worker observes
      // the destination by immutable version before deciding whether to retry.
      return Object.freeze({ disposition: "outcome_unknown" });
    }
  }

  async observeTrusted(input: Readonly<{
    storageTenantRef: string;
    storageRegion: string;
    trustedObjectRef: string;
  }>) {
    const route = this.resolve(input.storageTenantRef, input.storageRegion);
    const head = await this.head(route, input.trustedObjectRef);
    if (head === null) return Object.freeze({ disposition: "absent" as const,
      observedAt: new Date().toISOString() });
    const providerVersionRef = immutableVersion(head);
    const size = objectSize(head, route.configuration.maximumObjectBytes);
    const checksumSha256 = providerChecksum(head) ?? await this.readChecksum(route,
      input.trustedObjectRef, providerVersionRef, size);
    return Object.freeze({ disposition: "present" as const, providerVersionRef,
      providerEtagDigest: etagDigest(head.ETag), size, checksumSha256,
      observedAt: new Date().toISOString() });
  }

  async deleteExact(input: Readonly<{
    storageTenantRef: string;
    storageRegion: string;
    objectRef: string;
    providerVersionRef: string;
    expectedSize: bigint;
  }>) {
    const route = this.resolve(input.storageTenantRef, input.storageRegion);
    const before = await this.head(route, input.objectRef, input.providerVersionRef);
    if (before === null) return Object.freeze({ disposition: "confirmed_absent" as const,
      providerDisposition: "already_absent" as const, observedAt: new Date().toISOString() });
    if (immutableVersion(before) !== input.providerVersionRef ||
        objectSize(before, route.configuration.maximumObjectBytes) !== input.expectedSize) {
      throw new Error("ASSET_CLEANUP_OBJECT_VERSION_MISMATCH");
    }
    let providerDisposition: "deleted" | "absent_after_unknown" = "deleted";
    try {
      await route.client.send(new DeleteObjectCommand({
        Bucket: route.configuration.bucket,
        Key: input.objectRef,
        VersionId: input.providerVersionRef,
      }));
    } catch {
      providerDisposition = "absent_after_unknown";
    }
    const after = await this.head(route, input.objectRef, input.providerVersionRef);
    return after === null
      ? Object.freeze({ disposition: "confirmed_absent" as const, providerDisposition,
        observedAt: new Date().toISOString() })
      : Object.freeze({ disposition: "retry" as const,
        code: "ASSET_OBJECT_DELETE_OUTCOME_UNKNOWN" as const });
  }

  private resolve(storageTenantRef: string, storageRegion: string): ResolvedRoute {
    const route = this.routes.get(routeKey(storageTenantRef, storageRegion));
    if (route === undefined) throw new Error("ASSET_STORAGE_ROUTE_NOT_FOUND");
    return route;
  }

  private async head(
    route: ResolvedRoute,
    objectRef: string,
    versionRef?: string,
  ): Promise<HeadObjectOutput | null> {
    validateObjectRef(objectRef);
    try {
      return await route.client.send(new HeadObjectCommand({
        Bucket: route.configuration.bucket,
        Key: objectRef,
        VersionId: versionRef,
        ChecksumMode: "ENABLED",
      }));
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  private async readChecksum(
    route: ResolvedRoute,
    objectRef: string,
    versionRef: string,
    maximumBytes: bigint,
  ): Promise<string> {
    const output: GetObjectOutput = await route.client.send(new GetObjectCommand({
      Bucket: route.configuration.bucket,
      Key: objectRef,
      VersionId: versionRef,
      ChecksumMode: "ENABLED",
    }));
    if (output.VersionId !== undefined && output.VersionId !== versionRef) {
      throw new Error("ASSET_OBJECT_VERSION_MISMATCH");
    }
    if (output.ContentLength !== undefined) enforceMaximum(BigInt(output.ContentLength), maximumBytes);
    if (output.Body === undefined) throw new Error("ASSET_OBJECT_BODY_MISSING");
    const hash = createHash("sha256");
    let bytes = 0n;
    const body = output.Body as unknown as AsyncIterable<Uint8Array>;
    if (typeof body[Symbol.asyncIterator] !== "function") {
      throw new Error("ASSET_OBJECT_STREAM_UNSUPPORTED");
    }
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += BigInt(buffer.byteLength);
      enforceMaximum(bytes, maximumBytes);
      hash.update(buffer);
    }
    return hash.digest("hex");
  }

  private async assertExactTarget(
    route: ResolvedRoute,
    objectRef: string,
    head: HeadObjectOutput,
    expectedSize: bigint,
    expectedChecksum: string,
  ): Promise<void> {
    const versionRef = immutableVersion(head);
    const size = objectSize(head, route.configuration.maximumObjectBytes);
    const checksum = providerChecksum(head) ?? await this.readChecksum(route, objectRef,
      versionRef, expectedSize);
    if (size !== expectedSize || checksum !== expectedChecksum) {
      throw new Error("ASSET_TRUSTED_OBJECT_CONFLICT");
    }
  }
}

function createClient(route: AssetS3StorageRoute): S3Client {
  const hasCredentials = route.accessKeyId !== undefined || route.secretAccessKey !== undefined;
  if (hasCredentials && (route.accessKeyId === undefined || route.secretAccessKey === undefined)) {
    throw new Error("ASSET_STORAGE_CREDENTIALS_INCOMPLETE");
  }
  return new S3Client({ region: route.storageRegion,
    ...(route.endpoint === undefined ? {} : { endpoint: route.endpoint }),
    ...(route.forcePathStyle === undefined ? {} : { forcePathStyle: route.forcePathStyle }),
    ...(hasCredentials ? { credentials: {
      accessKeyId: route.accessKeyId!, secretAccessKey: route.secretAccessKey!,
    } } : {}) });
}

function validateRoute(route: AssetS3StorageRoute): void {
  if (route.storageTenantRef.length < 3 || route.storageRegion.length < 3 ||
      route.bucket.length < 3 || route.maximumObjectBytes < 1n) {
    throw new Error("ASSET_STORAGE_ROUTE_INVALID");
  }
}

function routeKey(storageTenantRef: string, storageRegion: string): string {
  return `${storageTenantRef}\u0000${storageRegion}`;
}

function validateObjectRef(value: string): void {
  if (value.length < 8 || value.length > 1_024 || value.startsWith("/") || value.includes("\0")) {
    throw new Error("ASSET_OBJECT_REF_INVALID");
  }
}

function immutableVersion(output: HeadObjectOutput): string {
  if (output.VersionId === undefined || output.VersionId.length < 1 || output.VersionId === "null") {
    throw new Error("ASSET_STORAGE_VERSIONING_REQUIRED");
  }
  return output.VersionId;
}

function objectSize(output: HeadObjectOutput, maximumBytes: bigint): bigint {
  if (output.ContentLength === undefined || output.ContentLength < 1) {
    throw new Error("ASSET_OBJECT_SIZE_INVALID");
  }
  const size = BigInt(output.ContentLength);
  enforceMaximum(size, maximumBytes);
  return size;
}

function providerChecksum(output: HeadObjectOutput): string | null {
  const metadataChecksum = output.Metadata?.["sha256"];
  if (metadataChecksum !== undefined) {
    digest(metadataChecksum);
    return metadataChecksum;
  }
  if (output.ChecksumSHA256 === undefined) return null;
  const bytes = Buffer.from(output.ChecksumSHA256, "base64");
  if (bytes.byteLength !== 32) throw new Error("ASSET_PROVIDER_CHECKSUM_INVALID");
  return bytes.toString("hex");
}

function etagDigest(value: string | undefined): string {
  if (value === undefined || value.length < 1) throw new Error("ASSET_PROVIDER_ETAG_REQUIRED");
  return createHash("sha256").update(value).digest("hex");
}

function enforceMaximum(value: bigint, maximum: bigint): void {
  if (value < 1n || value > maximum) throw new Error("ASSET_OBJECT_READ_LIMIT_EXCEEDED");
}

function minimum(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function copySource(bucket: string, objectRef: string, versionRef: string): string {
  return `${encodeURIComponent(`${bucket}/${objectRef}`)}?versionId=${encodeURIComponent(versionRef)}`;
}

function digest(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("ASSET_OBJECT_CHECKSUM_INVALID");
}

function notFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return candidate.name === "NotFound" || candidate.name === "NoSuchKey" ||
    candidate.name === "NoSuchVersion" ||
    candidate.$metadata?.httpStatusCode === 404;
}
