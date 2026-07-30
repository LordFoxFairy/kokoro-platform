import { describe, expect, it } from "vitest";
import { parseAssetStorageRouteRegistry } from
  "../../src/process/asset-data-plane-composition.js";

describe("Asset data-plane production composition", () => {
  it("parses exact provider routes without inventing browser-visible credentials", () => {
    expect(parseAssetStorageRouteRegistry({ version: 1, routes: [{
      storageTenantRef: "tenant-001",
      storageRegion: "us-east-1",
      bucket: "kokoro-quarantine",
      endpoint: "https://s3.example.test",
      forcePathStyle: false,
      accessKeyId: "example-access-key",
      secretAccessKey: "example-secret-key",
      maximumObjectBytes: "10485760",
    }] })).toEqual([{ 
      storageTenantRef: "tenant-001",
      storageRegion: "us-east-1",
      bucket: "kokoro-quarantine",
      endpoint: "https://s3.example.test",
      forcePathStyle: false,
      accessKeyId: "example-access-key",
      secretAccessKey: "example-secret-key",
      maximumObjectBytes: 10_485_760n,
    }]);
  });

  it.each([
    { version: 1, routes: [] },
    { version: 1, routes: [{ storageTenantRef: "tenant-001", storageRegion: "us-east-1",
      bucket: "bucket-001", maximumObjectBytes: "100", unknown: true }] },
    { version: 1, routes: [{ storageTenantRef: "tenant-001", storageRegion: "us-east-1",
      bucket: "bucket-001", maximumObjectBytes: "100", accessKeyId: "only-one" }] },
    { version: 1, routes: [{ storageTenantRef: "tenant-001", storageRegion: "us-east-1",
      bucket: "bucket-001", maximumObjectBytes: "0" }] },
  ])("rejects an invalid provider registry %#", (value) => {
    expect(() => parseAssetStorageRouteRegistry(value)).toThrow("ASSET_STORAGE_ROUTE_REGISTRY_INVALID");
  });
});
