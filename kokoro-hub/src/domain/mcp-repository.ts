import type { McpTransport } from "../contract/mcp-storage.js";

// 池视图：某 namespace 可用的 MCP server（official + 自有合并，namespace 覆盖同名）。
// secret_ref 是引用名（env:VAR / secret:path）非凭据本体，可安全回传管理面。
export interface McpServerView {
  scope: string;
  name: string;
  transport: McpTransport;
  url: string;
  allowed_tools: string[];
  secret_ref: string | null;
  enabled: boolean;
}

// 注册/更新入参：url 与 secret_ref 形状在 http 边界（mcp-schemas）校验后才到达仓储。
export interface UpsertMcpServerInput {
  scope: string;
  name: string;
  transport: McpTransport;
  url: string;
  allowedTools: string[];
  secretRef: string | null;
}

export interface McpServerRepository {
  // 该 namespace 可用池：official + 本 namespace 合并（namespace 覆盖同名），只含 enabled 且未软删。
  // 活跃自有文档即占名：禁用的自有 server 不回退 official 同名（避免静默换到官方凭据）。
  listPool(namespace: string): Promise<McpServerView[]>;
  // 注册即 upsert：同名重注册更新定义并复活软删；enabled 只在首插默认 true，重注册不翻用户启停。
  upsertServer(input: UpsertMcpServerInput): Promise<McpServerView>;
  // 文档级启停（非 skills 的 per-user 偏好）；目标不存在或已软删抛 McpServerNotFoundError。
  setEnabled(scope: string, name: string, enabled: boolean): Promise<void>;
  // 软删：置 deleted_at，池即刻不可见；幂等（不存在静默通过，对齐 skills 面）。
  markDeleted(scope: string, name: string): Promise<void>;
}
