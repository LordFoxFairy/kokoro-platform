import type { Readable } from "node:stream";
import { digestAssetCommand } from "../asset-digest.js";
import type {
  AssetMultipartRepositoryPort,
  AssetMultipartStorePort,
  AssetMultipartUnitOfWorkPort,
  AuthorizedAssetMultipartSnapshot,
  StoredAssetMultipartPart,
} from "../contracts/asset-multipart-ports.js";
import { AssetMultipartProviderOutcomeUnknownError } from
  "../contracts/asset-multipart-ports.js";
import type { AssetUploadCapabilityClaims } from "../contracts/asset-upload-ports.js";

export class AssetMultipartService {
  constructor(private readonly dependencies: Readonly<{
    unitOfWork: AssetMultipartUnitOfWorkPort;
    repository: AssetMultipartRepositoryPort;
    store: AssetMultipartStorePort;
    clock?: () => Date;
    reference?: () => string;
    providerEffectTimeoutMs?: number;
    monotonicClock?: () => number;
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
    const claimedMonotonic = this.monotonicNow();
    const effectToken = this.reference();
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
        effectToken,
        effectLeaseExpiresAt: leaseExpiry(now, input.claims.expiresAt),
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
    if (upload.initiationEffectToken !== effectToken) return snapshot;
    try {
      const signal = this.effectSignal(claimedMonotonic, input.claims.expiresAt);
      const recovered = await this.dependencies.store.recoverInitiation({
        ...route(input.claims), signal,
      });
      if (recovered === null && upload.state === "outcome_unknown" &&
          upload.outcomeOperation === "initiate") {
        // List absence is not proof that a timed-out CreateMultipartUpload was never accepted.
        // Releasing only this reconciliation lease preserves the unknown durable state and makes
        // duplicate provider submissions impossible.
        return this.dependencies.unitOfWork.execute(
          input.claims,
          "asset.multipart.initiate",
          (transaction) => this.dependencies.repository.releaseInitiation(transaction, {
            claims: input.claims,
            uploadRef: upload.uploadRef,
            expectedVersion: upload.expectedVersion,
            effectToken,
            now: this.now(),
          }),
        );
      }
      const providerUploadId = recovered ?? await this.dependencies.store.initiate({
        ...route(input.claims), uploadRef: upload.uploadRef, signal,
      });
      snapshot = await this.dependencies.unitOfWork.execute(
        input.claims,
        "asset.multipart.initiate",
        (transaction) => this.dependencies.repository.recordInitiated(transaction, {
          claims: input.claims,
          uploadRef: upload.uploadRef,
          expectedVersion: upload.expectedVersion,
          providerUploadId,
          effectToken,
          now: this.now(),
        }),
      );
    } catch (error) {
      if (error instanceof AssetMultipartProviderOutcomeUnknownError) {
        snapshot = await this.dependencies.unitOfWork.execute(
          input.claims,
          "asset.multipart.initiate",
          (transaction) => this.dependencies.repository.recordInitiationUnknown(transaction, {
            claims: input.claims,
            uploadRef: upload.uploadRef,
            expectedVersion: upload.expectedVersion,
            effectToken,
            now: this.now(),
          }),
        );
      } else {
        await this.dependencies.unitOfWork.execute(
          input.claims,
          "asset.multipart.initiate",
          (transaction) => this.dependencies.repository.releaseInitiation(transaction, {
            claims: input.claims,
            uploadRef: upload.uploadRef,
            expectedVersion: upload.expectedVersion,
            effectToken,
            now: this.now(),
          }),
        );
        throw error;
      }
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
    const claimedMonotonic = this.monotonicNow();
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
        effectLeaseExpiresAt: leaseExpiry(claimedAt, input.claims.expiresAt),
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
        signal: this.effectSignal(claimedMonotonic, input.claims.expiresAt),
      });
      snapshot = await this.finishPart(input.claims, input.uploadRef, part, effectToken,
        "committed", providerEtag);
      return snapshot;
    } catch (error) {
      if (error instanceof AssetMultipartProviderOutcomeUnknownError) {
        await this.finishPart(input.claims, input.uploadRef, part, effectToken,
          "outcome_unknown", null)
          .catch(() => undefined);
      } else {
        await this.releasePart(input.claims, input.uploadRef, part, effectToken);
      }
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
    const receiptRef = this.reference();
    const effectToken = this.reference();
    const claimedAt = this.now();
    const claimedMonotonic = this.monotonicNow();
    const snapshot = await this.dependencies.unitOfWork.execute(
      input.claims,
      "asset.multipart.complete",
      (transaction) => this.dependencies.repository.beginCompletion(transaction, {
        claims: input.claims,
        uploadRef: input.uploadRef,
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        receiptRef,
        effectToken,
        effectLeaseExpiresAt: leaseExpiry(claimedAt, input.claims.expiresAt),
        now: claimedAt,
      }),
    );
    const upload = requiredUpload(snapshot);
    if (upload.state === "uploaded" || upload.state === "integrity_rejected") return snapshot;
    if (upload.completionEffectToken !== effectToken) return snapshot;
    if (upload.providerUploadId === null) throw new Error("UPLOAD_STATE_CONFLICT");
    let signal: AbortSignal;
    try {
      signal = this.effectSignal(claimedMonotonic, input.claims.expiresAt);
    } catch (error) {
      await this.releaseCompletionEffect(input.claims, upload, effectToken);
      throw error;
    }
    try {
      await this.dependencies.store.complete({
        ...route(input.claims),
        providerUploadId: upload.providerUploadId,
        parts: ordered.map((part) => ({
          partNumber: part.partNumber,
          providerEtag: requiredProviderEtag(part),
          checksumSha256: part.checksumSha256,
        })),
        signal,
      });
    } catch (error) {
      if (!(error instanceof AssetMultipartProviderOutcomeUnknownError)) {
        await this.releaseCompletionEffect(input.claims, upload, effectToken);
        throw error;
      }
      // CompleteMultipartUpload may have committed even when its response was lost. Observation,
      // never the transport exception, decides whether the object is terminal.
    }
    return this.reconcileCompletion(input.claims, upload, effectToken, signal);
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
    const current = await this.status(input.claims, input.uploadRef);
    const currentUpload = requiredUpload(current);
    if (currentUpload.state === "aborted") return current;
    if (currentUpload.state === "uploaded" || currentUpload.state === "integrity_rejected") {
      throw new Error("UPLOAD_STATE_CONFLICT");
    }
    if (currentUpload.state === "outcome_unknown" && currentUpload.outcomeOperation === "abort") {
      return current;
    }
    if (!["uploading", "aborting"].includes(currentUpload.state)) {
      throw new Error("UPLOAD_STATE_CONFLICT");
    }
    const receiptRef = this.reference();
    const effectToken = this.reference();
    const claimedAt = this.now();
    const claimedMonotonic = this.monotonicNow();
    const snapshot = await this.dependencies.unitOfWork.execute(
      input.claims,
      "asset.multipart.abort",
      (transaction) => this.dependencies.repository.beginAbort(transaction, {
        claims: input.claims,
        uploadRef: input.uploadRef,
        expectedVersion: input.expectedVersion,
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        receiptRef,
        effectToken,
        effectLeaseExpiresAt: leaseExpiry(claimedAt, input.claims.expiresAt),
        now: claimedAt,
      }),
    );
    const upload = requiredUpload(snapshot);
    if (upload.state === "aborted") return snapshot;
    if (upload.state === "uploaded" || upload.state === "integrity_rejected") {
      throw new Error("UPLOAD_STATE_CONFLICT");
    }
    if (upload.abortEffectToken !== effectToken) return snapshot;
    if (upload.providerUploadId === null) throw new Error("UPLOAD_STATE_CONFLICT");
    let signal: AbortSignal;
    try {
      signal = this.effectSignal(claimedMonotonic, input.claims.expiresAt);
    } catch (error) {
      await this.releaseAbortEffect(input.claims, upload, effectToken);
      throw error;
    }
    let providerDisposition: "aborted" | "already_absent" | null = null;
    try {
      providerDisposition = await this.dependencies.store.abort({
        ...route(input.claims),
        providerUploadId: upload.providerUploadId,
        signal,
      });
    } catch (error) {
      if (!(error instanceof AssetMultipartProviderOutcomeUnknownError)) {
        await this.releaseAbortEffect(input.claims, upload, effectToken);
        throw error;
      }
      // Abort may have committed even when the response was lost. A missing multipart upload is
      // not proof that a completed object is absent, so reconciliation always observes the key.
    }
    const reconciled = await this.reconcileAbort(
      input.claims, upload, effectToken, signal, providerDisposition,
    );
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
    if (
      upload.state === "initiating" ||
      (upload.state === "outcome_unknown" && upload.outcomeOperation === "initiate")
    ) {
      return this.initiate({
        claims,
        clientUploadId: upload.clientUploadId,
        idempotencyKey: upload.initiationIdempotencyKey,
      });
    }
    if (
      upload.state === "completing" ||
      (upload.state === "outcome_unknown" && upload.outcomeOperation === "complete")
    ) {
      return this.retryCompletion(claims, upload, snapshot);
    }
    if (
      upload.state === "aborting" ||
      (upload.state === "outcome_unknown" && upload.outcomeOperation === "abort")
    ) {
      return this.retryAbort(claims, upload, snapshot);
    }
    return snapshot;
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

  private releasePart(
    claims: AssetUploadCapabilityClaims,
    uploadRef: string,
    part: StoredAssetMultipartPart,
    effectToken: string,
  ) {
    return this.dependencies.unitOfWork.execute(
      claims,
      "asset.multipart.put-part",
      (transaction) => this.dependencies.repository.releasePart(transaction, {
        claims,
        uploadRef,
        partNumber: part.partNumber,
        expectedPartVersion: part.expectedVersion,
        effectToken,
        now: this.now(),
      }),
    );
  }

  private async reconcileCompletion(
    claims: AssetUploadCapabilityClaims,
    upload: NonNullable<AuthorizedAssetMultipartSnapshot["upload"]>,
    effectToken: string,
    signal: AbortSignal,
  ): Promise<AuthorizedAssetMultipartSnapshot> {
    try {
      const observed = await this.dependencies.store.observeCompleted({
        ...route(claims),
        expectedSize: BigInt(claims.expectedSize),
        expectedChecksumSha256: claims.expectedChecksumSha256,
        signal,
      });
      return this.finishCompletion(claims, upload, effectToken,
        observed === "exact" ? "uploaded" : "outcome_unknown");
    } catch (error) {
      if (isIntegrityMismatch(error)) {
        return this.rejectIntegrity(claims, upload, "complete", effectToken);
      }
      return this.finishCompletion(claims, upload, effectToken, "outcome_unknown");
    }
  }

  private async retryCompletion(
    claims: AssetUploadCapabilityClaims,
    upload: NonNullable<AuthorizedAssetMultipartSnapshot["upload"]>,
    snapshot: AuthorizedAssetMultipartSnapshot,
  ): Promise<AuthorizedAssetMultipartSnapshot> {
    if (upload.providerUploadId === null) return snapshot;
    const effectToken = this.reference();
    const claimedAt = this.now();
    const claimedMonotonic = this.monotonicNow();
    const claimed = await this.dependencies.unitOfWork.execute(
      claims,
      "asset.multipart.complete",
      (transaction) => this.dependencies.repository.claimCompletionEffect(transaction, {
        claims,
        uploadRef: upload.uploadRef,
        expectedVersion: upload.expectedVersion,
        effectToken,
        effectLeaseExpiresAt: leaseExpiry(claimedAt, claims.expiresAt),
        now: claimedAt,
      }),
    );
    const owned = requiredUpload(claimed);
    if (owned.completionEffectToken !== effectToken) return claimed;
    let signal: AbortSignal;
    try {
      signal = this.effectSignal(claimedMonotonic, claims.expiresAt);
    } catch (error) {
      await this.releaseCompletionEffect(claims, owned, effectToken);
      throw error;
    }
    try {
      const observed = await this.dependencies.store.observeCompleted({
        ...route(claims),
        expectedSize: BigInt(claims.expectedSize),
        expectedChecksumSha256: claims.expectedChecksumSha256,
        signal,
      });
      if (observed === "exact") {
        return this.finishCompletion(claims, owned, effectToken, "uploaded");
      }
    } catch (error) {
      if (isIntegrityMismatch(error)) {
        return this.rejectIntegrity(claims, owned, "complete", effectToken);
      }
      return this.finishCompletion(claims, owned, effectToken, "outcome_unknown");
    }
    const frozen = committedParts(claimed.parts);
    try {
      await this.dependencies.store.complete({
        ...route(claims),
        providerUploadId: owned.providerUploadId!,
        parts: frozen.map((part) => ({
          partNumber: part.partNumber,
          providerEtag: requiredProviderEtag(part),
          checksumSha256: part.checksumSha256,
        })),
        signal,
      });
    } catch (error) {
      if (!(error instanceof AssetMultipartProviderOutcomeUnknownError)) {
        await this.releaseCompletionEffect(claims, owned, effectToken);
        throw error;
      }
      // The same provider upload and frozen parts are safe to observe after an ambiguous replay.
    }
    return this.reconcileCompletion(claims, owned, effectToken, signal);
  }

  private async reconcileAbort(
    claims: AssetUploadCapabilityClaims,
    upload: NonNullable<AuthorizedAssetMultipartSnapshot["upload"]>,
    effectToken: string,
    signal: AbortSignal,
    providerDisposition: "aborted" | "already_absent" | null,
  ): Promise<AuthorizedAssetMultipartSnapshot> {
    try {
      const observed = await this.dependencies.store.observeCompleted({
        ...route(claims),
        expectedSize: BigInt(claims.expectedSize),
        expectedChecksumSha256: claims.expectedChecksumSha256,
        signal,
      });
      return observed === "exact"
        ? this.finishAbort(claims, upload, effectToken, "uploaded")
        : this.finishAbort(claims, upload, effectToken,
          providerDisposition === null ? "outcome_unknown" : "aborted");
    } catch (error) {
      if (isIntegrityMismatch(error)) {
        return this.rejectIntegrity(claims, upload, "abort", effectToken);
      }
      return this.finishAbort(claims, upload, effectToken, "outcome_unknown");
    }
  }

  private async retryAbort(
    claims: AssetUploadCapabilityClaims,
    upload: NonNullable<AuthorizedAssetMultipartSnapshot["upload"]>,
    snapshot: AuthorizedAssetMultipartSnapshot,
  ): Promise<AuthorizedAssetMultipartSnapshot> {
    if (upload.providerUploadId === null) return snapshot;
    const effectToken = this.reference();
    const claimedAt = this.now();
    const claimedMonotonic = this.monotonicNow();
    const claimed = await this.dependencies.unitOfWork.execute(
      claims,
      "asset.multipart.abort",
      (transaction) => this.dependencies.repository.claimAbortEffect(transaction, {
        claims,
        uploadRef: upload.uploadRef,
        expectedVersion: upload.expectedVersion,
        effectToken,
        effectLeaseExpiresAt: leaseExpiry(claimedAt, claims.expiresAt),
        now: claimedAt,
      }),
    );
    const owned = requiredUpload(claimed);
    if (owned.abortEffectToken !== effectToken) return claimed;
    let signal: AbortSignal;
    try {
      signal = this.effectSignal(claimedMonotonic, claims.expiresAt);
    } catch (error) {
      await this.releaseAbortEffect(claims, owned, effectToken);
      throw error;
    }
    try {
      const observed = await this.dependencies.store.observeCompleted({
        ...route(claims),
        expectedSize: BigInt(claims.expectedSize),
        expectedChecksumSha256: claims.expectedChecksumSha256,
        signal,
      });
      if (observed === "exact") {
        return this.finishAbort(claims, owned, effectToken, "uploaded");
      }
    } catch (error) {
      if (isIntegrityMismatch(error)) {
        return this.rejectIntegrity(claims, owned, "abort", effectToken);
      }
      return this.finishAbort(claims, owned, effectToken, "outcome_unknown");
    }
    let providerDisposition: "aborted" | "already_absent" | null = null;
    try {
      providerDisposition = await this.dependencies.store.abort({
        ...route(claims),
        providerUploadId: owned.providerUploadId!,
        signal,
      });
    } catch (error) {
      if (!(error instanceof AssetMultipartProviderOutcomeUnknownError)) {
        await this.releaseAbortEffect(claims, owned, effectToken);
        throw error;
      }
      // Reconciliation below owns the final decision.
    }
    return this.reconcileAbort(claims, owned, effectToken, signal, providerDisposition);
  }

  private rejectIntegrity(
    claims: AssetUploadCapabilityClaims,
    upload: NonNullable<AuthorizedAssetMultipartSnapshot["upload"]>,
    effectOperation: "complete" | "abort",
    effectToken: string,
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
        effectOperation,
        effectToken,
        eventId,
        correlationId: upload.completionReceiptRef ?? eventId,
        now: this.now(),
      }),
    );
  }

  private finishCompletion(
    claims: AssetUploadCapabilityClaims,
    upload: NonNullable<AuthorizedAssetMultipartSnapshot["upload"]>,
    effectToken: string,
    state: "uploaded" | "outcome_unknown",
  ) {
    return this.dependencies.unitOfWork.execute(
      claims,
      "asset.multipart.complete",
      (transaction) => this.dependencies.repository.finishCompletion(transaction, {
        claims,
        uploadRef: upload.uploadRef,
        expectedVersion: upload.expectedVersion,
        effectToken,
        state,
        now: this.now(),
      }),
    );
  }

  private releaseCompletionEffect(
    claims: AssetUploadCapabilityClaims,
    upload: NonNullable<AuthorizedAssetMultipartSnapshot["upload"]>,
    effectToken: string,
  ) {
    return this.dependencies.unitOfWork.execute(
      claims,
      "asset.multipart.complete",
      (transaction) => this.dependencies.repository.releaseCompletionEffect(transaction, {
        claims,
        uploadRef: upload.uploadRef,
        expectedVersion: upload.expectedVersion,
        effectToken,
        now: this.now(),
      }),
    );
  }

  private finishAbort(
    claims: AssetUploadCapabilityClaims,
    upload: NonNullable<AuthorizedAssetMultipartSnapshot["upload"]>,
    effectToken: string,
    state: "aborted" | "uploaded" | "outcome_unknown",
  ) {
    return this.dependencies.unitOfWork.execute(
      claims,
      "asset.multipart.abort",
      (transaction) => this.dependencies.repository.finishAbort(transaction, {
        claims,
        uploadRef: upload.uploadRef,
        expectedVersion: upload.expectedVersion,
        effectToken,
        state,
        now: this.now(),
      }),
    );
  }

  private releaseAbortEffect(
    claims: AssetUploadCapabilityClaims,
    upload: NonNullable<AuthorizedAssetMultipartSnapshot["upload"]>,
    effectToken: string,
  ) {
    return this.dependencies.unitOfWork.execute(
      claims,
      "asset.multipart.abort",
      (transaction) => this.dependencies.repository.releaseAbortEffect(transaction, {
        claims,
        uploadRef: upload.uploadRef,
        expectedVersion: upload.expectedVersion,
        effectToken,
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

  private monotonicNow(): number {
    return (this.dependencies.monotonicClock ?? (() => performance.now()))();
  }

  private effectSignal(claimedAt: number, capabilityExpiresAt: string): AbortSignal {
    const requested = this.dependencies.providerEffectTimeoutMs ?? PROVIDER_EFFECT_TIMEOUT_MS;
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > PROVIDER_EFFECT_TIMEOUT_MS) {
      throw new Error("ASSET_MULTIPART_PROVIDER_TIMEOUT_INVALID");
    }
    const elapsed = Math.max(0, this.monotonicNow() - claimedAt);
    const capabilityRemaining = Date.parse(capabilityExpiresAt) - Date.parse(this.now()) -
      EFFECT_LEASE_SAFETY_MS;
    const remaining = Math.floor(Math.min(
      EFFECT_LEASE_MS - EFFECT_LEASE_SAFETY_MS - elapsed,
      capabilityRemaining,
    ));
    if (remaining < 1) throw new Error("UPLOAD_CAPABILITY_REJECTED");
    return AbortSignal.timeout(Math.min(requested, remaining));
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
  if (stored.some((part) => part.state !== "committed")) {
    throw new Error("UPLOAD_STATE_CONFLICT");
  }
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

const EFFECT_LEASE_MS = 120_000;
const EFFECT_LEASE_SAFETY_MS = 20_000;
const PROVIDER_EFFECT_TIMEOUT_MS = 90_000;

function leaseExpiry(value: string, capabilityExpiresAt: string): string {
  return new Date(Math.min(
    Date.parse(value) + EFFECT_LEASE_MS,
    Date.parse(capabilityExpiresAt),
  )).toISOString();
}

function committedParts(parts: readonly StoredAssetMultipartPart[]): readonly StoredAssetMultipartPart[] {
  if (parts.some((part) => part.state !== "committed")) {
    throw new Error("UPLOAD_STATE_CONFLICT");
  }
  const committed = parts
    .filter((part) => part.state === "committed")
    .sort((left, right) => left.partNumber - right.partNumber);
  committed.forEach(requiredProviderEtag);
  return Object.freeze(committed);
}

function isIntegrityMismatch(error: unknown): boolean {
  return error instanceof Error && error.message === "ASSET_MULTIPART_OBJECT_MISMATCH";
}
