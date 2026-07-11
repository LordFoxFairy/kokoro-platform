import { describe, expect, it } from "vitest";
import {
  MCP_SECRET_REF_RE,
  registerMcpServerBodySchema,
} from "../../src/interfaces/http/mcp-schemas.js";

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

  it("rejects plaintext credential shapes in secret_ref", () => {
    for (const plaintext of [
      "example-token-value",
      "Bearer example-token",
      "env GH_MCP_TOKEN",
      "ENV:GH_MCP_TOKEN",
      "",
    ]) {
      expect(
        registerMcpServerBodySchema.safeParse({ ...validBody, secret_ref: plaintext }).success,
        `secret_ref '${plaintext}' must be rejected`,
      ).toBe(false);
    }
  });

  it("accepts both env: and secret: reference shapes", () => {
    expect(MCP_SECRET_REF_RE.test("env:GH_MCP_TOKEN")).toBe(true);
    expect(MCP_SECRET_REF_RE.test("secret:mcp/github-token")).toBe(true);
  });

  it("rejects malformed, non-http, and credential-embedding urls", () => {
    for (const url of [
      "not-a-url",
      "ftp://mcp.example/github",
      "file:///etc/passwd",
      "https://user:example-password@mcp.example/github",
    ]) {
      expect(
        registerMcpServerBodySchema.safeParse({ ...validBody, url }).success,
        `url '${url}' must be rejected`,
      ).toBe(false);
    }
  });

  it("rejects an unknown transport", () => {
    expect(registerMcpServerBodySchema.safeParse({ ...validBody, transport: "websocket" }).success).toBe(false);
  });

  it("rejects a bad server name and unknown fields (strict)", () => {
    expect(registerMcpServerBodySchema.safeParse({ ...validBody, name: "Bad_Name" }).success).toBe(false);
    expect(registerMcpServerBodySchema.safeParse({ ...validBody, headers: { a: "b" } }).success).toBe(false);
  });
});
