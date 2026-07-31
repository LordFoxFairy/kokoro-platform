import { createHash } from "node:crypto";
import type {
  ArtifactDeliveryAuthorizationRepository,
  ArtifactObjectStore,
  StoredArtifactDeliveryAuthorization,
} from "../../application/contracts.js";
import type {
  ArtifactReadyReceipt,
  ArtifactStagedReceipt,
} from "../../domain/artifact.js";
import { sameArtifactOwnerScope, snapshotArtifactOwnerScope } from "../../domain/artifact.js";

type StoredObject = Readonly<{
  bytes: Uint8Array;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  receipt: ArtifactStagedReceipt | ArtifactReadyReceipt;
}>;

/** Deterministic in-process adapter for tests/local development. Production composition must reject it. */
export class InMemoryArtifactObjectStore implements ArtifactObjectStore {
  readonly developmentOnly = true as const;
  readonly #staged = new Map<string, StoredObject>();
  readonly #ready = new Map<string, StoredObject>();

  async stage(input: Parameters<ArtifactObjectStore["stage"]>[0]): Promise<ArtifactStagedReceipt> {
    const ownerScope = snapshotArtifactOwnerScope(input.ownerScope);
    reference(input.artifactRef);
    reference(input.artifactVersionRef);
    if (input.bytes.byteLength < 1 || input.bytes.byteLength > 32 * 1024 * 1024) {
      throw new Error("ARTIFACT_STAGE_SIZE_INVALID");
    }
    const bytes = new Uint8Array(input.bytes);
    const contentSha256 = createHash("sha256").update(bytes).digest("hex");
    const prior = this.#staged.get(input.artifactVersionRef) ?? this.#ready.get(input.artifactVersionRef);
    if (prior !== undefined) {
      if (prior.receipt.contentSha256 !== contentSha256) throw new Error("ARTIFACT_STAGE_CONFLICT");
      if (prior.receipt.state === "staged") return prior.receipt;
      throw new Error("ARTIFACT_ALREADY_PROMOTED");
    }
    const receipt: ArtifactStagedReceipt = Object.freeze({
      ownerScope,
      artifactRef: input.artifactRef,
      artifactVersionRef: input.artifactVersionRef,
      stagedObjectRef: `staged:sha256:${contentSha256}`,
      contentSha256,
      byteSize: BigInt(bytes.byteLength),
      mediaType: input.mediaType,
      state: "staged",
    });
    this.#staged.set(input.artifactVersionRef, Object.freeze({ bytes, mediaType: input.mediaType, receipt }));
    return receipt;
  }

  async promote(input: Parameters<ArtifactObjectStore["promote"]>[0]): Promise<ArtifactReadyReceipt> {
    const staged = this.#staged.get(input.stagedReceipt.artifactVersionRef);
    if (staged === undefined || staged.receipt.state !== "staged" ||
        staged.receipt.artifactRef !== input.stagedReceipt.artifactRef ||
        !sameArtifactOwnerScope(staged.receipt.ownerScope, input.stagedReceipt.ownerScope) ||
        staged.receipt.stagedObjectRef !== input.stagedReceipt.stagedObjectRef ||
        staged.receipt.contentSha256 !== input.stagedReceipt.contentSha256 ||
        input.trustDecision.contentSha256 !== staged.receipt.contentSha256) {
      throw new Error("ARTIFACT_TRUST_BINDING_MISMATCH");
    }
    if (input.trustDecision.kind !== "allow") throw new Error("ARTIFACT_OUTPUT_RESTRICTED");
    const ready: ArtifactReadyReceipt = Object.freeze({
      ownerScope: staged.receipt.ownerScope,
      artifactRef: staged.receipt.artifactRef,
      artifactVersionRef: input.stagedReceipt.artifactVersionRef,
      readyObjectRef: `ready:sha256:${staged.receipt.contentSha256}`,
      contentSha256: staged.receipt.contentSha256,
      byteSize: staged.receipt.byteSize,
      mediaType: staged.receipt.mediaType,
      trustDecisionRef: input.trustDecision.decisionRef,
      stagedCleanup: Object.freeze({ state: "completed" as const }),
      state: "ready_private",
    });
    this.#ready.set(ready.artifactVersionRef, Object.freeze({ ...staged, receipt: ready }));
    this.#staged.delete(ready.artifactVersionRef);
    return ready;
  }

