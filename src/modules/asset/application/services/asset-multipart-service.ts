import type { Readable } from "node:stream";
import { digestAssetCommand } from "../asset-digest.js";
import type {
  AssetMultipartRepositoryPort,
  AssetMultipartStorePort,
  AssetMultipartUnitOfWorkPort,
  AuthorizedAssetMultipartSnapshot,
  StoredAssetMultipartPart,
} from "../contracts/asset-multipart-ports.js";
import type { AssetUploadCapabilityClaims } from "../contracts/asset-upload-ports.js";

export class AssetMultipartService {
  constructor(private readonly dependencies: Readonly<{
    unitOfWork: AssetMultipartUnitOfWorkPort;
    repository: AssetMultipartRepositoryPort;
    store: AssetMultipartStorePort;
    clock?: () => Date;
    reference?: () => string;
  }>) {}

  async initiate(input: Readonly<{
    claims: AssetUploadCapabilityClaims;
    clientUploadId: string;
    idempotencyKey: string;
  }>): Promise<AuthorizedAssetMultipartSnapshot> {
    identifier(input.clientUploadId, "UPLOAD_NOT_ACCEPTED");
    idempotency(input.idempotencyKey);
    const requestDigest = digestAssetCommand({
      operation: "initiateAssetMultipartUpload",
      sessionRef: input.claims.sessionRef,
      capabilityEpoch: input.claims.capabilityEpoch,
      clientUploadId: input.clientUploadId,
      protocolRevision: "s3-multipart-v1",
    });
    const now = this.now();
    let snapshot = await this.dependencies.unitOfWork.execute(
      input.claims,
      "asset.multipart.initiate",
      (transaction) => this.dependencies.repository.claimInitiation(transaction, {
        claims: input.claims,
        uploadRef: this.reference(),
        clientUploadId: input.clientUploadId,
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        receiptRef: this.reference(),
        now,
      }),
    );
    const upload = requiredUpload(snapshot);
    if (upload.initiationRequestDigest !== requestDigest ||
        upload.initiationIdempotencyKey !== input.idempotencyKey) {
      throw new Error("UPLOAD_STATE_CONFLICT");
    }
    if (upload.providerUploadId !== null && upload.state !== "initiating" &&
        !(upload.state === "outcome_unknown" && upload.outcomeOperation === "initiate")) {
      return snapshot;
    }
    try {
      const recovered = await this.dependencies.store.recoverInitiation(route(input.claims));
      const providerUploadId = recovered ?? await this.dependencies.store.initiate({
        ...route(input.claims),
        uploadRef: upload.uploadRef,
      });
      snapshot = await this.dependencies.unitOfWork.execute(
        input.claims,
        "asset.multipart.initiate",
        (transaction) => this.dependencies.repository.recordInitiated(transaction, {
          claims: input.claims,
          uploadRef: upload.uploadRef,
          expectedVersion: upload.expectedVersion,
          providerUploadId,
          now: this.now(),
        }),
      );
    } catch {
      snapshot = await this.dependencies.unitOfWork.execute(
        input.claims,
        "asset.multipart.initiate",
        (transaction) => this.dependencies.repository.recordInitiationUnknown(transaction, {
          claims: input.claims,
          uploadRef: upload.uploadRef,
          expectedVersion: upload.expectedVersion,
          now: this.now(),
        }),
      );
    }
    return snapshot;
  }

