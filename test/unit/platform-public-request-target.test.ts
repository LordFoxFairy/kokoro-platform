import { describe, expect, it } from "vitest";
import { parsePlatformPublicRequestTarget } from "../../src/interfaces/http/platform-public.js";

describe("Platform public relative request target", () => {
  it("parses a bounded relative target with WHATWG query semantics", () => {
    expect(parsePlatformPublicRequestTarget("/v1/identity/sessions?cursor=a%2Fb&limit=20")).toEqual({
      pathname: "/v1/identity/sessions",
      query: { cursor: "a/b", limit: "20" },
    });
  });

  it.each([
    "https://attacker.example/v1/identity/sessions",
    "//attacker.example/v1/identity/sessions",
    "/v1/identity/sessions?cursor=one&cursor=two",
    "/v1/identity/sessions#fragment",
    `/v1/identity/sessions?${"x".repeat(8_200)}`,
  ])("rejects ambiguous or oversized target %s", (target) => {
    expect(() => parsePlatformPublicRequestTarget(target)).toThrow("PLATFORM_PUBLIC_REQUEST_TARGET_INVALID");
  });
});
