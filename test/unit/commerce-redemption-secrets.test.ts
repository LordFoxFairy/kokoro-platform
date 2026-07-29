import { describe, expect, it } from "vitest";
import { createRedemptionSecretCodec } from "../../src/modules/commerce/infrastructure/crypto/redemption-secret-codec.js";
import { RedemptionInputError } from "../../src/modules/commerce/domain/redemption-input-error.js";

describe("Commerce redemption secret codec", () => {
  const codec = createRedemptionSecretCodec({
    currentCodeLookupKeyRevision: "code-2026-07",
    codeLookupKeys: [
      { keyRevision: "code-2026-06", key: Buffer.alloc(32, 4) },
      { keyRevision: "code-2026-07", key: Buffer.alloc(32, 1) },
    ],
    currentPreviewCredentialKeyRevision: "preview-2026-07",
    previewCredentialKeys: [
      { keyRevision: "preview-2026-06", key: Buffer.alloc(32, 5) },
      { keyRevision: "preview-2026-07", key: Buffer.alloc(32, 2) },
    ],
    requestAuditKey: Buffer.alloc(32, 3),
  });

  it("issues a high-entropy selector/checksum/batch-bound code and resolves exactly one key", () => {
    const issued = codec.issueCode("site-1", "00000000-0000-7000-8000-000000000111");
    expect(issued.code).toMatch(/^KC1-[0-9A-HJKMNP-TV-Z]{8}-[0-9A-HJKMNP-TV-Z]{10}-[0-9A-HJKMNP-TV-Z]{32}-[0-9A-HJKMNP-TV-Z]{8}$/u);
    expect(codec.codeLookupCandidates(issued.code.toLowerCase(), "site-1")).toEqual([{
      keyRevision: "code-2026-07", batchSelector: issued.batchSelector, lookupDigest: issued.lookupDigest,
    }]);
    expect(codec.codeLookupCandidates(issued.code, "site-2")[0]?.lookupDigest).not.toBe(issued.lookupDigest);
    expect(codec.safeCodeFingerprint(issued.code, "site-1")).toBe(issued.safeFingerprint);
    const tampered = `${issued.code.slice(0, -1)}${issued.code.endsWith("0") ? "1" : "0"}`;
    expect(() => codec.codeLookupCandidates(tampered, "site-1")).toThrow(RedemptionInputError);
  });

  it("issues a deterministic opaque preview capability and verifies key rotation", () => {
    const credential = codec.previewCredential("00000000-0000-7000-8000-000000000001");
    expect(credential).toMatch(/^kpv1\.[A-Za-z0-9_-]+\.[0-9a-f-]+\.[A-Za-z0-9_-]{43}$/u);
    expect(codec.verifyPreviewCredential(credential)).toEqual({
      keyRevision: "preview-2026-07",
      previewRef: "00000000-0000-7000-8000-000000000001",
      credentialDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(codec.verifyPreviewCredential(`${credential}x`)).toBeNull();

    const oldCodec = createRedemptionSecretCodec({
      currentCodeLookupKeyRevision: "code-2026-06",
      codeLookupKeys: [{ keyRevision: "code-2026-06", key: Buffer.alloc(32, 4) }],
      currentPreviewCredentialKeyRevision: "preview-2026-06",
      previewCredentialKeys: [{ keyRevision: "preview-2026-06", key: Buffer.alloc(32, 5) }],
      requestAuditKey: Buffer.alloc(32, 3),
    });
    const oldCredential = oldCodec.previewCredential("00000000-0000-7000-8000-000000000001");
    expect(codec.verifyPreviewCredential(oldCredential)?.keyRevision).toBe("preview-2026-06");
    expect(codec.previewCredential("00000000-0000-7000-8000-000000000001", "preview-2026-06"))
      .toBe(oldCredential);
    expect(() => codec.previewCredential("00000000-0000-7000-8000-000000000001", "preview-retired"))
      .toThrow("REDEMPTION_PREVIEW_KEY_RETIRED");
  });

  it("uses a separate keyed domain for durable request audit digests", () => {
    const issued = codec.issueCode("site-1", "00000000-0000-7000-8000-000000000111");
    const lookup = codec.codeLookupCandidates(issued.code, "site-1")[0]!;
    const audit = codec.previewRequestDigest({
      siteId: "site-1", subjectId: "subject-1", subjectGeneration: "2", code: issued.code,
    });
    expect(audit).toMatch(/^[a-f0-9]{64}$/u);
    expect(audit).not.toBe(lookup.lookupDigest);
  });

  it("uses a typed boundary error for malformed Code input", () => {
    expect(() => codec.previewRequestDigest({
      siteId: "site-1", subjectId: "subject-1", subjectGeneration: "2", code: "----------------",
    })).toThrow(RedemptionInputError);
  });

  it("binds confirm audit identity to Site, subject generation, capability and canonical legal set", () => {
    const input = { siteId: "site-1", subjectId: "subject-1", subjectGeneration: "2",
      previewCredential: codec.previewCredential("00000000-0000-7000-8000-000000000001"),
      legalAcceptanceRefs: ["terms-b", "terms-a"] };
    const digest = codec.confirmRequestDigest(input);
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(codec.confirmRequestDigest({ ...input, legalAcceptanceRefs: ["terms-a", "terms-b"] })).toBe(digest);
    expect(codec.confirmRequestDigest({ ...input, siteId: "site-2" })).not.toBe(digest);
    expect(codec.confirmRequestDigest({ ...input, subjectGeneration: "3" })).not.toBe(digest);
  });
});
