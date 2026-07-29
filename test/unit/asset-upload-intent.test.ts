import { describe, expect, it } from "vitest";
import {
  beginUploadCompletion,
  createUploadIntent,
  createUploadSession,
  markUploadCapabilityIssued,
} from "../../src/modules/asset/domain/upload-intent.js";

const policy = Object.freeze({
  policyRevisionRef: "asset_policy_01",
  purpose: "chat.attachment",
  storageRegion: "us-east-1",
  maximumFileBytes: 10_000_000n,
  maximumInflightBytes: 100_000_000n,
  allowedClientMediaTypes: Object.freeze(["image/png", "text/plain"]),
  expiresAt: "2026-07-29T12:00:00.000Z",
});

describe("Asset upload intent", () => {
  it("freezes Site authority, subject generation, Project, purpose, checksum and policy", () => {
    const value = createUploadIntent({
      intentRef: "upload_intent_01", siteRef: "site_01",
      workloadIdentityId: "workload_01", siteReleaseRef: "release_01", bindingEpoch: 7n,
      subjectRef: "subject_01", subjectGeneration: 4n, projectRef: "project_01",
      purpose: "chat.attachment", filename: "../photo.png\r\n", clientMediaType: "IMAGE/PNG",
      expectedSize: 1234n, expectedChecksumSha256: "a".repeat(64),
      policy, now: "2026-07-28T12:00:00.000Z",
    });
    expect(value).toMatchObject({ siteRef: "site_01", subjectGeneration: 4n, projectRef: "project_01",
      purpose: "chat.attachment", safeDisplayName: "photo.png", clientMediaType: "image/png",
      state: "admitted", expectedVersion: 1n });
  });

  it("fails closed on policy, type, byte ceiling, expiry, and completion CAS mismatches", () => {
    const base = {
      intentRef: "upload_intent_01", siteRef: "site_01",
      workloadIdentityId: "workload_01", siteReleaseRef: "release_01", bindingEpoch: 7n,
      subjectRef: "subject_01", subjectGeneration: 4n, projectRef: "project_01",
      purpose: "chat.attachment", filename: "photo.png", clientMediaType: "image/png",
      expectedSize: 1234n, expectedChecksumSha256: "a".repeat(64),
      policy,
      now: "2026-07-28T12:00:00.000Z",
    } as const;
    expect(() => createUploadIntent({ ...base, purpose: "music.reference" })).toThrow("ASSET_POLICY_PURPOSE_MISMATCH");
    expect(() => createUploadIntent({ ...base, clientMediaType: "text/html" })).toThrow("ASSET_MEDIA_TYPE_NOT_ALLOWED");
    expect(() => createUploadIntent({ ...base, expectedSize: 10_000_001n })).toThrow("ASSET_UPLOAD_SIZE_NOT_ALLOWED");
    expect(() => createUploadIntent({ ...base, now: policy.expiresAt })).toThrow("ASSET_POLICY_EXPIRED");
    const intent = createUploadIntent(base);
    const session = createUploadSession({ sessionRef: "upload_session_01", intent,
      quotaRevisionRef: "quota_revision_01", storageTenantRef: "storage_tenant_01",
      storageRegion: "us-east-1", quarantineObjectRef: "quarantine/site_01/opaque_0123456789",
      capabilityAudience: "https://upload.example.test", minimumPartBytes: 100n,
      maximumPartBytes: 10_000_000n, capabilityLifetimeSeconds: 300 });
    const uploading = markUploadCapabilityIssued(session, 1n, 1n, "2026-07-28T12:05:00.000Z");
    expect(() => beginUploadCompletion(uploading, 1n)).toThrow("ASSET_UPLOAD_COMPLETION_CONFLICT");
    expect(beginUploadCompletion(uploading, 2n)).toMatchObject({ state: "completing", expectedVersion: 3n });
  });

  it("never treats a display name as an object key or lets bidi/control characters survive", () => {
    const value = createUploadIntent({
      intentRef: "upload_intent_02", siteRef: "site_01",
      workloadIdentityId: "workload_01", siteReleaseRef: "release_01", bindingEpoch: 7n,
      subjectRef: "subject_01", subjectGeneration: 4n, projectRef: "project_01",
      purpose: "chat.attachment", filename: "../../invoice\u202egnp.exe\u0000\r\n", clientMediaType: "image/png",
      expectedSize: 1234n, expectedChecksumSha256: "b".repeat(64),
      policy, now: "2026-07-28T12:00:00.000Z",
    });
    expect(value.safeDisplayName).toBe("invoicegnp.exe");
    expect(value.safeDisplayName.length).toBeLessThanOrEqual(255);
  });
});
