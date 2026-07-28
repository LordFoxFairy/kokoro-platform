import { describe, expect, it } from "vitest";
import { registerMcpServerBodySchema } from "../../src/interfaces/http/mcp-schemas.js";

const validBody = {
  scope: "ns-a",
  name: "github",
  transport: "streamable_http",
  url: "https://mcp.example/github",
  allowed_tools: ["search_issues"],
  secret_ref: "env:GH_MCP_TOKEN",
};

describe("registerMcpServerBodySchema", () => {
  it("accepts a well-formed registration body", () => {
    const parsed = registerMcpServerBodySchema.parse(validBody);
    expect(parsed.transport).toBe("streamable_http");
    expect(parsed.secret_ref).toBe("env:GH_MCP_TOKEN");
  });

  it("accepts an absent or null secret_ref (no credential)", () => {
    const { secret_ref: _dropped, ...withoutRef } = validBody;
    expect(registerMcpServerBodySchema.parse(withoutRef).secret_ref).toBeUndefined();
    expect(registerMcpServerBodySchema.parse({ ...validBody, secret_ref: null }).secret_ref).toBeNull();
  });

  it("accepts an empty allowed_tools list (no restriction)", () => {
    expect(registerMcpServerBodySchema.parse({ ...validBody, allowed_tools: [] }).allowed_tools).toEqual([]);
  });

  it("leaves string secret-ref legality to the admission layer", () => {
    for (const value of ["env:GH_MCP_TOKEN", "secret:legacy/path", "plaintext", ""]) {
      expect(
        registerMcpServerBodySchema.safeParse({ ...validBody, secret_ref: value }).success,
        `secret_ref '${value}' must reach admission`,
      ).toBe(true);
    }
  });

  it("still rejects a non-string secret_ref as an invalid request shape", () => {
    expect(registerMcpServerBodySchema.safeParse({ ...validBody, secret_ref: 42 }).success).toBe(false);
  });

  it("leaves URL string legality to the admission layer", () => {
    for (const url of [
      "not-a-url",
      "ftp://mcp.example/github",
      "file:///etc/passwd",
      "https://user:example-password@mcp.example/github",
    ]) {
      expect(
        registerMcpServerBodySchema.safeParse({ ...validBody, url }).success,
        `url '${url}' must reach admission`,
      ).toBe(true);
    }
  });

  it("still rejects a missing or non-string url as an invalid request shape", () => {
    const { url: _url, ...withoutUrl } = validBody;
    expect(registerMcpServerBodySchema.safeParse(withoutUrl).success).toBe(false);
    expect(registerMcpServerBodySchema.safeParse({ ...validBody, url: 42 }).success).toBe(false);
  });

  it("rejects an unknown transport", () => {
    expect(registerMcpServerBodySchema.safeParse({ ...validBody, transport: "websocket" }).success).toBe(false);
  });

  it("rejects a bad server name and unknown fields (strict)", () => {
    expect(registerMcpServerBodySchema.safeParse({ ...validBody, name: "Bad_Name" }).success).toBe(false);
    expect(registerMcpServerBodySchema.safeParse({ ...validBody, headers: { a: "b" } }).success).toBe(false);
  });
});