  async describeReady(input: Parameters<ArtifactObjectStore["describeReady"]>[0]):
  Promise<ArtifactReadyReceipt | null> {
    const stored = this.#ready.get(input.artifactVersionRef);
    return stored?.receipt.state === "ready_private" &&
      stored.receipt.artifactRef === input.artifactRef &&
      sameArtifactOwnerScope(stored.receipt.ownerScope, input.ownerScope) ? stored.receipt : null;
  }

  async openReady(input: Parameters<ArtifactObjectStore["openReady"]>[0]) {
    const stored = this.#ready.get(input.artifactVersionRef);
    if (stored === undefined || stored.receipt.state !== "ready_private" ||
        stored.receipt.artifactRef !== input.artifactRef ||
        !sameArtifactOwnerScope(stored.receipt.ownerScope, input.ownerScope)) {
      throw new Error("ARTIFACT_VERSION_NOT_READY");
    }
    const start = input.range?.start ?? 0;
    const endExclusive = (input.range?.endInclusive ?? stored.bytes.byteLength - 1) + 1;
    const bytes = stored.bytes.slice(start, endExclusive);
    return Object.freeze({
      byteSize: stored.bytes.byteLength,
      mediaType: stored.mediaType,
      body: streamOnce(bytes, input.signal),
    });
  }
}

/** Deterministic in-process adapter for tests/local development. Production composition must reject it. */
export class InMemoryArtifactDeliveryAuthorizationRepository
implements ArtifactDeliveryAuthorizationRepository {
  readonly developmentOnly = true as const;
  readonly #byDigest = new Map<string, StoredArtifactDeliveryAuthorization>();
  readonly #digestByRef = new Map<string, string>();

  async create(record: StoredArtifactDeliveryAuthorization): Promise<void> {
    if (this.#byDigest.has(record.capabilityDigest) || this.#digestByRef.has(record.authorizationRef)) {
      throw new Error("ARTIFACT_DELIVERY_AUTHORIZATION_CONFLICT");
    }
    this.#byDigest.set(record.capabilityDigest, record);
    this.#digestByRef.set(record.authorizationRef, record.capabilityDigest);
  }

  async findByCapabilityDigest(capabilityDigest: string): Promise<StoredArtifactDeliveryAuthorization | null> {
    return this.#byDigest.get(capabilityDigest) ?? null;
  }

  async findByReference(authorizationRef: string): Promise<StoredArtifactDeliveryAuthorization | null> {
    const digest = this.#digestByRef.get(authorizationRef);
    return digest === undefined ? null : this.#byDigest.get(digest) ?? null;
  }

  async revoke(input: Parameters<ArtifactDeliveryAuthorizationRepository["revoke"]>[0]) {
    const current = await this.findByReference(input.authorizationRef);
    if (current === null || current.revocationEpoch !== input.expectedRevocationEpoch ||
        current.revokedAt !== undefined) return null;
    const changed = Object.freeze({ ...current, revokedAt: input.revokedAt,
      revocationEpoch: current.revocationEpoch + 1n });
    this.#byDigest.set(current.capabilityDigest, changed);
    return changed;
  }
}

async function* streamOnce(bytes: Uint8Array, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  yield new Uint8Array(bytes);
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function reference(value: string): void {
  if (value.length < 1 || value.length > 256 || value.trim() !== value) throw new Error("ARTIFACT_REFERENCE_INVALID");
}
