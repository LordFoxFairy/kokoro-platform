import { describe, expect, it } from "vitest";
import { ensureUserRequestSchema } from "../../src/interfaces/http/schemas.js";

describe("ensureUserRequestSchema strict + required", () => {
  it("rejects unknown fields", () => {
    expect(() =>
      ensureUserRequestSchema.parse({ externalUserId: "ext-1", bogus: true }),
    ).toThrow();
  });

  it("rejects missing externalUserId", () => {
    expect(() => ensureUserRequestSchema.parse({ email: "a@example.com" })).toThrow();
  });

  it("rejects empty externalUserId", () => {
    expect(() => ensureUserRequestSchema.parse({ externalUserId: "" })).toThrow();
  });

  it("accepts only externalUserId", () => {
    expect(ensureUserRequestSchema.parse({ externalUserId: "ext-1" })).toEqual({
      externalUserId: "ext-1",
    });
  });

  it("accepts full optional payload", () => {
    const input = {
      externalUserId: "ext-1",
      email: "user@example.com",
      displayName: "User",
      avatarUrl: "https://cdn.example.com/a.png",
    };
    expect(ensureUserRequestSchema.parse(input)).toEqual(input);
  });
});

describe("ensureUserRequestSchema optional-field formats", () => {
  it.each(["", "not-an-email", "a@", "@b.com"])("rejects invalid email %j", (email) => {
    expect(() => ensureUserRequestSchema.parse({ externalUserId: "ext-1", email })).toThrow();
  });

  it.each(["", "not-a-url", "example.com"])("rejects invalid avatarUrl %j", (avatarUrl) => {
    expect(() =>
      ensureUserRequestSchema.parse({ externalUserId: "ext-1", avatarUrl }),
    ).toThrow();
  });

  it("rejects empty displayName", () => {
    expect(() =>
      ensureUserRequestSchema.parse({ externalUserId: "ext-1", displayName: "" }),
    ).toThrow();
  });
});
