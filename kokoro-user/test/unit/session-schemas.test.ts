import { describe, expect, it } from "vitest";
import {
  assertRuntimeNamespace,
  FORBIDDEN_NAMESPACE_PREFIXES,
  InvalidRuntimeNamespaceError,
} from "../../src/domain/session.js";
import { issueSessionRequestSchema } from "../../src/interfaces/http/schemas.js";

describe("issueSessionRequestSchema strict + required", () => {
  it("accepts the minimal required payload", () => {
    expect(
      issueSessionRequestSchema.parse({ site_id: "site-a", external_user_id: "auth0|abc" }),
    ).toEqual({ site_id: "site-a", external_user_id: "auth0|abc" });
  });

  it("lowercases and trims email", () => {
    expect(
      issueSessionRequestSchema.parse({
        site_id: "site-a",
        external_user_id: "auth0|abc",
        email: "  USER@Example.COM ",
      }),
    ).toEqual({ site_id: "site-a", external_user_id: "auth0|abc", email: "user@example.com" });
  });

  it.each([
    { site_id: "", external_user_id: "x" },
    { site_id: "site-a" },
    { external_user_id: "x" },
    { site_id: "site-a", external_user_id: "" },
    { site_id: "site-a", external_user_id: "x", bogus: true },
    { site_id: "site-a", external_user_id: "x", email: "not-an-email" },
  ])("rejects invalid payload %j", (payload) => {
    expect(() => issueSessionRequestSchema.parse(payload)).toThrow();
  });
});

describe("assertRuntimeNamespace", () => {
  it("accepts opaque cuid-like ids", () => {
    expect(() => assertRuntimeNamespace("clabc123def456")).not.toThrow();
  });

  it.each(FORBIDDEN_NAMESPACE_PREFIXES)("rejects the %s prefix", (prefix) => {
    expect(() => assertRuntimeNamespace(`${prefix}leak`)).toThrow(InvalidRuntimeNamespaceError);
  });
});
