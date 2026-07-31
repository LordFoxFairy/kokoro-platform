import {
  parseArtifactByteRange,
  sameArtifactOwnerScope,
  snapshotArtifactOwnerScope,
  type ArtifactOwnerScope,
} from "../domain/artifact.js";
import type {
  ArtifactDeliveryAuditRepository,
  ArtifactDeliveryAuthorizationRepository,
  ArtifactDeliveryPurpose,
  ArtifactDeliveryWorkloadBinding,
  ArtifactDeliveryCapabilityCodecPort,
  ArtifactObjectStore,
} from "./contracts.js";

const MAXIMUM_DELIVERY_TTL_MS = 5 * 60 * 1_000;

export class ArtifactDeliveryService {
  readonly #repository: ArtifactDeliveryAuthorizationRepository;
  readonly #audit: ArtifactDeliveryAuditRepository;
  readonly #objectStore: ArtifactObjectStore;
  readonly #capabilities: ArtifactDeliveryCapabilityCodecPort;
  readonly #clock: () => Date;
  readonly #reference: (kind: "artifact-delivery-authorization" | "artifact-delivery-redemption") => string;

  constructor(input: Readonly<{
    repository: ArtifactDeliveryAuthorizationRepository;
    audit: ArtifactDeliveryAuditRepository;
    objectStore: ArtifactObjectStore;
    capabilities: ArtifactDeliveryCapabilityCodecPort;
    clock?: () => Date;
    reference: (kind: "artifact-delivery-authorization" | "artifact-delivery-redemption") => string;
  }>) {
    this.#repository = input.repository;
    this.#audit = input.audit;
    this.#objectStore = input.objectStore;
    this.#capabilities = input.capabilities;
    this.#clock = input.clock ?? (() => new Date());
    this.#reference = input.reference;
  }

