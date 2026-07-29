import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AssetMultipartService } from
  "../../src/modules/asset/application/services/asset-multipart-service.js";
import { digestAssetCommand } from
  "../../src/modules/asset/application/asset-digest.js";
import type {
  AssetMultipartRepositoryPort,
  AssetMultipartStorePort,
  AssetMultipartUnitOfWorkPort,
  AuthorizedAssetMultipartSnapshot,
} from "../../src/modules/asset/application/contracts/asset-multipart-ports.js";
import {
  AssetMultipartProviderOutcomeUnknownError,
  AssetMultipartProviderRejectedError,
} from "../../src/modules/asset/application/contracts/asset-multipart-ports.js";
import type { AssetUploadCapabilityClaims } from
  "../../src/modules/asset/application/contracts/asset-upload-ports.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";

const claims: AssetUploadCapabilityClaims = Object.freeze({
  version: 1,
  audience: "asset-upload.production",
  storageTenantRef: "storage_tenant_01",
  storageRegion: "us-east-1",
  siteRef: "site_01",
  workloadIdentityId: "workload_01",
  siteReleaseRef: "release_01",
  bindingEpoch: "7",
  subjectRef: "subject_01",
  subjectGeneration: "4",
  projectRef: "project_01",
  purpose: "chat.attachment",
  intentRef: "upload_intent_01",
  sessionRef: "upload_session_01",
  quarantineObjectRef: "quarantine/opaque_0123456789",
  expectedSize: "1234",
  expectedChecksumSha256: "a".repeat(64),
  capabilityEpoch: "1",
  expiresAt: "2099-07-29T12:05:00.000Z",
  minimumPartBytes: "100",
  maximumPartBytes: "10000",
  allowedOrigins: ["https://chat.example.test"],
});

