import { describe, expect, it } from "vitest";
import { createImageEffectOutputTokenAuthority } from
  "../../src/modules/model-gateway/infrastructure/crypto/image-effect-output-token.js";
import { createModelGatewayResponseProtector } from
  "../../src/modules/model-gateway/infrastructure/crypto/response-protector.js";
import type { ImageEffectOutputAccessClaims } from
  "../../src/modules/model-gateway/application/image-effect-output-service.js";

const CLAIMS: ImageEffectOutputAccessClaims = Object.freeze({
  capabilityRef: "capability:one",
  siteId: "site:one",
  callerIdentity: "platform-media-worker:one",
  audience: "platform-media-worker",
  logicalInvocationRef: "invocation:one",
  outputEvidenceRef: "output:one",
  outputEvidenceDigest: "a".repeat(64),
  maxReadableBytes: 4096n,
  expiresAt: "2030-01-01T00:00:00.000Z",
  securityEpoch: 7n,
});

describe("image-effect output token authority", () => {
  it("issues an opaque sealed capability and persists only a separately sealed recovery envelope", () => {
    const authority = tokenAuthority();
    const issued = authority.issue(CLAIMS);
    expect(issued.sourceAccessHandle).toMatch(/^kimg1\.[A-Za-z0-9_-]+$/u);
    expect(issued.sourceAccessHandle).not.toContain("output:one");
    expect(issued.recoveryEnvelope.ciphertext).not.toContain(issued.sourceAccessHandle);
    expect(authority.verify(issued.sourceAccessHandle)).toEqual(CLAIMS);
    expect(authority.recover(issued.recoveryEnvelope, CLAIMS)).toBe(issued.sourceAccessHandle);
  });

  it("rejects token, routing and recovery-envelope tampering", () => {
    const authority = tokenAuthority();
    const issued = authority.issue(CLAIMS);
    const last = issued.sourceAccessHandle.at(-1) === "A" ? "B" : "A";
    expect(() => authority.verify(`${issued.sourceAccessHandle.slice(0, -1)}${last}`)).toThrow();
    expect(() => authority.recover({ ...issued.recoveryEnvelope,
      authenticationTag: `${issued.recoveryEnvelope.authenticationTag.slice(0, -1)}A` }, CLAIMS)).toThrow();
  });
});

function tokenAuthority() {
  return createImageEffectOutputTokenAuthority(createModelGatewayResponseProtector({
    currentKeyRevision: "test-v1",
    keys: [{ keyRevision: "test-v1", key: new Uint8Array(32).fill(7) }],
  }));
}
