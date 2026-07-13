// MCP server 配置指纹（MCP-REVISION）：会话快照锁内容的依据。
// config_hash = 规范化 {transport, url, allowed_tools(排序), secret_ref} 的 sha256。
//
// 关键语义（纲领原文）：
// - secret handle 轮换（同 handle 换值）不改 secret_ref → 不改 hash → 不 bump revision（轮换实时生效）。
//   因此 hash 只吃 secret_ref 这个引用串，绝不吃句柄背后的明文值。
// - allowed_tools 顺序无关：注册顺序不同但集合相同 → 同一 hash（语义等价不制造多余版本）。
// - hub 是 config_hash 的唯一计算方；agent 侧只做 grant.config_hash 与快照行 config_hash 的串等比对。

import { createHash } from "node:crypto";
import type { McpTransport } from "../contract/mcp-storage.js";

export interface McpConfigHashInput {
  transport: McpTransport;
  url: string;
  allowedTools: readonly string[];
  secretRef: string | null;
}

// Python sorted() 是码点序；JS 默认 sort 是 UTF-16 码元序——显式按码点比较，跨语言一致。
function codePointCompare(a: string, b: string): number {
  const as = Array.from(a);
  const bs = Array.from(b);
  const len = Math.min(as.length, bs.length);
  for (let i = 0; i < len; i += 1) {
    const diff = ((as[i] ?? "").codePointAt(0) ?? -1) - ((bs[i] ?? "").codePointAt(0) ?? -1);
    if (diff !== 0) {
      return diff;
    }
  }
  return as.length - bs.length;
}

// 固定键序 + allowed_tools 码点排序的规范化 JSON，喂 sha256。键序写死在此，改动即改 hash 语义。
function canonicalConfig(input: McpConfigHashInput): string {
  const tools = [...input.allowedTools].sort(codePointCompare);
  return JSON.stringify({
    allowed_tools: tools,
    secret_ref: input.secretRef,
    transport: input.transport,
    url: input.url,
  });
}

export function mcpConfigHash(input: McpConfigHashInput): string {
  return createHash("sha256").update(canonicalConfig(input), "utf8").digest("hex");
}