  async putPart(input: Readonly<{
    claims: AssetUploadCapabilityClaims;
    uploadRef: string;
    partNumber: number;
    declaredSize: bigint;
    checksumSha256: string;
    idempotencyKey: string;
    body: Readable;
  }>): Promise<AuthorizedAssetMultipartSnapshot> {
    uploadReference(input.uploadRef);
    partNumber(input.partNumber);
    checksum(input.checksumSha256);
    idempotency(input.idempotencyKey);
    const maximum = BigInt(input.claims.maximumPartBytes);
    if (input.declaredSize < 1n || input.declaredSize > maximum) {
      throw new Error("UPLOAD_PART_INVALID");
    }
    const requestDigest = digestAssetCommand({
      operation: "putAssetMultipartPart",
      uploadRef: input.uploadRef,
      partNumber: input.partNumber,
      declaredSize: input.declaredSize,
      checksumSha256: input.checksumSha256,
      capabilityEpoch: input.claims.capabilityEpoch,
    });
    const effectToken = this.reference();
    const claimedAt = this.now();
    let snapshot = await this.dependencies.unitOfWork.execute(
      input.claims,
      "asset.multipart.put-part",
      (transaction) => this.dependencies.repository.claimPart(transaction, {
        claims: input.claims,
        uploadRef: input.uploadRef,
        partNumber: input.partNumber,
        partReceipt: this.reference(),
        size: input.declaredSize,
        checksumSha256: input.checksumSha256,
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        effectToken,
        effectLeaseExpiresAt: leaseExpiry(claimedAt),
        now: claimedAt,
      }),
    );
    const upload = requiredUpload(snapshot);
    if (upload.state !== "uploading" || upload.providerUploadId === null) {
      input.body.destroy();
      throw new Error("UPLOAD_STATE_CONFLICT");
    }
    const part = requiredPart(snapshot, input.partNumber);
    if (part.state === "committed") {
      input.body.destroy();
      return snapshot;
    }
    if (part.effectToken !== effectToken) {
      input.body.destroy();
      return snapshot;
    }
    try {
      const providerEtag = await this.dependencies.store.putPart({
        ...route(input.claims),
        providerUploadId: upload.providerUploadId,
        partNumber: input.partNumber,
        declaredSize: input.declaredSize,
        checksumSha256: input.checksumSha256,
        body: input.body,
      });
      snapshot = await this.finishPart(input.claims, input.uploadRef, part, effectToken,
        "committed", providerEtag);
      return snapshot;
    } catch (error) {
      await this.finishPart(input.claims, input.uploadRef, part, effectToken,
        "outcome_unknown", null)
        .catch(() => undefined);
      throw error;
    }
  }

  async complete(input: Readonly<{
    claims: AssetUploadCapabilityClaims;
    uploadRef: string;
    expectedVersion: bigint;
    expectedSize: bigint;
    expectedChecksumSha256: string;
    parts: readonly Readonly<{ partNumber: number; partReceipt: string }>[];
    idempotencyKey: string;
  }>): Promise<AuthorizedAssetMultipartSnapshot> {
    uploadReference(input.uploadRef);
    checksum(input.expectedChecksumSha256);
    idempotency(input.idempotencyKey);
    if (input.expectedSize !== BigInt(input.claims.expectedSize) ||
        input.expectedChecksumSha256 !== input.claims.expectedChecksumSha256) {
      throw new Error("UPLOAD_PART_INVALID");
    }
    const requestDigest = digestAssetCommand({
      operation: "completeAssetMultipartUpload",
      uploadRef: input.uploadRef,
      expectedVersion: input.expectedVersion,
      expectedSize: input.expectedSize,
      expectedChecksumSha256: input.expectedChecksumSha256,
      parts: input.parts,
      capabilityEpoch: input.claims.capabilityEpoch,
    });
    const before = await this.read(input.claims, input.uploadRef, "asset.multipart.complete");
    const current = requiredUpload(before);
    if (current.state === "uploaded" || current.state === "integrity_rejected") return before;
    if (["aborting", "aborted"].includes(current.state)) throw new Error("UPLOAD_STATE_CONFLICT");
    const ordered = resolveParts(before.parts, input.parts, input.claims, input.expectedSize);
    const snapshot = await this.dependencies.unitOfWork.execute(
      input.claims,
      "asset.multipart.complete",
      (transaction) => this.dependencies.repository.beginCompletion(transaction, {
        claims: input.claims,
        uploadRef: input.uploadRef,
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        receiptRef: this.reference(),
        now: this.now(),
      }),
    );
    const upload = requiredUpload(snapshot);
    if (upload.state === "uploaded" || upload.state === "integrity_rejected") return snapshot;
    if (upload.providerUploadId === null) throw new Error("UPLOAD_STATE_CONFLICT");
    try {
      await this.dependencies.store.complete({
        ...route(input.claims),
        providerUploadId: upload.providerUploadId,
        parts: ordered.map((part) => ({
          partNumber: part.partNumber,
          providerEtag: requiredProviderEtag(part),
          checksumSha256: part.checksumSha256,
        })),
      });
    } catch {
      // CompleteMultipartUpload may have committed even when its response was lost. Observation,
      // never the transport exception, decides whether the object is terminal.
    }
    return this.reconcileCompletion(input.claims, upload, ordered);
  }

