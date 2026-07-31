import { describe, expect, it } from "vitest";
import {
  parseArtifactDeliveryCapabilityKey,
  parseArtifactOwnerCursorKey,
} from
  "../../src/modules/artifact/infrastructure/config/artifact-delivery-capability-key.js";

describe("Artifact delivery capability key contract", () => {
  it("accepts the one exact production HMAC key document", () => {
    const key = Buffer.alloc(32, 3);
    expect(parseArtifactDeliveryCapabilityKey(JSON.stringify({
      version: 1,
      revision: "artifact-delivery-capability-hmac-sha256-v1",
      keyBase64Url: key.toString("base64url"),
    }))).toEqual(new Uint8Array(key));
  });

  it.each([
    "not-json",
    JSON.stringify({ version: 1, revision: "artifact-delivery-capability-hmac-sha256-v1",
      keyBase64Url: Buffer.alloc(31).toString("base64url") }),
    JSON.stringify({ version: 1, revision: "artifact-delivery-capability-hmac-sha256-v1",
      keyBase64Url: Buffer.alloc(32).toString("base64url"), extra: true }),
  ])("rejects ambiguous or malformed key material", (raw) => {
    expect(() => parseArtifactDeliveryCapabilityKey(raw))
      .toThrow("PLATFORM_ARTIFACT_DELIVERY_CAPABILITY_KEY_FILE_INVALID");
  });

  it("uses a distinct strict document revision for owner cursors", () => {
    const key = Buffer.alloc(32, 9);
    expect(parseArtifactOwnerCursorKey(JSON.stringify({
      version: 1,
      revision: "artifact-owner-cursor-hmac-sha256-v1",
      keyBase64Url: key.toString("base64url"),
    }))).toEqual(new Uint8Array(key));
    expect(() => parseArtifactOwnerCursorKey(JSON.stringify({
      version: 1,
      revision: "artifact-delivery-capability-hmac-sha256-v1",
      keyBase64Url: key.toString("base64url"),
    }))).toThrow("PLATFORM_ARTIFACT_OWNER_CURSOR_KEY_FILE_INVALID");
  });
});
