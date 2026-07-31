import { describe, expect, it } from "vitest";
import { createImageEffectSecretProtector } from
  "../../src/modules/model-gateway/infrastructure/crypto/image-effect-secret-protector.js";
import { createModelGatewayResponseProtector } from
  "../../src/modules/model-gateway/infrastructure/crypto/response-protector.js";

const KEY = new Uint8Array(32).fill(7);
const CONTEXT = Object.freeze({
  siteId: "site:one",
  logicalInvocationRef: "invocation:one",
  purpose: "source-grants" as const,
  bindingRef: "input:one",
});

describe("image-effect secret protector", () => {
  it("round trips secrets while binding Site, invocation, purpose and exact evidence", () => {
    const protector = createImageEffectSecretProtector(createModelGatewayResponseProtector({
      currentKeyRevision: "image-v1",
      keys: [{ keyRevision: "image-v1", key: KEY }],
    }));
    const plaintext = new TextEncoder().encode("a purpose-scoped secret value");
    const envelope = protector.seal(plaintext, CONTEXT);
    expect(protector.unseal(envelope, CONTEXT)).toEqual(plaintext);
    expect(() => protector.unseal(envelope, { ...CONTEXT, bindingRef: "input:two" })).toThrow();
    expect(() => protector.unseal(envelope, { ...CONTEXT, logicalInvocationRef: "invocation:two" })).toThrow();
  });
});
