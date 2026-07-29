import { describe, expect, it } from "vitest";
import {
  beginUploadCompletion,
  createUploadIntent,
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
  it("freezes Site, subject generation, Project, purpose, checksum, policy and quarantine object", () => {
    const value = createUploadIntent({
      intentRef: "upload_intent_01", sessionRef: "upload_session_01", siteRef: "site_01",
      subjectRef: "subject_01", subjectGeneration: 4n, projectRef: "project_01",
      purpose: "chat.attachment", filename: "../photo.png\r\n", clientMediaType: "IMAGE/PNG",
      expectedSize: 1234n, expectedChecksumSha256: "a".repeat(64),
      quarantineObjectRef: "quarantine/site_01/opaque_0123456789",
      policy, now: "2026-07-28T12:00:00.000Z",
    });
    expect(value).toMatchObject({ siteRef: "site_01", subjectGeneration: 4n, projectRef: "project_01",
      purpose: "chat.attachment", safeDisplayName: "photo.png", clientMediaType: "image/png",
      state: "awaiting_capability", expectedVersion: 1n });
    expect(value.quarantineObjectRef).not.toContain("photo.png");
  });

  it("fails closed on policy, type, byte ceiling, expiry, and completion CAS mismatches", () => {
    const base = {
      intentRef: "upload_intent_01", sessionRef: "upload_session_01", siteRef: "site_01",
      subjectRef: "subject_01", subjectGeneration: 4n, projectRef: "project_01",
      purpose: "chat.attachment", filename: "photo.png", clientMediaType: "image/png",
      expectedSize: 1234n, expectedChecksumSha256: "a".repeat(64),
      quarantineObjectRef: "quarantine/site_01/opaque_0123456789", policy,
      now: "2026-07-28T12:00:00.000Z",
    } as const;
    expect(() => createUploadIntent({ ...base, purpose: "music.reference" })).toThrow("ASSET_POLICY_PURPOSE_MISMATCH");
    expect(() => createUploadIntent({ ...base, clientMediaType: "text/html" })).toThrow("ASSET_MEDIA_TYPE_NOT_ALLOWED");
    expect(() => createUploadIntent({ ...base, expectedSize: 10_000_001n })).toThrow("ASSET_UPLOAD_SIZE_NOT_ALLOWED");
    expect(() => createUploadIntent({ ...base, now: policy.expiresAt })).toThrow("ASSET_POLICY_EXPIRED");
    const uploading = markUploadCapabilityIssued(createUploadIntent(base));
    expect(() => beginUploadCompletion(uploading, 1n)).toThrow("ASSET_UPLOAD_COMPLETION_CONFLICT");
    expect(beginUploadCompletion(uploading, 2n)).toMatchObject({ state: "completing", expectedVersion: 3n });
  });

  it("never treats a display name as an object key or lets bidi/control characters survive", () => {
    const value = createUploadIntent({
      intentRef: "upload_intent_02", sessionRef: "upload_session_02", siteRef: "site_01",
      subjectRef: "subject_01", subjectGeneration: 4n, projectRef: "project_01",
      purpose: "chat.attachment", filename: "../../invoice\u202egnp.exe\u0000\r\n", clientMediaType: "image/png",
      expectedSize: 1234n, expectedChecksumSha256: "b".repeat(64),
      quarantineObjectRef: "quarantine/site_01/opaque_9876543210",
      policy, now: "2026-07-28T12:00:00.000Z",
    });
    expect(value.safeDisplayName).toBe("invoicegnp.exe");
    expect(value.quarantineObjectRef).not.toContain(value.safeDisplayName);
    expect(value.safeDisplayName.length).toBeLessThanOrEqual(255);
  });
});
