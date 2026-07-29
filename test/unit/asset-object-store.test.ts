import { describe, expect, it, vi } from "vitest";
import { DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
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