  async abort(input: Readonly<{
    claims: AssetUploadCapabilityClaims;
    uploadRef: string;
    expectedVersion: bigint;
    idempotencyKey: string;
  }>): Promise<AuthorizedAssetMultipartSnapshot> {
    uploadReference(input.uploadRef);
    idempotency(input.idempotencyKey);
    const requestDigest = digestAssetCommand({
      operation: "abortAssetMultipartUpload",
      uploadRef: input.uploadRef,
      expectedVersion: input.expectedVersion,
      capabilityEpoch: input.claims.capabilityEpoch,
    });
    let current = await this.status(input.claims, input.uploadRef);
    const currentUpload = requiredUpload(current);
    if (currentUpload.state === "aborted") return current;
    if (currentUpload.state === "uploaded" || currentUpload.state === "integrity_rejected") {
      throw new Error("UPLOAD_STATE_CONFLICT");
    }
    if (currentUpload.state === "completing") {
      current = await this.reconcileCompletion(input.claims, currentUpload, committedParts(current.parts));
      const reconciled = requiredUpload(current);
      if (reconciled.state !== "outcome_unknown") throw new Error("UPLOAD_STATE_CONFLICT");
    }
    const snapshot = await this.dependencies.unitOfWork.execute(
      input.claims,
      "asset.multipart.abort",
      (transaction) => this.dependencies.repository.beginAbort(transaction, {
        claims: input.claims,
        uploadRef: input.uploadRef,
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        receiptRef: this.reference(),
        now: this.now(),
      }),
    );
    const upload = requiredUpload(snapshot);
    if (upload.state === "aborted") return snapshot;
    if (upload.state === "uploaded" || upload.state === "integrity_rejected") {
      throw new Error("UPLOAD_STATE_CONFLICT");
    }
    if (upload.providerUploadId === null) throw new Error("UPLOAD_STATE_CONFLICT");
    let providerDisposition: "aborted" | "already_absent" | null = null;
    try {
      providerDisposition = await this.dependencies.store.abort({
        ...route(input.claims),
        providerUploadId: upload.providerUploadId,
      });
    } catch {
      // Abort may have committed even when the response was lost. A missing multipart upload is
      // not proof that a completed object is absent, so reconciliation always observes the key.
    }
    const reconciled = await this.reconcileAbort(input.claims, upload, providerDisposition);
    if (requiredUpload(reconciled).state === "uploaded") {
      throw new Error("UPLOAD_STATE_CONFLICT");
    }
    return reconciled;
  }

  async status(
    claims: AssetUploadCapabilityClaims,
    uploadRef: string,
  ): Promise<AuthorizedAssetMultipartSnapshot> {
    uploadReference(uploadRef);
    const snapshot = await this.read(claims, uploadRef, "asset.multipart.status");
    const upload = requiredUpload(snapshot);
    if (upload.state !== "outcome_unknown") return snapshot;
    if (upload.outcomeOperation === "initiate") return this.initiate({
      claims,
      clientUploadId: upload.clientUploadId,
      idempotencyKey: upload.initiationIdempotencyKey,
    });
    return upload.outcomeOperation === "abort"
      ? this.retryAbort(claims, upload, snapshot)
      : this.retryCompletion(claims, upload, snapshot);
  }

  private read(
    claims: AssetUploadCapabilityClaims,
    uploadRef: string,
    operation: string,
  ): Promise<AuthorizedAssetMultipartSnapshot> {
    return this.dependencies.unitOfWork.execute(claims, operation, async (transaction) => {
      const snapshot = await this.dependencies.repository.readAuthorized(transaction, claims, uploadRef);
      if (snapshot === null) throw new Error("UPLOAD_NOT_ACCEPTED");
      return snapshot;
    });
  }

  private finishPart(
    claims: AssetUploadCapabilityClaims,
    uploadRef: string,
    part: StoredAssetMultipartPart,
    effectToken: string,
    state: "committed" | "outcome_unknown",
    providerEtag: string | null,
  ) {
    return this.dependencies.unitOfWork.execute(
      claims,
      "asset.multipart.put-part",
      (transaction) => this.dependencies.repository.finishPart(transaction, {
        claims,
        uploadRef,
        partNumber: part.partNumber,
        expectedPartVersion: part.expectedVersion,
        effectToken,
        providerEtag,
        state,
        now: this.now(),
      }),
    );
  }

