import { createHash } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { ArtifactObjectStore } from "../../application/contracts.js";
import type { ArtifactReadyReceipt, ArtifactStagedReceipt } from "../../domain/artifact.js";
import { snapshotArtifactOwnerScope } from "../../domain/artifact.js";

const MAXIMUM_ARTIFACT_BYTES = 32 * 1024 * 1024;
type MediaType = "image/png" | "image/jpeg" | "image/webp";

/** S3-compatible private object adapter. PostgreSQL remains the Artifact metadata owner. */
export class S3ArtifactObjectStore implements ArtifactObjectStore {
  readonly #prefix: string;

  constructor(private readonly dependencies: Readonly<{
    client: Pick<S3Client, "send">;
    bucket: string;
    prefix?: string;
  }>) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(dependencies.bucket)) {
      throw new Error("ARTIFACT_S3_BUCKET_INVALID");
    }
    const prefix = dependencies.prefix ?? "kokoro/artifacts/v1";
    if (!/^[A-Za-z0-9][A-Za-z0-9/_-]{0,255}$/u.test(prefix) || prefix.endsWith("/")) {
      throw new Error("ARTIFACT_S3_PREFIX_INVALID");
    }
    this.#prefix = prefix;
  }

  async stage(input: Parameters<ArtifactObjectStore["stage"]>[0]): Promise<ArtifactStagedReceipt> {
    const ownerScope = snapshotArtifactOwnerScope(input.ownerScope);
    reference(input.artifactRef);
    reference(input.artifactVersionRef);
    if (input.bytes.byteLength < 1 || input.bytes.byteLength > MAXIMUM_ARTIFACT_BYTES) {
      throw new Error("ARTIFACT_STAGE_SIZE_INVALID");
    }
    const contentSha256 = createHash("sha256").update(input.bytes).digest("hex");
    const stagedKey = this.#key("staged", ownerScope, input.artifactRef, input.artifactVersionRef);
    const readyKey = this.#key("ready", ownerScope, input.artifactRef, input.artifactVersionRef);
    const ready = await this.#head(readyKey);
    if (ready !== null) {
      assertObject(ready, contentSha256, input.bytes.byteLength, input.mediaType);
      return stagedReceipt(ownerScope, input.artifactRef, input.artifactVersionRef,
        stagedKey, contentSha256, input.bytes.byteLength, input.mediaType);
    }
    const prior = await this.#head(stagedKey);
    if (prior !== null) {
      assertObject(prior, contentSha256, input.bytes.byteLength, input.mediaType);
      return stagedReceipt(ownerScope, input.artifactRef, input.artifactVersionRef,
        stagedKey, contentSha256, input.bytes.byteLength, input.mediaType);
    }
    try {
      await this.dependencies.client.send(new PutObjectCommand({
        Bucket: this.dependencies.bucket,
        Key: stagedKey,
        Body: input.bytes,
        ContentLength: input.bytes.byteLength,
        ContentType: input.mediaType,
        ChecksumSHA256: Buffer.from(contentSha256, "hex").toString("base64"),
        IfNoneMatch: "*",
        Metadata: { "content-sha256": contentSha256, "byte-size": String(input.bytes.byteLength) },
        ServerSideEncryption: "AES256",
      }));
    } catch (error) {
      const raced = await this.#head(stagedKey);
      if (raced === null) throw error;
      assertObject(raced, contentSha256, input.bytes.byteLength, input.mediaType);
    }
    return stagedReceipt(ownerScope, input.artifactRef, input.artifactVersionRef,
      stagedKey, contentSha256, input.bytes.byteLength, input.mediaType);
  }

  async promote(input: Parameters<ArtifactObjectStore["promote"]>[0]): Promise<ArtifactReadyReceipt> {
    const staged = input.stagedReceipt;
    const ownerScope = snapshotArtifactOwnerScope(staged.ownerScope);
    reference(staged.artifactRef);
    reference(staged.artifactVersionRef);
    if (input.trustDecision.kind !== "allow") throw new Error("ARTIFACT_OUTPUT_RESTRICTED");
    if (input.trustDecision.contentSha256 !== staged.contentSha256) {
      throw new Error("ARTIFACT_TRUST_BINDING_MISMATCH");
    }
    const stagedKey = this.#key("staged", ownerScope, staged.artifactRef, staged.artifactVersionRef);
    const readyKey = this.#key("ready", ownerScope, staged.artifactRef, staged.artifactVersionRef);
    if (staged.stagedObjectRef !== objectRef(stagedKey)) throw new Error("ARTIFACT_TRUST_BINDING_MISMATCH");
    const readyPrior = await this.#head(readyKey);
    if (readyPrior !== null) {
      assertObject(readyPrior, staged.contentSha256, Number(staged.byteSize), staged.mediaType);
      if (readyPrior.metadata["trust-decision-ref"] !== input.trustDecision.decisionRef) {
        throw new Error("ARTIFACT_TRUST_BINDING_MISMATCH");
      }
      return readyReceipt(staged, readyKey, input.trustDecision.decisionRef,
        await this.#cleanupStaged(stagedKey));
    }
    const source = await this.#head(stagedKey);
    if (source === null) throw new Error("ARTIFACT_STAGED_OBJECT_NOT_FOUND");
    assertObject(source, staged.contentSha256, Number(staged.byteSize), staged.mediaType);
    let fetched;
    try {
      fetched = await this.dependencies.client.send(new GetObjectCommand({
        Bucket: this.dependencies.bucket,
        Key: stagedKey,
        IfMatch: source.eTag,
      }));
    } catch (error) {
      if (preconditionFailed(error)) throw new Error("ARTIFACT_PROMOTION_SOURCE_CHANGED");
      throw error;
    }
    if (fetched.Body === undefined || fetched.ContentLength !== Number(staged.byteSize)) {
      throw new Error("ARTIFACT_PROMOTION_SOURCE_CHANGED");
    }
    const bytes = await collectBoundedBody(fetched.Body, Number(staged.byteSize));
    if (createHash("sha256").update(bytes).digest("hex") !== staged.contentSha256) {
      throw new Error("ARTIFACT_PROMOTION_SOURCE_CHANGED");
    }
    try {
      await this.dependencies.client.send(new PutObjectCommand({
        Bucket: this.dependencies.bucket,
        Key: readyKey,
        Body: bytes,
        ContentLength: bytes.byteLength,
        ContentType: staged.mediaType,
        ChecksumSHA256: Buffer.from(staged.contentSha256, "hex").toString("base64"),
        IfNoneMatch: "*",
        Metadata: { "content-sha256": staged.contentSha256,
          "byte-size": staged.byteSize.toString(),
          "trust-decision-ref": input.trustDecision.decisionRef },
        ServerSideEncryption: "AES256",
      }));
    } catch (error) {
      const raced = await this.#head(readyKey);
      if (raced === null) throw error;
      assertReadyObject(raced, staged, input.trustDecision.decisionRef);
      return readyReceipt(staged, readyKey, input.trustDecision.decisionRef,
        await this.#cleanupStaged(stagedKey));
    }
    const promoted = await this.#head(readyKey);
    if (promoted === null) throw new Error("ARTIFACT_PROMOTION_UNCONFIRMED");
    assertReadyObject(promoted, staged, input.trustDecision.decisionRef);
    return readyReceipt(staged, readyKey, input.trustDecision.decisionRef,
      await this.#cleanupStaged(stagedKey));
  }

  async describeReady(input: Parameters<ArtifactObjectStore["describeReady"]>[0]):
  Promise<ArtifactReadyReceipt | null> {
    const ownerScope = snapshotArtifactOwnerScope(input.ownerScope);
    reference(input.artifactRef);
    reference(input.artifactVersionRef);
    const key = this.#key("ready", ownerScope, input.artifactRef, input.artifactVersionRef);
    const head = await this.#head(key);
    if (head === null) return null;
    const metadata = objectMetadata(head);
    const trustDecisionRef = head.metadata["trust-decision-ref"];
    if (trustDecisionRef === undefined) throw new Error("ARTIFACT_OBJECT_METADATA_INVALID");
    reference(trustDecisionRef);
    const stagedKey = this.#key("staged", ownerScope, input.artifactRef, input.artifactVersionRef);
    const staged = await this.#head(stagedKey);
    if (staged !== null) {
      assertObject(staged, metadata.contentSha256, metadata.byteSize, metadata.mediaType);
    }
    const stagedCleanup: ArtifactReadyReceipt["stagedCleanup"] = staged === null
      ? Object.freeze({ state: "completed" as const })
      : Object.freeze({ state: "pending" as const, stagedObjectRef: objectRef(stagedKey) });
    return Object.freeze({ ownerScope, artifactRef: input.artifactRef,
      artifactVersionRef: input.artifactVersionRef, readyObjectRef: objectRef(key),
      contentSha256: metadata.contentSha256, byteSize: BigInt(metadata.byteSize),
      mediaType: metadata.mediaType, trustDecisionRef,
      stagedCleanup,
      state: "ready_private" as const });
  }

  async openReady(input: Parameters<ArtifactObjectStore["openReady"]>[0]) {
    if (input.signal.aborted) throw input.signal.reason ?? new DOMException("Aborted", "AbortError");
    const ownerScope = snapshotArtifactOwnerScope(input.ownerScope);
    reference(input.artifactRef);
    reference(input.artifactVersionRef);
    const key = this.#key("ready", ownerScope, input.artifactRef, input.artifactVersionRef);
    const head = await this.#head(key);
    if (head === null) throw new Error("ARTIFACT_VERSION_NOT_READY");
    const metadata = objectMetadata(head);
    const start = input.range?.start ?? 0;
    const endInclusive = input.range?.endInclusive ?? metadata.byteSize - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endInclusive) || start < 0 ||
        endInclusive < start || endInclusive >= metadata.byteSize) throw new Error("ARTIFACT_RANGE_UNSATISFIABLE");
    const expectedBytes = endInclusive - start + 1;
    const response = await this.dependencies.client.send(new GetObjectCommand({
      Bucket: this.dependencies.bucket,
      Key: key,
      IfMatch: head.eTag,
      ...(input.range === undefined ? {} : { Range: `bytes=${start}-${endInclusive}` }),
    }), { abortSignal: input.signal });
    if (response.Body === undefined || response.ContentLength !== expectedBytes ||
        response.ETag !== head.eTag || response.ContentType !== head.contentType) {
      throw new Error("ARTIFACT_OBJECT_RESPONSE_INVALID");
    }
    const responseMetadata = Object.freeze({ ...response.Metadata });
    if (responseMetadata["content-sha256"] !== metadata.contentSha256 ||
        responseMetadata["byte-size"] !== String(metadata.byteSize) ||
        responseMetadata["trust-decision-ref"] !== head.metadata["trust-decision-ref"]) {
      throw new Error("ARTIFACT_OBJECT_RESPONSE_INVALID");
    }
    return Object.freeze({
      body: boundedBody(response.Body, expectedBytes, input.signal,
        input.range === undefined ? metadata.contentSha256 : undefined),
      byteSize: metadata.byteSize,
      mediaType: metadata.mediaType,
    });
  }

  async cleanupStaged(input: Parameters<ArtifactObjectStore["cleanupStaged"]>[0], signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const ownerScope = snapshotArtifactOwnerScope(input.ownerScope);
    reference(input.artifactRef); reference(input.artifactVersionRef);
    const stagedKey = this.#key("staged", ownerScope, input.artifactRef, input.artifactVersionRef);
    if (input.stagedObjectRef !== objectRef(stagedKey)) {
      throw new Error("ARTIFACT_STAGED_CLEANUP_BINDING_MISMATCH");
    }
    try {
      await this.dependencies.client.send(new DeleteObjectCommand({
        Bucket: this.dependencies.bucket, Key: stagedKey,
      }), { abortSignal: signal });
    } catch (error) {
      if (await this.#head(stagedKey) !== null) throw error;
      return;
    }
    if (await this.#head(stagedKey) !== null) throw new Error("ARTIFACT_STAGED_CLEANUP_UNCONFIRMED");
  }

  async #cleanupStaged(stagedKey: string): Promise<ArtifactReadyReceipt["stagedCleanup"]> {
    try {
      await this.dependencies.client.send(new DeleteObjectCommand({
        Bucket: this.dependencies.bucket,
        Key: stagedKey,
      }));
      return Object.freeze({ state: "completed" as const });
    } catch {
      return Object.freeze({ state: "pending" as const, stagedObjectRef: objectRef(stagedKey) });
    }
  }

  async #head(key: string): Promise<Readonly<{
    contentLength: number;
    contentType: string;
    metadata: Readonly<Record<string, string | undefined>>;
    eTag: string;
  }> | null> {
    try {
      const value = await this.dependencies.client.send(new HeadObjectCommand({
        Bucket: this.dependencies.bucket,
        Key: key,
      }));
      if (!Number.isSafeInteger(value.ContentLength) || value.ContentLength === undefined ||
          value.ContentLength < 1 || value.ContentLength > MAXIMUM_ARTIFACT_BYTES ||
          typeof value.ContentType !== "string" || typeof value.ETag !== "string") {
        throw new Error("ARTIFACT_OBJECT_METADATA_INVALID");
      }
      return Object.freeze({ contentLength: value.ContentLength, contentType: value.ContentType,
        metadata: Object.freeze({ ...value.Metadata }), eTag: value.ETag });
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  #key(
    state: "staged" | "ready",
    scope: Parameters<typeof snapshotArtifactOwnerScope>[0],
    artifactRef: string,
    artifactVersionRef: string,
  ): string {
    const identity = createHash("sha256").update("kokoro.platform.artifact-object.v1\0")
      .update(frame(scope.siteRef)).update(frame(scope.subjectRef))
      .update(frame(scope.subjectGeneration.toString())).update(frame(scope.projectRef))
      .update(frame(artifactRef)).update(frame(artifactVersionRef)).digest("hex");
    return `${this.#prefix}/${state}/${identity.slice(0, 2)}/${identity}`;
  }
}

function stagedReceipt(
  ownerScope: ArtifactStagedReceipt["ownerScope"], artifactRef: string, artifactVersionRef: string,
  key: string, contentSha256: string, byteSize: number, mediaType: MediaType,
): ArtifactStagedReceipt {
  return Object.freeze({ ownerScope, artifactRef, artifactVersionRef, stagedObjectRef: objectRef(key),
    contentSha256, byteSize: BigInt(byteSize), mediaType, state: "staged" as const });
}

function readyReceipt(
  staged: ArtifactStagedReceipt, key: string, trustDecisionRef: string,
  stagedCleanup: ArtifactReadyReceipt["stagedCleanup"],
): ArtifactReadyReceipt {
  return Object.freeze({ ownerScope: staged.ownerScope, artifactRef: staged.artifactRef,
    artifactVersionRef: staged.artifactVersionRef, readyObjectRef: objectRef(key),
    contentSha256: staged.contentSha256, byteSize: staged.byteSize, mediaType: staged.mediaType,
    trustDecisionRef, stagedCleanup, state: "ready_private" as const });
}

function objectRef(key: string): string {
  return `artifact-object:sha256:${createHash("sha256").update(key).digest("hex")}`;
}

function assertObject(
  object: Readonly<{ contentLength: number; contentType: string;
    metadata: Readonly<Record<string, string | undefined>> }>,
  contentSha256: string,
  byteSize: number,
  mediaType: MediaType,
): void {
  if (object.contentLength !== byteSize || object.contentType !== mediaType ||
      object.metadata["content-sha256"] !== contentSha256 ||
      object.metadata["byte-size"] !== String(byteSize)) throw new Error("ARTIFACT_STAGE_CONFLICT");
}

function assertReadyObject(
  object: Readonly<{ contentLength: number; contentType: string;
    metadata: Readonly<Record<string, string | undefined>> }>,
  staged: ArtifactStagedReceipt,
  trustDecisionRef: string,
): void {
  assertObject(object, staged.contentSha256, Number(staged.byteSize), staged.mediaType);
  if (object.metadata["trust-decision-ref"] !== trustDecisionRef) {
    throw new Error("ARTIFACT_TRUST_BINDING_MISMATCH");
  }
}

function objectMetadata(object: Readonly<{ contentLength: number; contentType: string;
  metadata: Readonly<Record<string, string | undefined>> }>): Readonly<{
  contentSha256: string;
  byteSize: number;
  mediaType: MediaType;
}> {
  const contentSha256 = object.metadata["content-sha256"];
  const byteSize = Number(object.metadata["byte-size"]);
  if (typeof contentSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(contentSha256) ||
      byteSize !== object.contentLength || !mediaType(object.contentType)) {
    throw new Error("ARTIFACT_OBJECT_METADATA_INVALID");
  }
  return Object.freeze({ contentSha256, byteSize, mediaType: object.contentType });
}

async function* boundedBody(
  body: unknown,
  expectedBytes: number,
  signal: AbortSignal,
  expectedSha256?: string,
): AsyncGenerator<Uint8Array> {
  if (!asyncIterable(body)) throw new Error("ARTIFACT_OBJECT_BODY_INVALID");
  let received = 0;
  const digest = expectedSha256 === undefined ? undefined : createHash("sha256");
  for await (const raw of body) {
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    if (!(raw instanceof Uint8Array)) throw new Error("ARTIFACT_OBJECT_BODY_INVALID");
    received += raw.byteLength;
    if (received > expectedBytes) throw new Error("ARTIFACT_OBJECT_BODY_EXCEEDED");
    digest?.update(raw);
    yield new Uint8Array(raw);
  }
  if (received !== expectedBytes) throw new Error("ARTIFACT_OBJECT_BODY_TRUNCATED");
  if (digest !== undefined && digest.digest("hex") !== expectedSha256) {
    throw new Error("ARTIFACT_OBJECT_BODY_DIGEST_MISMATCH");
  }
}

async function collectBoundedBody(body: unknown, expectedBytes: number): Promise<Uint8Array> {
  if (!asyncIterable(body)) throw new Error("ARTIFACT_OBJECT_BODY_INVALID");
  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const raw of body) {
    if (!(raw instanceof Uint8Array)) throw new Error("ARTIFACT_OBJECT_BODY_INVALID");
    received += raw.byteLength;
    if (received > expectedBytes) throw new Error("ARTIFACT_OBJECT_BODY_EXCEEDED");
    chunks.push(new Uint8Array(raw));
  }
  if (received !== expectedBytes) throw new Error("ARTIFACT_OBJECT_BODY_TRUNCATED");
  const value = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return value;
}

function asyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

function mediaType(value: string): value is MediaType {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp";
}

function notFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as Readonly<{ name?: unknown; $metadata?: Readonly<{ httpStatusCode?: unknown }> }>;
  return value.name === "NotFound" || value.name === "NoSuchKey" || value.$metadata?.httpStatusCode === 404;
}

function preconditionFailed(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as Readonly<{ name?: unknown; $metadata?: Readonly<{ httpStatusCode?: unknown }> }>;
  return value.name === "PreconditionFailed" || value.$metadata?.httpStatusCode === 412;
}

function reference(value: string): void {
  if (value.length < 1 || value.length > 256 || value.trim() !== value) {
    throw new Error("ARTIFACT_REFERENCE_INVALID");
  }
}

function frame(value: string): Buffer {
  const bytes = Buffer.from(value);
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([length, bytes]);
}
