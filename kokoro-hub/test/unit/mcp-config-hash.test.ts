import { describe, expect, it } from "vitest";
import { mcpConfigHash } from "../../src/domain/mcp-config-hash.js";

const base = {
  transport: "streamable_http" as const,
  url: "https://mcp.example/gh",
  allowedTools: ["search", "create"],
  secretRef: "handle:srt_0123456789abcdef0123456789abcdef",
};

describe("mcpConfigHash", () => {
  it("是 64 位 hex sha256", () => {
    const hash = mcpConfigHash(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("allowed_tools 顺序无关（集合相同即同 hash）", () => {
    const a = mcpConfigHash({ ...base, allowedTools: ["search", "create"] });
    const b = mcpConfigHash({ ...base, allowedTools: ["create", "search"] });
    expect(a).toBe(b);
  });

  it("secret handle 轮换语义：hash 只吃 secret_ref 引用串，同 ref 恒同 hash", () => {
    // 同一 handle 引用（背后明文换值是 broker 的事，不入 hash）→ 版本不变。
    const a = mcpConfigHash(base);
    const b = mcpConfigHash({ ...base });
    expect(a).toBe(b);
  });

  it("secret_ref 变化改 hash（换新句柄 = 内容变）", () => {
    const a = mcpConfigHash(base);
    const b = mcpConfigHash({ ...base, secretRef: "handle:srt_ffffffffffffffffffffffffffffffff" });
    expect(a).not.toBe(b);
  });

  it("null 与有值 secret_ref 不同 hash", () => {
    const a = mcpConfigHash({ ...base, secretRef: null });
    const b = mcpConfigHash(base);
    expect(a).not.toBe(b);
  });

  it("url / transport 变化改 hash", () => {
    expect(mcpConfigHash({ ...base, url: "https://mcp.example/other" })).not.toBe(mcpConfigHash(base));
    expect(mcpConfigHash({ ...base, transport: "http" })).not.toBe(mcpConfigHash(base));
  });
});
