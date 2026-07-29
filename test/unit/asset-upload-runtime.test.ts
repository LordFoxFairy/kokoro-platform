import { describe, expect, it } from "vitest";
import { parseAssetUploadPolicyRegistry } from "../../src/modules/asset/infrastructure/config/asset-upload-policy-registry.js";
import {
  parseAssetUploadCapabilityKeyRing,
  SealedAssetUploadCapabilityIssuer,
} from "../../src/modules/asset/infrastructure/crypto/asset-upload-capability.js";

const policyDocument = Object.freeze({
  version: 1,
  profiles: [Object.freeze({
    siteRef: "site_01", siteReleaseRef: "release_01", bindingEpoch: "7",
    purpose: "chat.attachment", policyRevisionRef: "asset_policy_01",
    quotaRevisionRef: "quota_revision_01", storageTenantRef: "tenant_01",
    storageRegion: "us-east-1", uploadAudience: "asset-upload.production",
    uploadEndpoint: "https://upload.example.test/v1/multipart",
    allowedOrigins: ["https://chat.example.test"],
    allowedClientMediaTypes: ["image/png", "text/plain"], maximumFileBytes: "10000000",
    maximumInflightBytes: "100000000", maximumReadyBytes: "1000000000",
    minimumPartBytes: "5242880", maximumPartBytes: "10000000",
    capabilityLifetimeSeconds: 300, sessionLifetimeSeconds: 3600,
  })],
});

describe("Asset upload production runtime", () => {
  it("resolves an exact Site release/binding/purpose profile and rejects widening", async () => {
    const registry = parseAssetUploadPolicyRegistry(policyDocument);
    await expect(registry.resolve({
      siteRef: "site_01", siteReleaseRef: "release_01", bindingEpoch: 7n,
      subjectRef: "subject_01", subjectGeneration: 4n, projectRef: "project_01",
      purpose: "chat.attachment", clientMediaType: "IMAGE/PNG", expectedSize: 1234n,
      now: "2026-07-28T12:00:00.000Z",
    })).resolves.toMatchObject({
      policy: { policyRevisionRef: "asset_policy_01", expiresAt: "2026-07-28T13:00:00.000Z" },
      uploadAudience: "asset-upload.production",
      allowedOrigins: ["https://chat.example.test"],
    });
    await expect(registry.resolve({
      siteRef: "site_02", siteReleaseRef: "release_01", bindingEpoch: 7n,
      subjectRef: "subject_01", subjectGeneration: 4n, projectRef: "project_01",
      purpose: "chat.attachment", clientMediaType: "image/png", expectedSize: 1234n,
      now: "2026-07-28T12:00:00.000Z",
    })).rejects.toThrow("ASSET_NOT_ACCEPTED");
  });

  it("seals storage authority in an opaque authenticated capability", async () => {
    const registry = parseAssetUploadPolicyRegistry(policyDocument);
    const keyRing = parseAssetUploadCapabilityKeyRing({
      version: 1,
      currentKeyRevision: "key_01",
      keys: [{ keyRevision: "key_01", keyBase64url: Buffer.alloc(32, 7).toString("base64url") }],
    });
    const issuer = new SealedAssetUploadCapabilityIssuer(keyRing, registry, () => Buffer.alloc(12, 9));
    const issuance = Object.freeze({
      audience: "asset-upload.production", storageTenantRef: "tenant_01", storageRegion: "us-east-1",
      siteRef: "site_01", workloadIdentityId: "workload_01", siteReleaseRef: "release_01",
      bindingEpoch: 7n, subjectRef: "subject_01", subjectGeneration: 4n, projectRef: "project_01",
      purpose: "chat.attachment", intentRef: "intent_01", sessionRef: "session_01",
      quarantineObjectRef: "quarantine/opaque-secret-object", expectedSize: 1234n,
      expectedChecksumSha256: "a".repeat(64), capabilityEpoch: 1n,
      expiresAt: "2026-07-28T12:05:00.000Z", minimumPartBytes: 100n, maximumPartBytes: 10_000n,
      allowedOrigins: ["https://chat.example.test"],
    });
    const capability = await issuer.issue(issuance);
    expect(capability.uploadEndpoint).toBe("https://upload.example.test/v1/multipart");
    expect(capability.credential).not.toContain("site_01");
    expect(capability.credential).not.toContain("quarantine");
    expect(issuer.verify(capability.credential)).toMatchObject({
      siteRef: "site_01", projectRef: "project_01", capabilityEpoch: "1", bindingEpoch: "7",
      workloadIdentityId: "workload_01", siteReleaseRef: "release_01",
      allowedOrigins: ["https://chat.example.test"],
      quarantineObjectRef: "quarantine/opaque-secret-object",
    });
    expect(issuer.verify(`${capability.credential.slice(0, -1)}x`)).toBeNull();
    await expect(issuer.issue({ ...issuance, bindingEpoch: 0n }))
      .rejects.toThrow("ASSET_CAPABILITY_CLAIMS_INVALID");
    await expect(issuer.issue({ ...issuance, minimumPartBytes: 10_001n }))
      .rejects.toThrow("ASSET_CAPABILITY_CLAIMS_INVALID");
  });

  it("rejects non-canonical origins and origin confusion", async () => {
    expect(() => parseAssetUploadPolicyRegistry({
      ...policyDocument,
      profiles: [{ ...policyDocument.profiles[0], allowedOrigins: ["https://chat.example.test/path"] }],
    })).toThrow("ASSET_POLICY_REGISTRY_INVALID");
    const registry = parseAssetUploadPolicyRegistry(policyDocument);
    expect(registry.allowsOrigin("asset-upload.production", "https://chat.example.test")).toBe(true);
    expect(registry.allowsOrigin("asset-upload.production", "https://chat.example.test.evil.test")).toBe(false);
    expect(registry.allowsOrigin("asset-upload.production", "https://chat.example.test:443")).toBe(false);
  });
});
