import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  CompleteMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import {
  AssetMultipartProviderOutcomeUnknownError,
  AssetMultipartProviderRejectedError,
} from "../../src/modules/asset/application/contracts/asset-multipart-ports.js";
import { S3AssetObjectStore } from
  "../../src/modules/asset/infrastructure/s3/asset-object-store.js";

const route = Object.freeze({
  storageTenantRef: "storage_tenant_01",
  storageRegion: "us-east-1",
  bucket: "asset-bucket",
  maximumObjectBytes: 10_000n,
});

describe("S3AssetObjectStore exact cleanup", () => {
  it("returns an observable unknown outcome for a conflicting trusted target", async () => {
    const send = vi.fn().mockResolvedValueOnce({
      VersionId: "trusted_version_conflict", ContentLength: 1235, ETag: "etag",
      Metadata: { sha256: "b".repeat(64) },
    });
    const store = new S3AssetObjectStore([route], () => ({ send } as never));
    await expect(store.copyExact({
      storageTenantRef: "storage_tenant_01", storageRegion: "us-east-1",
      sourceObjectRef: "quarantine/opaque_0123456789",
      sourceProviderVersionRef: "provider_version_01", targetObjectRef: "trusted/blob_01",
      expectedChecksumSha256: "a".repeat(64), expectedSize: 1234n,
      idempotencyKey: "promotion_01",
    })).resolves.toEqual({ disposition: "outcome_unknown" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("deletes only the frozen provider version and confirms exact absence", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ VersionId: "provider_version_01", ContentLength: 1234, ETag: "etag" })
      .mockResolvedValueOnce({ VersionId: "provider_version_01" })
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { name: "NoSuchVersion",
        $metadata: { httpStatusCode: 404 } }));
    const store = new S3AssetObjectStore([route], () => ({ send } as never));

    await expect(store.deleteExact({
      storageTenantRef: "storage_tenant_01", storageRegion: "us-east-1",
      objectRef: "quarantine/opaque_0123456789", providerVersionRef: "provider_version_01",
      expectedSize: 1234n,
    })).resolves.toMatchObject({ disposition: "confirmed_absent", providerDisposition: "deleted" });
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(DeleteObjectCommand);
    expect((send.mock.calls[1]?.[0] as DeleteObjectCommand).input).toMatchObject({
      Bucket: "asset-bucket", Key: "quarantine/opaque_0123456789",
      VersionId: "provider_version_01",
    });
    expect((send.mock.calls[2]?.[0] as HeadObjectCommand).input.VersionId)
      .toBe("provider_version_01");
  });

  it("treats an already missing exact version as idempotent success without issuing delete", async () => {
    const send = vi.fn().mockRejectedValueOnce(Object.assign(new Error("missing"), {
      name: "NoSuchVersion", $metadata: { httpStatusCode: 404 },
    }));
    const store = new S3AssetObjectStore([route], () => ({ send } as never));
    await expect(store.deleteExact({
      storageTenantRef: "storage_tenant_01", storageRegion: "us-east-1",
      objectRef: "quarantine/opaque_0123456789", providerVersionRef: "provider_version_01",
      expectedSize: 1234n,
    })).resolves.toMatchObject({
      disposition: "confirmed_absent", providerDisposition: "already_absent",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not report deletion while the exact version remains visible after an ambiguous effect", async () => {
    const present = { VersionId: "provider_version_01", ContentLength: 1234, ETag: "etag" };
    const send = vi.fn()
      .mockResolvedValueOnce(present)
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(present);
    const store = new S3AssetObjectStore([route], () => ({ send } as never));
    await expect(store.deleteExact({
      storageTenantRef: "storage_tenant_01", storageRegion: "us-east-1",
      objectRef: "quarantine/opaque_0123456789", providerVersionRef: "provider_version_01",
      expectedSize: 1234n,
    })).resolves.toEqual({
      disposition: "retry", code: "ASSET_OBJECT_DELETE_OUTCOME_UNKNOWN",
    });
  });
});

describe("S3AssetObjectStore multipart data plane", () => {
  it("classifies an ambiguous create transport result separately from deterministic provider rejection", async () => {
    const ambiguous = new S3AssetObjectStore([route], () => ({
      send: vi.fn().mockRejectedValue(new Error("socket_timeout")),
    } as never));
    await expect(ambiguous.initiate({
      storageTenantRef: route.storageTenantRef,
      storageRegion: route.storageRegion,
      objectRef: "quarantine/opaque_0123456789",
      uploadRef: "multipart_upload_01",
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(AssetMultipartProviderOutcomeUnknownError);

    const rejected = new S3AssetObjectStore([route], () => ({
      send: vi.fn().mockResolvedValue({ UploadId: "" }),
    } as never));
    await expect(rejected.initiate({
      storageTenantRef: route.storageTenantRef,
      storageRegion: route.storageRegion,
      objectRef: "quarantine/opaque_0123456789",
      uploadRef: "multipart_upload_01",
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(AssetMultipartProviderRejectedError);
  });

  it("passes the effect deadline to S3 and tears down the body when it expires", async () => {
    const controller = new AbortController();
    const send = vi.fn((_command: UploadPartCommand, options?: { abortSignal?: AbortSignal }) =>
      new Promise((_resolve, reject) => options?.abortSignal?.addEventListener(
        "abort", () => reject(new Error("sdk_aborted")), { once: true },
      )));
    const store = new S3AssetObjectStore([route], () => ({ send } as never));
    const body = Readable.from(Buffer.alloc(1234));
    const effect = store.putPart({
      storageTenantRef: route.storageTenantRef,
      storageRegion: route.storageRegion,
      objectRef: "quarantine/opaque_0123456789",
      providerUploadId: "provider_upload_01",
      partNumber: 1,
      declaredSize: 1234n,
      checksumSha256: "d".repeat(64),
      body,
      signal: controller.signal,
    });

    controller.abort();
    await expect(effect).rejects.toBeInstanceOf(AssetMultipartProviderOutcomeUnknownError);
    expect(send.mock.calls[0]?.[1]?.abortSignal).toBe(controller.signal);
    expect(body.destroyed).toBe(true);
  });

  it("classifies an invalid successful part response as deterministic and safely retryable", async () => {
    const send = vi.fn(async (command: UploadPartCommand) => {
      for await (const _chunk of command.input.Body as unknown as AsyncIterable<Uint8Array>) {
        // consume the exact admitted stream
      }
      return { ETag: "" };
    });
    const store = new S3AssetObjectStore([route], () => ({ send } as never));
    await expect(store.putPart({
      storageTenantRef: route.storageTenantRef,
      storageRegion: route.storageRegion,
      objectRef: "quarantine/opaque_0123456789",
      providerUploadId: "provider_upload_01",
      partNumber: 1,
      declaredSize: 5n,
      checksumSha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      body: Readable.from(Buffer.from("hello")),
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(AssetMultipartProviderRejectedError);
  });

  it("completes with the exact provider etag and per-part SHA-256", async () => {
    const send = vi.fn().mockResolvedValue({});
    const store = new S3AssetObjectStore([route], () => ({ send } as never));

    await store.complete({
      storageTenantRef: route.storageTenantRef,
      storageRegion: route.storageRegion,
      objectRef: "quarantine/opaque_0123456789",
      providerUploadId: "provider_upload_01",
      parts: [{
        partNumber: 1,
        providerEtag: "provider-etag-01",
        checksumSha256: "a".repeat(64),
      }],
    });

    const command = send.mock.calls[0]?.[0] as CompleteMultipartUploadCommand;
    expect(command).toBeInstanceOf(CompleteMultipartUploadCommand);
    expect(command.input.MultipartUpload?.Parts).toEqual([{
      PartNumber: 1,
      ETag: "provider-etag-01",
      ChecksumSHA256: Buffer.from("a".repeat(64), "hex").toString("base64"),
    }]);
  });

  it("propagates source stream failure into the provider body and tears the pipeline down", async () => {
    const send = vi.fn(async (command: UploadPartCommand) => {
      const body = command.input.Body as unknown as AsyncIterable<Uint8Array>;
      for await (const _chunk of body) {
        // Consume like the AWS request handler; the source failure must reject this iterator.
      }
      return { ETag: "provider-etag-01" };
    });
    const store = new S3AssetObjectStore([route], () => ({ send } as never));
    const body = new Readable({
      read() {
        this.push(Buffer.from("hello"));
        this.destroy(new Error("source_failed"));
      },
    });

    await expect(Promise.race([
      store.putPart({
        storageTenantRef: route.storageTenantRef,
        storageRegion: route.storageRegion,
        objectRef: "quarantine/opaque_0123456789",
        providerUploadId: "provider_upload_01",
        partNumber: 1,
        declaredSize: 5n,
        checksumSha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        body,
        signal: new AbortController().signal,
      }),
      rejectAfter(100, "source_failure_not_propagated"),
    ])).rejects.toThrow("source_failed");
  });

  it("classifies a completed object larger than the admitted bound as deterministic integrity rejection", async () => {
    const send = vi.fn().mockResolvedValue({
      VersionId: "provider_version_01",
      ContentLength: 10_001,
      ETag: "provider-etag-01",
    });
    const store = new S3AssetObjectStore([route], () => ({ send } as never));

    await expect(store.observeCompleted({
      storageTenantRef: route.storageTenantRef,
      storageRegion: route.storageRegion,
      objectRef: "quarantine/opaque_0123456789",
      expectedSize: 1234n,
      expectedChecksumSha256: "a".repeat(64),
    })).rejects.toThrow("ASSET_MULTIPART_OBJECT_MISMATCH");
  });
});

function rejectAfter(milliseconds: number, message: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(message)), milliseconds).unref();
  });
}
