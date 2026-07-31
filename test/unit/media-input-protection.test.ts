import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EnvelopeOperationInputProtector,
  deriveMediaOwnerRequestDigest,
  type MediaOperationOwnerBinding,
} from "../../src/modules/media/application/operation-input-protection.js";

const binding: MediaOperationOwnerBinding = Object.freeze({
  siteRef: "site:one",
  subjectRef: "subject:one",
  subjectGeneration: 3n,
  projectRef: "project:one",
  workloadRef: "workload:studio",
  source: "direct_studio",
  definitionRevisionRef: "image.text_to_image@v1/revision:1",
  modelOptionRevisionRef: "image-option:revision:1",
  authority: Object.freeze({ siteReleaseRef: "release:one", siteSecurityEpoch: 7n,
    policyEpoch: 11n, workloadBindingEpoch: 3n, identitySessionRef: "identity-session:one",
    identitySessionEpoch: 5n, restrictionEpoch: 13n, membershipEpoch: 17n,
    authorizationEpoch: 19n }),
});

describe("Media OperationInputRevision protection", () => {
  it("envelope-encrypts bounded canonical bytes and binds decryption to owner AAD", () => {
    const protector = new EnvelopeOperationInputProtector({
      activeKey: { keyRevisionRef: "media-kek:revision:1", key: randomBytes(32) },
    });
    const plaintext = new TextEncoder().encode("draw a fox beneath a red moon");
    const protectedInput = protector.protect({
      operationInputRevisionRef: "media-input:1",
      ownerBinding: binding,
      canonicalBytes: plaintext,
    });

    expect(JSON.stringify(protectedInput)).not.toContain("draw a fox");
    expect(protectedInput.encryptionAlgorithm).toBe("AES-256-GCM-envelope-v1");
    expect(protector.open({ protectedInput, ownerBinding: binding })).toEqual(plaintext);
    expect(() => protector.open({
      protectedInput,
      ownerBinding: { ...binding, projectRef: "project:other" },
    })).toThrow("MEDIA_INPUT_AUTHENTICATION_FAILED");
  });

  it("rejects empty or over-limit plaintext before allocating ciphertext", () => {
    const protector = new EnvelopeOperationInputProtector({
      activeKey: { keyRevisionRef: "media-kek:revision:1", key: randomBytes(32) },
      maximumPlaintextBytes: 16,
    });
    const protect = (canonicalBytes: Uint8Array) => protector.protect({
      operationInputRevisionRef: "media-input:1",
      ownerBinding: binding,
      canonicalBytes,
    });

    expect(() => protect(new Uint8Array())).toThrow("MEDIA_INPUT_EMPTY");
    expect(() => protect(new Uint8Array(17))).toThrow("MEDIA_INPUT_TOO_LARGE");
  });

  it("keeps the caller fingerprint separate from the owner keyed digest", () => {
    const canonicalBytes = new TextEncoder().encode("canonical-request");
    const ownerDigestKey = randomBytes(32);
    const first = deriveMediaOwnerRequestDigest({
      ownerDigestKey,
      canonicalBytes,
      ownerBinding: binding,
    });
    const stable = deriveMediaOwnerRequestDigest({
      ownerDigestKey,
      canonicalBytes,
      ownerBinding: binding,
    });
    const otherProject = deriveMediaOwnerRequestDigest({
      ownerDigestKey,
      canonicalBytes,
      ownerBinding: { ...binding, projectRef: "project:other" },
    });

    expect(stable.ownerRequestDigest).toBe(first.ownerRequestDigest);
    expect(otherProject.ownerRequestDigest).not.toBe(first.ownerRequestDigest);
    expect(first.ownerRequestDigest).toMatch(/^[0-9a-f]{64}$/u);
  });
});
