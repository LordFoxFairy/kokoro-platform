import { describe, expect, it } from "vitest";
import { generateSecretHandle } from "../../src/domain/secret-handle.js";
import {
  isEnvRefAllowed,
  parseEnvRefAllowlist,
  parseSecretRef,
  SELF_SECRET_REF_RE,
  selfRegisterMcpServerBodySchema,
} from "../../src/interfaces/http/mcp-server-ref.js";

const handleRef = `handle:${generateSecretHandle()}`;

describe("parseSecretRef", () => {
  it("recognizes handle: and env: shapes", () => {
    expect(parseSecretRef(handleRef).kind).toBe("handle");
    const env = parseSecretRef("env:GH_MCP_TOKEN");
    expect(env).toEqual({ kind: "env", varName: "GH_MCP_TOKEN" });
  });

  it("rejects the retired secret:path, plaintext, and malformed refs as invalid", () => {
    for (const ref of ["secret:mcp/github", "example-plaintext", "env:lowercase", "handle:srt_short", "ENV:X", ""]) {
      expect(parseSecretRef(ref).kind, `'${ref}'`).toBe("invalid");
    }
  });
});

describe("env ref allowlist", () => {
  it("parses a comma-separated allowlist, trimming and dropping empties", () => {
    const set = parseEnvRefAllowlist(" GH_MCP_TOKEN , ,SLACK_MCP_TOKEN ");
    expect([...set].sort()).toEqual(["GH_MCP_TOKEN", "SLACK_MCP_TOKEN"]);
  });

  it("treats an absent allowlist as an empty set (everything rejected)", () => {
    const set = parseEnvRefAllowlist(undefined);
    expect(isEnvRefAllowed("GH_MCP_TOKEN", set)).toBe(false);
  });

  it("admits only vars present in the allowlist", () => {
    const set = parseEnvRefAllowlist("GH_MCP_TOKEN");
    expect(isEnvRefAllowed("GH_MCP_TOKEN", set)).toBe(true);
    expect(isEnvRefAllowed("OTHER_TOKEN", set)).toBe(false);
  });
});

describe("SELF_SECRET_REF_RE", () => {
  it("matches only handle: refs, never env:/secret:/plaintext", () => {
    expect(SELF_SECRET_REF_RE.test(handleRef)).toBe(true);
    for (const ref of ["env:GH_MCP_TOKEN", "secret:mcp/x", "example-plaintext", "handle:srt_short"]) {
      expect(SELF_SECRET_REF_RE.test(ref), `'${ref}'`).toBe(false);
    }
  });
});

describe("selfRegisterMcpServerBodySchema (门后生效)", () => {
  const base = {
    name: "github",
    transport: "streamable_http" as const,
    url: "https://mcp.example/github",
    allowed_tools: ["search_issues"],
  };

  it("accepts an https url with a handle: secret_ref (or none)", () => {
    expect(selfRegisterMcpServerBodySchema.parse({ ...base, secret_ref: handleRef }).secret_ref).toBe(handleRef);
    expect(selfRegisterMcpServerBodySchema.parse(base).secret_ref).toBeUndefined();
    expect(selfRegisterMcpServerBodySchema.parse({ ...base, secret_ref: null }).secret_ref).toBeNull();
  });

  it("rejects env: refs, http urls, userinfo urls, scope in body, and bad names", () => {
    expect(selfRegisterMcpServerBodySchema.safeParse({ ...base, secret_ref: "env:GH_MCP_TOKEN" }).success).toBe(false);
    expect(selfRegisterMcpServerBodySchema.safeParse({ ...base, url: "http://mcp.example/github" }).success).toBe(false);
    expect(
      selfRegisterMcpServerBodySchema.safeParse({ ...base, url: "https://user:pass@mcp.example/github" }).success,
    ).toBe(false);
    // strict：scope 不得进 self body。
    expect(selfRegisterMcpServerBodySchema.safeParse({ ...base, scope: "ns-x" }).success).toBe(false);
    expect(selfRegisterMcpServerBodySchema.safeParse({ ...base, name: "Bad_Name" }).success).toBe(false);
  });
});
