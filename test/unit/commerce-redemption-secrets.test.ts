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

  it("normalizes user formatting and returns only keyed lookup candidates", () => {
    expect(codec.codeLookupCandidates("abcd-efgh-ijkl-mnop", "site-1")).toEqual(
      codec.codeLookupCandidates("ABCDEFGHIJKLMNOP", "site-1"),
    );
    expect(codec.codeLookupCandidates("ABCDEFGHIJKLMNOP", "site-2")).not.toEqual(
      codec.codeLookupCandidates("ABCDEFGHIJKLMNOP", "site-1"),
    );
    expect(codec.codeLookupCandidates("ABCDEFGHIJKLMNOP", "site-1").map((item) => item.keyRevision))
      .toEqual(["code-2026-07", "code-2026-06"]);
    expect(codec.safeCodeFingerprint("abcd-efgh-ijkl-mnop", "site-1")).toMatch(/^CODE-[A-F0-9]{16}$/u);
    expect(codec.safeCodeFingerprint("abcd-efgh-ijkl-mnop", "site-1")).not.toContain("ABCD");
    expect(codec.safeCodeFingerprint("abcd-efgh-ijkl-mnop", "site-1")).not.toContain("MNOP");
    expect(codec.safeCodeFingerprint("abcd-efgh-ijkl-mnop", "site-1"))
      .not.toBe(codec.safeCodeFingerprint("abcd-efgh-ijkl-mnop", "site-2"));
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
    const lookup = codec.codeLookupCandidates("ABCDEFGHIJKLMNOP", "site-1")[0]!;
    const audit = codec.previewRequestDigest({
      siteId: "site-1", subjectId: "subject-1", subjectGeneration: "2", code: "ABCDEFGHIJKLMNOP",
    });
    expect(audit).toMatch(/^[a-f0-9]{64}$/u);
    expect(audit).not.toBe(lookup.lookupDigest);
  });

  it("uses a typed boundary error for malformed Code input", () => {
    expect(() => codec.previewRequestDigest({
      siteId: "site-1", subjectId: "subject-1", subjectGeneration: "2", code: "----------------",
    })).toThrow(RedemptionInputError);
  });
});