  private async reconcileCompletion(
    claims: AssetUploadCapabilityClaims,
    upload: NonNullable<AuthorizedAssetMultipartSnapshot["upload"]>,
    _parts: readonly StoredAssetMultipartPart[],
  ): Promise<AuthorizedAssetMultipartSnapshot> {
    try {
      const observed = await this.dependencies.store.observeCompleted({
        ...route(claims),
        expectedSize: BigInt(claims.expectedSize),
        expectedChecksumSha256: claims.expectedChecksumSha256,
      });
      return this.finishCompletion(claims, upload,
        observed === "exact" ? "uploaded" : "outcome_unknown");
    } catch (error) {
      if (isIntegrityMismatch(error)) return this.rejectIntegrity(claims, upload);
      return this.finishCompletion(claims, upload, "outcome_unknown");
    }
  }

  private async retryCompletion(
    claims: AssetUploadCapabilityClaims,
    upload: NonNullable<AuthorizedAssetMultipartSnapshot["upload"]>,
    _snapshot: AuthorizedAssetMultipartSnapshot,
  ): Promise<AuthorizedAssetMultipartSnapshot> {
    return this.reconcileCompletion(claims, upload, []);
  }

  private async reconcileAbort(
    claims: AssetUploadCapabilityClaims,
    upload: NonNullable<AuthorizedAssetMultipartSnapshot["upload"]>,
    providerDisposition: "aborted" | "already_absent" | null,
  ): Promise<AuthorizedAssetMultipartSnapshot> {
    try {
      const observed = await this.dependencies.store.observeCompleted({
        ...route(claims),
        expectedSize: BigInt(claims.expectedSize),
        expectedChecksumSha256: claims.expectedChecksumSha256,
      });
      return observed === "exact"
        ? this.finishAbort(claims, upload, "uploaded")
        : this.finishAbort(claims, upload,
          providerDisposition === null ? "outcome_unknown" : "aborted");
    } catch (error) {
      if (isIntegrityMismatch(error)) return this.rejectIntegrity(claims, upload);
      return this.finishAbort(claims, upload, "outcome_unknown");
    }
  }

  private async retryAbort(
    claims: AssetUploadCapabilityClaims,
    upload: NonNullable<AuthorizedAssetMultipartSnapshot["upload"]>,
    snapshot: AuthorizedAssetMultipartSnapshot,
  ): Promise<AuthorizedAssetMultipartSnapshot> {
    if (upload.providerUploadId === null) return snapshot;
    let providerDisposition: "aborted" | "already_absent" | null = null;
    try {
      providerDisposition = await this.dependencies.store.abort({
        ...route(claims),
        providerUploadId: upload.providerUploadId,
      });
    } catch {
      // Reconciliation below owns the final decision.
    }
    return this.reconcileAbort(claims, upload, providerDisposition);
  }

  private rejectIntegrity(
    claims: AssetUploadCapabilityClaims,
    upload: NonNullable<AuthorizedAssetMultipartSnapshot["upload"]>,
  ): Promise<AuthorizedAssetMultipartSnapshot> {
    const eventId = this.reference();
    return this.dependencies.unitOfWork.execute(
      claims,
      "asset.multipart.complete",
      (transaction) => this.dependencies.repository.rejectIntegrity(transaction, {
        claims,
        uploadRef: upload.uploadRef,
        expectedVersion: upload.expectedVersion,
        safeReasonCode: "UPLOAD_PART_INVALID",
        eventId,
        correlationId: upload.completionReceiptRef ?? eventId,
        now: this.now(),
      }),
    );
  }

  private finishCompletion(
    claims: AssetUploadCapabilityClaims,
    upload: NonNullable<AuthorizedAssetMultipartSnapshot["upload"]>,
    state: "uploaded" | "outcome_unknown",
  ) {
    return this.dependencies.unitOfWork.execute(
      claims,
      "asset.multipart.complete",
      (transaction) => this.dependencies.repository.finishCompletion(transaction, {
        claims,
        uploadRef: upload.uploadRef,
        expectedVersion: upload.expectedVersion,
        state,
        now: this.now(),
      }),
    );
  }