describe("AssetMultipartService", () => {
  it("allows only the durable initiation effect owner to invoke the provider", async () => {
    const ownedByAnotherCall = initiationSnapshot("winning_effect_token_01");
    const repository = {
      claimInitiation: vi.fn().mockResolvedValue(ownedByAnotherCall),
    } as unknown as AssetMultipartRepositoryPort;
    const store = {
      recoverInitiation: vi.fn(),
      initiate: vi.fn(),
    } as unknown as AssetMultipartStorePort;
    const service = new AssetMultipartService({
      unitOfWork: unitOfWork(), repository, store,
      reference: references([
        "losing_effect_token_01", "losing_upload_ref_01", "losing_receipt_ref_01",
      ]),
      clock: () => new Date("2026-07-29T12:01:00.000Z"),
    });

    await expect(service.initiate({
      claims,
      clientUploadId: "client_upload_0001",
      idempotencyKey: "initiation-key-0001",
    })).resolves.toBe(ownedByAnotherCall);
    expect(store.recoverInitiation).not.toHaveBeenCalled();
    expect(store.initiate).not.toHaveBeenCalled();
  });

  it("releases deterministic initiation failures instead of recording an unknown outcome", async () => {
    const pending = initiationSnapshot("owned_effect_token_01");
    const released = initiationSnapshot(null);
    const repository = {
      claimInitiation: vi.fn().mockResolvedValue(pending),
      releaseInitiation: vi.fn().mockResolvedValue(released),
      recordInitiationUnknown: vi.fn(),
    } as unknown as AssetMultipartRepositoryPort;
    const store = {
      recoverInitiation: vi.fn().mockRejectedValue(
        new AssetMultipartProviderRejectedError("ASSET_STORAGE_ROUTE_NOT_FOUND"),
      ),
      initiate: vi.fn(),
    } as unknown as AssetMultipartStorePort;
    const service = new AssetMultipartService({
      unitOfWork: unitOfWork(), repository, store,
      reference: references([
        "owned_effect_token_01", "multipart_upload_01", "initiation_receipt_01",
      ]),
      clock: () => new Date("2026-07-29T12:01:00.000Z"),
    });

    await expect(service.initiate({
      claims,
      clientUploadId: "client_upload_0001",
      idempotencyKey: "initiation-key-0001",
    })).rejects.toThrow("ASSET_STORAGE_ROUTE_NOT_FOUND");
    expect(repository.releaseInitiation).toHaveBeenCalledOnce();
    expect(repository.recordInitiationUnknown).not.toHaveBeenCalled();
  });

  it("records only an explicitly ambiguous provider initiation effect as outcome unknown", async () => {
    const pending = initiationSnapshot("owned_effect_token_01");
    const unknown = initiationSnapshot(null, "outcome_unknown");
    const repository = {
      claimInitiation: vi.fn().mockResolvedValue(pending),
      recordInitiationUnknown: vi.fn().mockResolvedValue(unknown),
      releaseInitiation: vi.fn(),
    } as unknown as AssetMultipartRepositoryPort;
    const store = {
      recoverInitiation: vi.fn().mockResolvedValue(null),
      initiate: vi.fn().mockRejectedValue(
        new AssetMultipartProviderOutcomeUnknownError("provider_timeout"),
      ),
    } as unknown as AssetMultipartStorePort;
    const service = new AssetMultipartService({
      unitOfWork: unitOfWork(), repository, store,
      reference: references([
        "owned_effect_token_01", "multipart_upload_01", "initiation_receipt_01",
      ]),
      clock: () => new Date("2026-07-29T12:01:00.000Z"),
    });

    await expect(service.initiate({
      claims,
      clientUploadId: "client_upload_0001",
      idempotencyKey: "initiation-key-0001",
    })).resolves.toMatchObject({ upload: { state: "outcome_unknown" } });
    expect(repository.recordInitiationUnknown).toHaveBeenCalledOnce();
    expect(repository.releaseInitiation).not.toHaveBeenCalled();
  });

  it("durably rejects a completed object with deterministic integrity mismatch", async () => {
    const uploading = snapshot("uploading", 1n);
    const completing = snapshot("completing", 2n);
    const rejected = snapshot("integrity_rejected", 3n);
    const repository = {
      readAuthorized: vi.fn().mockResolvedValue(uploading),
      beginCompletion: vi.fn().mockResolvedValue(completing),
      rejectIntegrity: vi.fn().mockResolvedValue(rejected),
    } as unknown as AssetMultipartRepositoryPort;
    const store = {
      complete: vi.fn().mockResolvedValue(undefined),
      observeCompleted: vi.fn().mockRejectedValue(new Error("ASSET_MULTIPART_OBJECT_MISMATCH")),
    } as unknown as AssetMultipartStorePort;
    const service = new AssetMultipartService({
      unitOfWork: unitOfWork(),
      repository,
      store,
      reference: references([
        "completion_receipt_01",
        "0198577b-4a7c-7abc-8abc-0123456789ab",
      ]),
      clock: () => new Date("2026-07-29T12:01:00.000Z"),
    });

    await expect(service.complete({
      claims,
      uploadRef: "multipart_upload_01",
      expectedVersion: 1n,
      expectedSize: 1234n,
      expectedChecksumSha256: "a".repeat(64),
      parts: [{ partNumber: 1, partReceipt: "multipart_part_receipt_01" }],
      idempotencyKey: "completion-key-0001",
    })).resolves.toMatchObject({ upload: { state: "integrity_rejected" } });
    expect(repository.rejectIntegrity).toHaveBeenCalledOnce();
    expect(repository.rejectIntegrity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      uploadRef: "multipart_upload_01",
      expectedVersion: 2n,
      safeReasonCode: "UPLOAD_PART_INVALID",
    }));
  });

  it("records an observed completed object and rejects abort even when provider upload is absent", async () => {
    const uploading = snapshot("uploading", 1n);
    const aborting = snapshot("aborting", 2n);
    const uploaded = snapshot("uploaded", 3n);
    const repository = {
      readAuthorized: vi.fn().mockResolvedValue(uploading),
      beginAbort: vi.fn().mockResolvedValue(aborting),
      finishAbort: vi.fn().mockResolvedValue(uploaded),
    } as unknown as AssetMultipartRepositoryPort;
    const store = {
      abort: vi.fn().mockResolvedValue("already_absent"),
      observeCompleted: vi.fn().mockResolvedValue("exact"),
    } as unknown as AssetMultipartStorePort;
    const service = new AssetMultipartService({
      unitOfWork: unitOfWork(),
      repository,
      store,
      reference: references(["abort_receipt_0001"]),
      clock: () => new Date("2026-07-29T12:01:00.000Z"),
    });

    await expect(service.abort({
      claims,
      uploadRef: "multipart_upload_01",
      expectedVersion: 1n,
      idempotencyKey: "abort-idempotency-01",
    })).rejects.toThrow("UPLOAD_STATE_CONFLICT");
    expect(store.observeCompleted).toHaveBeenCalledOnce();
    expect(repository.finishAbort).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      state: "uploaded",
    }));
  });

  it("keeps abort outcome unknown when transport failed and only the completed object is absent", async () => {
    const uploading = snapshot("uploading", 1n);
    const aborting = snapshot("aborting", 2n);
    const unknown = snapshot("outcome_unknown", 3n);
    const repository = {
      readAuthorized: vi.fn().mockResolvedValue(uploading),
      beginAbort: vi.fn().mockResolvedValue(aborting),
      finishAbort: vi.fn().mockResolvedValue(unknown),
    } as unknown as AssetMultipartRepositoryPort;
    const store = {
      abort: vi.fn().mockRejectedValue(new Error("transport_timeout")),
      observeCompleted: vi.fn().mockResolvedValue("absent"),
    } as unknown as AssetMultipartStorePort;
    const service = new AssetMultipartService({
      unitOfWork: unitOfWork(), repository, store,
      reference: references(["abort_receipt_0002"]),
    });

    await expect(service.abort({
      claims,
      uploadRef: "multipart_upload_01",
      expectedVersion: 1n,
      idempotencyKey: "abort-idempotency-02",
    })).resolves.toMatchObject({ upload: { state: "outcome_unknown" } });
    expect(repository.finishAbort).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      state: "outcome_unknown",
    }));
  });

  it("claims a part identity durably before invoking the provider effect", async () => {
    const order: string[] = [];
    const pending = snapshot("uploading", 1n, "pending");
    const committed = snapshot("uploading", 1n, "committed");
    const repository = {
      claimPart: vi.fn(async () => { order.push("claim"); return pending; }),
      finishPart: vi.fn(async () => { order.push("finalize"); return committed; }),
    } as unknown as AssetMultipartRepositoryPort;
    const store = {
      putPart: vi.fn(async () => { order.push("effect"); return "provider-etag-01"; }),
    } as unknown as AssetMultipartStorePort;
    const service = new AssetMultipartService({
      unitOfWork: unitOfWork(), repository, store,
      reference: references(["multipart_part_receipt_01"]),
      clock: () => new Date("2026-07-29T12:01:00.000Z"),
    });

    await expect(service.putPart({
      claims,
      uploadRef: "multipart_upload_01",
      partNumber: 1,
      declaredSize: 1234n,
      checksumSha256: "d".repeat(64),
      idempotencyKey: "part-idempotency-01",
      body: Readable.from(Buffer.alloc(1234)),
    })).resolves.toMatchObject({ parts: [{ state: "committed" }] });
    expect(order).toEqual(["claim", "effect", "finalize"]);
  });

  it("never calls the provider when a competing part identity loses the durable claim", async () => {
    const repository = {
      claimPart: vi.fn().mockRejectedValue(new Error("UPLOAD_PART_CONFLICT")),
    } as unknown as AssetMultipartRepositoryPort;
    const store = { putPart: vi.fn() } as unknown as AssetMultipartStorePort;
    const service = new AssetMultipartService({
      unitOfWork: unitOfWork(), repository, store,
      reference: references(["multipart_part_receipt_02"]),
    });
    const body = Readable.from(Buffer.alloc(1234));

    await expect(service.putPart({
      claims,
      uploadRef: "multipart_upload_01",
      partNumber: 1,
      declaredSize: 1234n,
      checksumSha256: "e".repeat(64),
      idempotencyKey: "different-part-key-01",
      body,
    })).rejects.toThrow("UPLOAD_PART_CONFLICT");
    expect(store.putPart).not.toHaveBeenCalled();
  });

  it("does not invoke S3 when the same identity is already owned by another live effect lease", async () => {
    const pending = snapshot("uploading", 1n, "pending");
    const repository = {
      claimPart: vi.fn().mockResolvedValue(pending),
    } as unknown as AssetMultipartRepositoryPort;
    const store = { putPart: vi.fn() } as unknown as AssetMultipartStorePort;
    const service = new AssetMultipartService({
      unitOfWork: unitOfWork(), repository, store,
      reference: references(["different_effect_token_01", "multipart_part_receipt_02"]),
      clock: () => new Date("2026-07-29T12:01:00.000Z"),
    });

    await expect(service.putPart({
      claims,
      uploadRef: "multipart_upload_01",
      partNumber: 1,
      declaredSize: 1234n,
      checksumSha256: "d".repeat(64),
      idempotencyKey: "part-idempotency-01",
      body: Readable.from(Buffer.alloc(1234)),
    })).resolves.toMatchObject({ parts: [{ state: "pending" }] });
    expect(store.putPart).not.toHaveBeenCalled();
  });

  it("releases deterministic part rejection without misclassifying it as outcome unknown", async () => {
    const pending = snapshot("uploading", 1n, "pending");
    const retryable = snapshot("uploading", 1n, "retryable");
    const repository = {
      claimPart: vi.fn().mockResolvedValue(pending),
      releasePart: vi.fn().mockResolvedValue(retryable),
      finishPart: vi.fn(),
    } as unknown as AssetMultipartRepositoryPort;
    const store = {
      putPart: vi.fn().mockRejectedValue(
        new AssetMultipartProviderRejectedError("ASSET_MULTIPART_PART_CHECKSUM_MISMATCH"),
      ),
    } as unknown as AssetMultipartStorePort;
    const service = new AssetMultipartService({
      unitOfWork: unitOfWork(), repository, store,
      reference: references(["multipart_part_receipt_01"]),
    });

    await expect(service.putPart({
      claims,
      uploadRef: "multipart_upload_01",
      partNumber: 1,
      declaredSize: 1234n,
      checksumSha256: "d".repeat(64),
      idempotencyKey: "part-idempotency-01",
      body: Readable.from(Buffer.alloc(1234)),
    })).rejects.toThrow("ASSET_MULTIPART_PART_CHECKSUM_MISMATCH");
    expect(repository.releasePart).toHaveBeenCalledOnce();
    expect(repository.finishPart).not.toHaveBeenCalled();
  });

  it("aborts a provider part effect before its durable lease can be reclaimed", async () => {
    const pending = snapshot("uploading", 1n, "pending");
    const unknown = snapshot("uploading", 1n, "outcome_unknown");
    const repository = {
      claimPart: vi.fn().mockResolvedValue(pending),
      finishPart: vi.fn().mockResolvedValue(unknown),
    } as unknown as AssetMultipartRepositoryPort;
    const observedSignals: AbortSignal[] = [];
    const store = {
      putPart: vi.fn(async (input) => {
        observedSignals.push(input.signal);
        await new Promise<void>((_resolve, reject) => input.signal.addEventListener(
          "abort", () => reject(new AssetMultipartProviderOutcomeUnknownError("provider_deadline")),
          { once: true },
        ));
        return "unreachable";
      }),
    } as unknown as AssetMultipartStorePort;
    const body = Readable.from(Buffer.alloc(1234));
    const service = new AssetMultipartService({
      unitOfWork: unitOfWork(), repository, store,
      reference: references(["multipart_part_receipt_01"]),
      providerEffectTimeoutMs: 5,
    });

    await expect(service.putPart({
      claims,
      uploadRef: "multipart_upload_01",
      partNumber: 1,
      declaredSize: 1234n,
      checksumSha256: "d".repeat(64),
      idempotencyKey: "part-idempotency-01",
      body,
    })).rejects.toThrow("provider_deadline");
    expect(observedSignals).toHaveLength(1);
    expect(observedSignals[0]?.aborted).toBe(true);
    expect(repository.finishPart).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      state: "outcome_unknown",
    }));
  });
});

