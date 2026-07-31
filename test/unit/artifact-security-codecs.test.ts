import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ArtifactDeliveryCapabilityCodec } from
  "../../src/modules/artifact/infrastructure/crypto/artifact-delivery-capability.js";
import { HmacArtifactOwnerCursorCodec } from
  "../../src/modules/artifact/infrastructure/crypto/artifact-owner-cursor.js";

describe("Artifact security codecs", () => {
  it("owns the delivery bearer format in one issuer/verifier", () => {
    const codec = new ArtifactDeliveryCapabilityCodec(Buffer.alloc(32, 1),
      () => Buffer.alloc(32, 2));
    const issued = codec.issue();

    expect(issued.deliveryCapability).toMatch(/^artdel_v1\.[A-Za-z0-9_-]{43}\.[a-f0-9]{64}$/u);
    expect(codec.verify(issued.deliveryCapability)).toBe(issued.capabilityDigest);
    expect(() => codec.verify(`${issued.deliveryCapability.slice(0, -1)}0`))
      .toThrow("ARTIFACT_DELIVERY_CAPABILITY_INVALID");
  });

  it("binds cursor payloads to an independent purpose-separated authority", () => {
    const cursorKey = Buffer.alloc(32, 4);
    const codec = new HmacArtifactOwnerCursorCodec(cursorKey);
    const token = codec.encode({ kind: "artifact", site_ref: "site_01", ref: "artifact_01" });

    expect(codec.decode(token)).toEqual({ kind: "artifact", site_ref: "site_01", ref: "artifact_01" });
    expect(() => new HmacArtifactOwnerCursorCodec(Buffer.alloc(32, 5)).decode(token))
      .toThrow("PAGE_CURSOR_INVALID");
    expect(() => codec.encode({ "Invalid-Key": "value" })).toThrow("PAGE_CURSOR_INVALID");

    const nonCanonicalPayload = Buffer.from(
      '{"v":1,"kind":"artifact","kind":"version"}', "utf8").toString("base64url");
    const signature = createHmac("sha256", cursorKey)
      .update("kokoro.platform.artifact-owner-cursor.v1\0").update(nonCanonicalPayload)
      .digest("base64url");
    expect(() => codec.decode(`${nonCanonicalPayload}.${signature}`)).toThrow("PAGE_CURSOR_INVALID");
  });
});