  async issue(input: Readonly<{
    ownerScope: ArtifactOwnerScope;
    workload: ArtifactDeliveryWorkloadBinding;
    artifactRef: string;
    artifactVersionRef: string;
    purpose: ArtifactDeliveryPurpose;
    suggestedFileName?: string | undefined;
    audience: "site-bff.artifact-delivery";
    ttlMs: number;
  }>): Promise<Readonly<{
    authorizationRef: string;
    artifactRef: string;
    artifactVersionRef: string;
    purpose: ArtifactDeliveryPurpose;
    audience: "site-bff.artifact-delivery";
    deliveryCapability: string;
    issuedAt: string;
    expiresAt: string;
  }>> {
    const ownerScope = snapshotArtifactOwnerScope(input.ownerScope);
    const workload = snapshotWorkload(input.workload);
    if (ownerScope.siteRef !== workload.siteRef) throw new Error("ARTIFACT_DELIVERY_WORKLOAD_MISMATCH");
    reference(input.artifactRef);
    reference(input.artifactVersionRef);
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1 || input.ttlMs > MAXIMUM_DELIVERY_TTL_MS) {
      throw new Error("ARTIFACT_DELIVERY_TTL_INVALID");
    }
    if (await this.#objectStore.describeReady({ ownerScope, artifactRef: input.artifactRef,
      artifactVersionRef: input.artifactVersionRef }) === null) {
      throw new Error("ARTIFACT_VERSION_NOT_READY");
    }
    const issuedAtDate = this.#date();
    const issuedAt = issuedAtDate.toISOString();
    const expiresAt = new Date(issuedAtDate.getTime() + input.ttlMs).toISOString();
    const capability = this.#capabilities.issue();
    const authorizationRef = this.#reference("artifact-delivery-authorization");
    reference(authorizationRef);
    await this.#repository.create(Object.freeze({
      authorizationRef,
      capabilityDigest: capability.capabilityDigest,
      ownerScope,
      artifactRef: input.artifactRef,
      artifactVersionRef: input.artifactVersionRef,
      purpose: input.purpose,
      ...(input.suggestedFileName === undefined
        ? {} : { suggestedFileName: safeSuggestedFileName(input.suggestedFileName, input.purpose) }),
      audience: input.audience,
      workload,
      issuedAt,
      expiresAt,
      revocationEpoch: 1n,
    }));
    return Object.freeze({ authorizationRef, artifactRef: input.artifactRef,
      artifactVersionRef: input.artifactVersionRef, purpose: input.purpose, audience: input.audience,
      deliveryCapability: capability.deliveryCapability, issuedAt, expiresAt });
  }

  async redeemForWorkload(input: Readonly<{
    authorizationRef: string;
    deliveryCapability: string;
    workload: ArtifactDeliveryWorkloadBinding;
    audience: "site-bff.artifact-delivery";
    requestRef: string;
    rangeHeader?: string | undefined;
    signal: AbortSignal;
  }>): Promise<Readonly<{
    status: 200 | 206;
    headers: Readonly<{
      contentType: string;
      contentLength: string;
      acceptRanges: "bytes";
      contentDisposition: string;
      eTag: string;
      contentRange?: string | undefined;
    }>;
    body: AsyncIterable<Uint8Array>;
    redemptionRef: string;
  }>> {
    if (input.signal.aborted) throw input.signal.reason ?? new DOMException("Aborted", "AbortError");
    const capabilityDigest = this.#capabilities.verify(input.deliveryCapability);
    reference(input.authorizationRef);
    const authorization = await this.#repository.findByCapabilityDigest(capabilityDigest);
    if (authorization === null) throw new Error("ARTIFACT_DELIVERY_CAPABILITY_INVALID");
    if (authorization.authorizationRef !== input.authorizationRef) {
      throw new Error("ARTIFACT_DELIVERY_AUTHORIZATION_MISMATCH");
    }
    if (authorization.audience !== input.audience) throw new Error("ARTIFACT_DELIVERY_AUDIENCE_MISMATCH");
    const workload = snapshotWorkload(input.workload);
    if (!sameWorkload(authorization.workload, workload)) {
      throw new Error("ARTIFACT_DELIVERY_WORKLOAD_MISMATCH");
    }
    reference(input.requestRef);
    if (authorization.revokedAt !== undefined) throw new Error("ARTIFACT_DELIVERY_REVOKED");
    if (Date.parse(authorization.expiresAt) <= this.#date().getTime()) {
      throw new Error("ARTIFACT_DELIVERY_EXPIRED");
    }
    const ready = await this.#objectStore.describeReady({ ownerScope: authorization.ownerScope,
      artifactRef: authorization.artifactRef, artifactVersionRef: authorization.artifactVersionRef });
    if (ready === null) throw new Error("ARTIFACT_VERSION_NOT_READY");
    const byteSize = safeNumber(ready.byteSize);
    const redemptionRef = this.#reference("artifact-delivery-redemption");
    reference(redemptionRef);
    await this.#audit.begin(Object.freeze({
      redemptionRef,
      authorizationRef: authorization.authorizationRef,
      requestRef: input.requestRef,
      workload,
      ...(input.rangeHeader === undefined ? {} : { rangeHeader: input.rangeHeader }),
      attemptedAt: this.#date().toISOString(),
      state: "pending" as const,
    }));
    let range;
    try {
      range = parseArtifactByteRange(input.rangeHeader, byteSize);
    } catch (error) {
      await this.#audit.fail({ redemptionRef, failedAt: this.#date().toISOString(),
        failureCode: "range_rejected" });
      if (error instanceof Error && RANGE_ERROR_CODES.includes(error.message as RangeErrorCode)) {
        throw new ArtifactDeliveryRangeError(error.message as RangeErrorCode, ready.byteSize);
      }
      throw error;
    }
    let opened;
    try {
      opened = await this.#objectStore.openReady({ ownerScope: authorization.ownerScope,
        artifactRef: authorization.artifactRef, artifactVersionRef: authorization.artifactVersionRef,
        ...(range === undefined ? {} : { range }), signal: input.signal });
    } catch (error) {
      await this.#audit.fail({ redemptionRef, failedAt: this.#date().toISOString(),
        failureCode: input.signal.aborted ? "client_aborted" : "storage_failed" });
      throw error;
    }
    if (opened.byteSize !== byteSize || opened.mediaType !== ready.mediaType) {
      await this.#audit.fail({ redemptionRef, failedAt: this.#date().toISOString(),
        failureCode: "storage_failed" });
      throw new Error("ARTIFACT_OBJECT_RESPONSE_INVALID");
    }
    const contentLength = range === undefined ? opened.byteSize : range.endInclusive - range.start + 1;
    return Object.freeze({
      status: range === undefined ? 200 as const : 206 as const,
      headers: Object.freeze({
        contentType: opened.mediaType,
        contentLength: contentLength.toString(),
        acceptRanges: "bytes" as const,
        contentDisposition: contentDisposition(
          authorization.purpose,
          opened.mediaType,
          authorization.suggestedFileName,
        ),
        eTag: `"${ready.contentSha256}"`,
        ...(range === undefined ? {} : {
          contentRange: `bytes ${range.start}-${range.endInclusive}/${byteSize}`,
        }),
      }),
      body: auditedBody(opened.body, BigInt(contentLength), input.signal, redemptionRef,
        this.#audit, () => this.#date()),
      redemptionRef,
    });
  }

  async revoke(input: Readonly<{
    authorizationRef: string;
    ownerScope: ArtifactOwnerScope;
  }>): Promise<Readonly<{ state: "revoked" | "already_revoked" | "expired"; revokedAt: string }>> {
    reference(input.authorizationRef);
    const current = await this.#repository.findByReference(input.authorizationRef);
    if (current === null) throw new Error("ARTIFACT_DELIVERY_AUTHORIZATION_NOT_FOUND");
    if (!sameArtifactOwnerScope(current.ownerScope, snapshotArtifactOwnerScope(input.ownerScope))) {
      throw new Error("ARTIFACT_DELIVERY_SCOPE_MISMATCH");
    }
    const now = this.#date().toISOString();
    if (current.revokedAt !== undefined) return Object.freeze({ state: "already_revoked", revokedAt: current.revokedAt });
    if (Date.parse(current.expiresAt) <= Date.parse(now)) return Object.freeze({ state: "expired", revokedAt: now });
    const revoked = await this.#repository.revoke({ authorizationRef: current.authorizationRef,
      revokedAt: now, expectedRevocationEpoch: current.revocationEpoch });
    if (revoked === null) throw new Error("ARTIFACT_DELIVERY_REVOCATION_CONFLICT");
    return Object.freeze({ state: "revoked", revokedAt: now });
  }

  #date(): Date {
    const value = this.#clock();
    if (!Number.isFinite(value.getTime())) throw new Error("ARTIFACT_DELIVERY_CLOCK_INVALID");
    return value;
  }
}