function snapshot(
  state: "initiating" | "uploading" | "completing" | "aborting" | "uploaded" |
    "integrity_rejected" | "outcome_unknown",
  expectedVersion: bigint,
  partState: "pending" | "retryable" | "committed" | "outcome_unknown" = "committed",
): AuthorizedAssetMultipartSnapshot {
  return Object.freeze({
    claims,
    upload: Object.freeze({
      uploadRef: "multipart_upload_01",
      siteRef: claims.siteRef,
      intentRef: claims.intentRef,
      sessionRef: claims.sessionRef,
      clientUploadId: "client_upload_0001",
      providerUploadId: "provider_upload_01",
      capabilityEpoch: 1n,
      state,
      outcomeOperation: state === "outcome_unknown" ? "abort" : null,
      expectedVersion,
      initiationIdempotencyKey: "initiation-key-0001",
      initiationRequestDigest: "b".repeat(64),
      initiationReceiptRef: "initiation_receipt_01",
      initiationEffectToken: null,
      initiationEffectLeaseExpiresAt: null,
      completionIdempotencyKey: state === "uploading" ? null : "completion-key-0001",
      completionRequestDigest: state === "uploading" ? null : "c".repeat(64),
      completionReceiptRef: state === "uploading" ? null : "completion_receipt_01",
      abortIdempotencyKey: null,
      abortRequestDigest: null,
      abortReceiptRef: null,
      createdAt: "2026-07-29T12:00:00.000Z",
      updatedAt: "2026-07-29T12:01:00.000Z",
    }),
    parts: Object.freeze([Object.freeze({
      partNumber: 1,
      partReceipt: "multipart_part_receipt_01",
      providerEtag: partState === "committed" ? "provider-etag-01" : null,
      size: 1234n,
      checksumSha256: "d".repeat(64),
      idempotencyKey: "part-idempotency-01",
      requestDigest: "e".repeat(64),
      state: partState,
      expectedVersion: partState === "pending" ? 1n : 2n,
      effectToken: partState === "pending" ? "multipart_part_receipt_01" : null,
      effectLeaseExpiresAt: partState === "pending" ? "2026-07-29T12:01:30.000Z" : null,
    })]),
  });
}

