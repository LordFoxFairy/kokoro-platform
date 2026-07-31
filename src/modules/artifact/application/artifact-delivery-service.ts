import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  parseArtifactByteRange,
  sameArtifactOwnerScope,
  snapshotArtifactOwnerScope,
  type ArtifactOwnerScope,
} from "../domain/artifact.js";
import type {
  ArtifactDeliveryAuthorizationRepository,
  ArtifactDeliveryPurpose,
  ArtifactObjectStore,
} from "./contracts.js";

const MAXIMUM_DELIVERY_TTL_MS = 5 * 60 * 1_000;
const TOKEN_PATTERN = /^artdel_v1\.([A-Za-z0-9_-]{43})\.([0-9a-f]{64})$/u;

export class ArtifactDeliveryService {
  readonly #repository: ArtifactDeliveryAuthorizationRepository;
  readonly #objectStore: ArtifactObjectStore;
  readonly #capabilityKey: Buffer;
  readonly #clock: () => Date;
  readonly #reference: (kind: "artifact-delivery-authorization") => string;

  constructor(input: Readonly<{
    repository: ArtifactDeliveryAuthorizationRepository;
    objectStore: ArtifactObjectStore;
    capabilityKey: Uint8Array;
    clock?: () => Date;
    reference: (kind: "artifact-delivery-authorization") => string;
  }>) {
    if (input.capabilityKey.byteLength !== 32) throw new Error("ARTIFACT_DELIVERY_KEY_INVALID");
    this.#repository = input.repository;
    this.#objectStore = input.objectStore;
    this.#capabilityKey = Buffer.from(input.capabilityKey);
    this.#clock = input.clock ?? (() => new Date());
    this.#reference = input.reference;
  }

  async issue(input: Readonly<{
    ownerScope: ArtifactOwnerScope;
    artifactRef: string;
    artifactVersionRef: string;
    purpose: ArtifactDeliveryPurpose;
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
    reference(input.artifactRef);
    reference(input.artifactVersionRef);
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1 || input.ttlMs > MAXIMUM_DELIVERY_TTL_MS) {
      throw new Error("ARTIFACT_DELIVERY_TTL_INVALID");
    }
    if (await this.#objectStore.describeReady(input.artifactVersionRef) === null) {
      throw new Error("ARTIFACT_VERSION_NOT_READY");
    }
    const issuedAtDate = this.#date();
    const issuedAt = issuedAtDate.toISOString();
    const expiresAt = new Date(issuedAtDate.getTime() + input.ttlMs).toISOString();
    const token = randomBytes(32).toString("base64url");
    const capabilityDigest = this.#sign(token);
    const authorizationRef = this.#reference("artifact-delivery-authorization");
    reference(authorizationRef);
    await this.#repository.create(Object.freeze({
      authorizationRef,
      capabilityDigest,
      ownerScope,
      artifactRef: input.artifactRef,
      artifactVersionRef: input.artifactVersionRef,
      purpose: input.purpose,
      audience: input.audience,
      issuedAt,
      expiresAt,
      revocationEpoch: 1n,
    }));
    return Object.freeze({ authorizationRef, artifactRef: input.artifactRef,
      artifactVersionRef: input.artifactVersionRef, purpose: input.purpose, audience: input.audience,
      deliveryCapability: `artdel_v1.${token}.${capabilityDigest}`, issuedAt, expiresAt });
  }

  async redeem(input: Readonly<{
    deliveryCapability: string;
    ownerScope: ArtifactOwnerScope;
    audience: "site-bff.artifact-delivery";
    rangeHeader?: string | undefined;
    signal: AbortSignal;
  }>): Promise<Readonly<{
    status: 200 | 206;
    headers: Readonly<{
      contentType: string;
      contentLength: string;
      acceptRanges: "bytes";
      contentRange?: string | undefined;
    }>;
    body: AsyncIterable<Uint8Array>;
  }>> {
    if (input.signal.aborted) throw input.signal.reason ?? new DOMException("Aborted", "AbortError");
    const match = TOKEN_PATTERN.exec(input.deliveryCapability);
    if (match === null) throw new Error("ARTIFACT_DELIVERY_CAPABILITY_INVALID");
    const token = match[1]!;
    const suppliedDigest = Buffer.from(match[2]!, "hex");
    const expectedDigest = Buffer.from(this.#sign(token), "hex");
    if (!timingSafeEqual(suppliedDigest, expectedDigest)) throw new Error("ARTIFACT_DELIVERY_CAPABILITY_INVALID");
    const authorization = await this.#repository.findByCapabilityDigest(match[2]!);
    if (authorization === null) throw new Error("ARTIFACT_DELIVERY_CAPABILITY_INVALID");
    if (authorization.audience !== input.audience) throw new Error("ARTIFACT_DELIVERY_AUDIENCE_MISMATCH");
    if (!sameArtifactOwnerScope(authorization.ownerScope, snapshotArtifactOwnerScope(input.ownerScope))) {
      throw new Error("ARTIFACT_DELIVERY_SCOPE_MISMATCH");
    }
    if (authorization.revokedAt !== undefined) throw new Error("ARTIFACT_DELIVERY_REVOKED");
    if (Date.parse(authorization.expiresAt) <= this.#date().getTime()) {
      throw new Error("ARTIFACT_DELIVERY_EXPIRED");
    }
    const ready = await this.#objectStore.describeReady(authorization.artifactVersionRef);
    if (ready === null) throw new Error("ARTIFACT_VERSION_NOT_READY");
    const byteSize = safeNumber(ready.byteSize);
    const range = parseArtifactByteRange(input.rangeHeader, byteSize);
    const opened = await this.#objectStore.openReady({ artifactVersionRef: authorization.artifactVersionRef,
      ...(range === undefined ? {} : { range }), signal: input.signal });
    const contentLength = range === undefined ? opened.byteSize : range.endInclusive - range.start + 1;
    return Object.freeze({
      status: range === undefined ? 200 as const : 206 as const,
      headers: Object.freeze({
        contentType: opened.mediaType,
        contentLength: contentLength.toString(),
        acceptRanges: "bytes" as const,
        ...(range === undefined ? {} : {
          contentRange: `bytes ${range.start}-${range.endInclusive}/${byteSize}`,
        }),
      }),
      body: opened.body,
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

  #sign(token: string): string {
    return createHmac("sha256", this.#capabilityKey)
      .update("kokoro.platform.artifact-delivery.v1\0")
      .update(token)
      .digest("hex");
  }

  #date(): Date {
    const value = this.#clock();
    if (!Number.isFinite(value.getTime())) throw new Error("ARTIFACT_DELIVERY_CLOCK_INVALID");
    return value;
  }
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