const RANGE_ERROR_CODES = Object.freeze([
  "ARTIFACT_RANGE_MULTIPLE_UNSUPPORTED",
  "ARTIFACT_RANGE_INVALID",
  "ARTIFACT_RANGE_UNSATISFIABLE",
  "ARTIFACT_RANGE_TOO_LARGE",
] as const);
type RangeErrorCode = (typeof RANGE_ERROR_CODES)[number];

export class ArtifactDeliveryRangeError extends Error {
  constructor(readonly code: RangeErrorCode, readonly totalBytes: bigint) {
    super(code);
    this.name = "ArtifactDeliveryRangeError";
  }
}

async function* auditedBody(
  body: AsyncIterable<Uint8Array>,
  expectedBytes: bigint,
  signal: AbortSignal,
  redemptionRef: string,
  audit: ArtifactDeliveryAuditRepository,
  clock: () => Date,
): AsyncGenerator<Uint8Array> {
  let emitted = 0n;
  let terminal = false;
  try {
    for await (const chunk of body) {
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      if (!(chunk instanceof Uint8Array) || chunk.byteLength < 1) {
        throw new Error("ARTIFACT_DELIVERY_BODY_INVALID");
      }
      emitted += BigInt(chunk.byteLength);
      if (emitted > expectedBytes) throw new Error("ARTIFACT_DELIVERY_BODY_OVERRUN");
      yield chunk;
    }
    if (emitted !== expectedBytes) throw new Error("ARTIFACT_DELIVERY_BODY_TRUNCATED");
    await audit.completeStream({ redemptionRef, streamCompletedAt: clock().toISOString(), bytesEmitted: emitted });
    terminal = true;
  } catch (error) {
    await audit.fail({ redemptionRef, failedAt: clock().toISOString(),
      failureCode: signal.aborted ? "client_aborted" : "storage_failed" });
    terminal = true;
    throw error;
  } finally {
    if (!terminal) {
      await audit.fail({ redemptionRef, failedAt: clock().toISOString(), failureCode: "client_aborted" });
    }
  }
}

