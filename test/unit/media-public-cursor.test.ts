import { describe, expect, it } from "vitest";
import { HmacMediaPublicCursorCodec } from
  "../../src/modules/media/infrastructure/crypto/media-public-cursor.js";
import type { ResolvedMediaPublicOwnerAuthority } from
  "../../src/modules/media/application/contracts/media-public-read-ports.js";

const owner: ResolvedMediaPublicOwnerAuthority = Object.freeze({
  siteRef: "site-1",
  siteReleaseRef: "release-1",
  siteProjectBindingRef: "binding-1",
  deploymentRef: "deployment-1",
  workloadIdentityRef: "spiffe://kokoro.test/site-1/web",
  workloadBindingEpoch: 2n,
  siteSecurityEpoch: 3n,
  policyEpoch: 4n,
  environment: "production",
  region: "us-east-1",
  audience: "platform-public",
  subjectRef: "subject-1",
  subjectGeneration: 5n,
  identitySessionRef: "session-1",
  identitySessionEpoch: 6n,
  restrictionEpoch: 7n,
  credentialEpoch: 8n,
  projectRef: "project-1",
  membershipEpoch: 9n,
  authorizationEpoch: 10n,
  modelOptionCatalogRef: `site-release-model-catalog:sha256:${"a".repeat(64)}`,
});

describe("HmacMediaPublicCursorCodec", () => {
  it("round-trips an owner and release bound operation cursor", () => {
    const codec = new HmacMediaPublicCursorCodec(Buffer.alloc(32, 7));
    const token = codec.encode({ kind: "operation", owner,
      createdAt: "2026-07-31T12:00:00.000Z", ref: "media-operation:one" });
    const publicPayload = Buffer.from(token.split(".")[0]!, "base64url").toString("utf8");

    expect(codec.decode(token, { kind: "operation", owner })).toEqual({
      kind: "operation",
      createdAt: "2026-07-31T12:00:00.000Z",
      ref: "media-operation:one",
    });
    expect(publicPayload).not.toContain(owner.subjectRef);
    expect(publicPayload).not.toContain(owner.identitySessionRef);
    expect(publicPayload).not.toContain(owner.workloadIdentityRef);
  });

  it("rejects tampering and an authority epoch change", () => {
    const codec = new HmacMediaPublicCursorCodec(Buffer.alloc(32, 7));
    const token = codec.encode({ kind: "definition", owner,
      publishedAt: "2026-07-31T12:00:00.000Z", ref: "image.text_to_image@v1:revision:1" });

    expect(() => codec.decode(`${token.slice(0, -1)}x`, { kind: "definition", owner }))
      .toThrow("MEDIA_PAGE_CURSOR_INVALID");
    expect(() => codec.decode(token, { kind: "definition",
      owner: { ...owner, membershipEpoch: 10n } })).toThrow("MEDIA_PAGE_CURSOR_INVALID");
  });

  it("binds model option cursors to the selected definition", () => {
    const codec = new HmacMediaPublicCursorCodec(Buffer.alloc(32, 7));
    const token = codec.encode({ kind: "model_option", owner,
      definitionRef: "image.text_to_image@v1", position: 3,
      ref: `model-option:sha256:${"b".repeat(64)}` });

    expect(codec.decode(token, { kind: "model_option", owner,
      definitionRef: "image.text_to_image@v1" })).toMatchObject({ position: 3 });
    expect(() => codec.decode(token, { kind: "model_option", owner,
      definitionRef: "another.definition@v1" })).toThrow("MEDIA_PAGE_CURSOR_INVALID");
  });
});