function initiationSnapshot(
  effectToken: string | null,
  state: "initiating" | "outcome_unknown" = "initiating",
): AuthorizedAssetMultipartSnapshot {
  const value = snapshot(state, 1n);
  return Object.freeze({
    ...value,
    upload: Object.freeze({
      ...value.upload!,
      providerUploadId: null,
      initiationRequestDigest: digestAssetCommand({
        operation: "initiateAssetMultipartUpload",
        sessionRef: claims.sessionRef,
        capabilityEpoch: claims.capabilityEpoch,
        clientUploadId: "client_upload_0001",
        protocolRevision: "s3-multipart-v1",
      }),
      outcomeOperation: state === "outcome_unknown" ? "initiate" as const : null,
      initiationEffectToken: effectToken,
      initiationEffectLeaseExpiresAt: effectToken === null
        ? null
        : "2026-07-29T12:01:30.000Z",
    }),
    parts: Object.freeze([]),
  });
}

function unitOfWork(): AssetMultipartUnitOfWorkPort {
  return {
    async execute(_claims, _operation, work) {
      const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 1 });
      try {
        return await work(lease.transaction);
      } finally {
        revokePlatformTransaction(lease);
      }
    },
  };
}

function references(values: readonly string[]): () => string {
  let index = 0;
  return () => values[index++] ?? "0198577b-4a7c-7abc-8abc-0123456789ff";
}

void Readable;