function snapshotWorkload(input: ArtifactDeliveryWorkloadBinding): ArtifactDeliveryWorkloadBinding {
  for (const value of [input.siteRef, input.siteReleaseRef, input.workloadIdentityRef]) reference(value);
  for (const epoch of [input.workloadBindingEpoch, input.siteSecurityEpoch]) {
    if (typeof epoch !== "bigint" || epoch < 1n || epoch > 9_223_372_036_854_775_807n) {
      throw new Error("ARTIFACT_DELIVERY_WORKLOAD_INVALID");
    }
  }
  return Object.freeze({ ...input });
}

function sameWorkload(left: ArtifactDeliveryWorkloadBinding, right: ArtifactDeliveryWorkloadBinding): boolean {
  return left.siteRef === right.siteRef && left.siteReleaseRef === right.siteReleaseRef &&
    left.workloadIdentityRef === right.workloadIdentityRef &&
    left.workloadBindingEpoch === right.workloadBindingEpoch &&
    left.siteSecurityEpoch === right.siteSecurityEpoch;
}

function contentDisposition(
  purpose: ArtifactDeliveryPurpose,
  mediaType: string,
  suggestedFileName?: string,
): string {
  const extension = mediaType === "image/jpeg" ? "jpg" : mediaType === "image/webp" ? "webp" : "png";
  const name = purpose === "download" && suggestedFileName !== undefined
    ? suggestedFileName : `artifact.${extension}`;
  const fallback = [...name].map((character) =>
    /^[A-Za-z0-9 ._()-]$/u.test(character) ? character : "_").join("");
  const quoted = fallback.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const encoded = encodeURIComponent(name).replace(/[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  const extended = /^[\x20-\x7e]+$/u.test(name) ? "" : `; filename*=UTF-8''${encoded}`;
  return `${purpose === "preview" ? "inline" : "attachment"}; filename="${quoted}"${extended}`;
}

function safeSuggestedFileName(value: string, purpose: ArtifactDeliveryPurpose): string {
  if (purpose !== "download" || value.length < 1 || value.length > 255 ||
      value.includes("/") || value.includes("\\") || hasControlCharacter(value)) {
    throw new Error("ARTIFACT_DELIVERY_FILENAME_INVALID");
  }
  return value.normalize("NFC");
}

function reference(value: string): void {
  if (value.length < 1 || value.length > 256 || value.trim() !== value || hasControlCharacter(value)) {
    throw new Error("ARTIFACT_REFERENCE_INVALID");
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function safeNumber(value: bigint): number {
  if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("ARTIFACT_SIZE_INVALID");
  return Number(value);
}
