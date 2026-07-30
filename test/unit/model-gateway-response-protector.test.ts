import { describe, expect, it } from "vitest";
import { createModelGatewayResponseProtector } from
  "../../src/modules/model-gateway/infrastructure/crypto/response-protector.js";

const binding = {
  siteId: "site-a",
  invocationRef: "invocation-a",
  requestDigest: "a".repeat(64),
};

describe("Model Gateway response protector", () => {
  it("round-trips provider bytes while binding ciphertext to invocation identity", () => {
    const protector = createModelGatewayResponseProtector({
      currentKeyRevision: "revision-1",
      keys: [{ keyRevision: "revision-1", key: new Uint8Array(32).fill(7) }],
    });
    const plaintext = new TextEncoder().encode('{"private":"provider response"}');
    const envelope = protector.seal(plaintext, binding);

    expect(JSON.stringify(envelope)).not.toContain("provider response");
    expect(protector.unseal(envelope, binding)).toEqual(plaintext);
    expect(() => protector.unseal(envelope, { ...binding, invocationRef: "other" }))
      .toThrowError();
  });

  it("fails closed on malformed key rings and oversized payloads", () => {
    expect(() => createModelGatewayResponseProtector({
      currentKeyRevision: "missing",
      keys: [{ keyRevision: "revision-1", key: new Uint8Array(32) }],
    })).toThrowError("MODEL_GATEWAY_RESPONSE_KEY_RING_INVALID");

    const protector = createModelGatewayResponseProtector({
      currentKeyRevision: "revision-1",
      keys: [{ keyRevision: "revision-1", key: new Uint8Array(32) }],
    });
    expect(() => protector.seal(new Uint8Array(8 * 1024 * 1024 + 1), binding))
      .toThrowError("MODEL_GATEWAY_RESPONSE_PLAINTEXT_INVALID");
  });
});