  private finishAbort(
    claims: AssetUploadCapabilityClaims,
    upload: NonNullable<AuthorizedAssetMultipartSnapshot["upload"]>,
    state: "aborted" | "uploaded" | "outcome_unknown",
  ) {
    return this.dependencies.unitOfWork.execute(
      claims,
      "asset.multipart.abort",
      (transaction) => this.dependencies.repository.finishAbort(transaction, {
        claims,
        uploadRef: upload.uploadRef,
        expectedVersion: upload.expectedVersion,
        state,
        now: this.now(),
      }),
    );
  }

  private now(): string {
    return (this.dependencies.clock ?? (() => new Date()))().toISOString();
  }

  private reference(): string {
    return (this.dependencies.reference ?? (() => crypto.randomUUID()))();
  }
}

function requiredUpload(snapshot: AuthorizedAssetMultipartSnapshot) {
  if (snapshot.upload === null) throw new Error("UPLOAD_NOT_ACCEPTED");
  return snapshot.upload;
}

function route(claims: AssetUploadCapabilityClaims) {
  return Object.freeze({
    storageTenantRef: claims.storageTenantRef,
    storageRegion: claims.storageRegion,
    objectRef: claims.quarantineObjectRef,
  });
}

function resolveParts(
  stored: readonly StoredAssetMultipartPart[],
  requested: readonly Readonly<{ partNumber: number; partReceipt: string }>[],
  claims: AssetUploadCapabilityClaims,
  expectedSize: bigint,
): readonly StoredAssetMultipartPart[] {
  if (requested.length < 1 || requested.length > 10_000) throw new Error("UPLOAD_PART_INVALID");
  const committed = stored.filter((part) => part.state === "committed");
  if (requested.length !== committed.length) throw new Error("UPLOAD_PART_INVALID");
  const byReceipt = new Map(committed.map((part) => [part.partReceipt, part]));
  const resolved = requested.map((item, index) => {
    if (item.partNumber !== index + 1 || !identifierValue(item.partReceipt)) {
      throw new Error("UPLOAD_PART_INVALID");
    }
    const part = byReceipt.get(item.partReceipt);
    if (part === undefined || part.partNumber !== item.partNumber) throw new Error("UPLOAD_PART_INVALID");
    return part;
  });
  const minimum = BigInt(claims.minimumPartBytes);
  const maximum = BigInt(claims.maximumPartBytes);
  if (resolved.some((part, index) => part.size > maximum ||
      (index < resolved.length - 1 && part.size < minimum)) ||
      resolved.reduce((total, part) => total + part.size, 0n) !== expectedSize) {
    throw new Error("UPLOAD_PART_INVALID");
  }
  return Object.freeze(resolved);
}

function uploadReference(value: string): void {
  if (!identifierValue(value)) throw new Error("UPLOAD_NOT_ACCEPTED");
}

function identifier(value: string, code: string): void {
  if (!identifierValue(value)) throw new Error(code);
}

function identifierValue(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u.test(value);
}

function partNumber(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 10_000) throw new Error("UPLOAD_PART_INVALID");
}

function checksum(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error("UPLOAD_PART_INVALID");
}

function idempotency(value: string): void {
  if (value.length < 16 || value.length > 191 || [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127;
  })) {
    throw new Error("UPLOAD_NOT_ACCEPTED");
  }
}

function requiredPart(
  snapshot: AuthorizedAssetMultipartSnapshot,
  expectedPartNumber: number,
): StoredAssetMultipartPart {
  const part = snapshot.parts.find((candidate) => candidate.partNumber === expectedPartNumber);
  if (part === undefined) throw new Error("UPLOAD_PART_CONFLICT");
  return part;
}

function requiredProviderEtag(part: StoredAssetMultipartPart): string {
  if (part.state !== "committed" || part.providerEtag === null) {
    throw new Error("UPLOAD_PART_INVALID");
  }
  return part.providerEtag;
}

function committedParts(parts: readonly StoredAssetMultipartPart[]): readonly StoredAssetMultipartPart[] {
  const committed = parts
    .filter((part) => part.state === "committed")
    .sort((left, right) => left.partNumber - right.partNumber);
  committed.forEach(requiredProviderEtag);
  return Object.freeze(committed);
}

function isIntegrityMismatch(error: unknown): boolean {
  return error instanceof Error && error.message === "ASSET_MULTIPART_OBJECT_MISMATCH";
}

function leaseExpiry(now: string): string {
  return new Date(Date.parse(now) + 30_000).toISOString();
}
