import type { McpTransport } from "../contract/mcp-storage.js";

// 池视图：某 namespace 可用的 MCP server（official + 自有合并，namespace 覆盖同名）。
// secret_ref 是引用名（env:VAR / handle:srt_...）非凭据本体，可安全回传管理面。
// revision = 当前版号（MCP-REVISION）；存量文档读侧按 1 补齐。
export interface McpServerView {
  scope: string;
  name: string;
  revision: number;
  transport: McpTransport;
  url: string;
  allowed_tools: string[];
  secret_ref: string | null;
  enabled: boolean;
}

// 运行时授权卡（MCP-REVISION）：session 建会话快照锁进 RuntimeConfig.mcp_servers。
// config_hash 是内容锁——agent 装配按 (scope,name,revision) 取快照行后须与本 hash 串等，否则 fail-closed。
export interface McpGrantView {
  scope: string;
  name: string;
  revision: number;
  config_hash: string;
}

// 版本快照（agent 装配用）：按 (scope,name,revision) 取的不可变内容行。agent 用这份连接目标，
// 绝不靠 wire 猜"现在的配置"；secret_ref 仍是引用，明文经 hub secret resolve 换。
export interface McpServerSnapshotView {
  scope: string;
  name: string;
  revision: number;
  config_hash: string;
  transport: McpTransport;
  url: string;
  allowed_tools: string[];
  secret_ref: string | null;
}

// 活文档现况（fail-closed 支撑）：disable/revoke 立即对旧会话生效——快照仍在，但活文档说停就停。
export interface McpServerLiveStatus {
  enabled: boolean;
  deleted: boolean;
}

// agent 装配读取的一次性组合：不可变快照 + 活文档现况。快照缺失（未知 revision）返回 null → fail-closed 拒装。
export interface McpServerRevisionResolution {
  snapshot: McpServerSnapshotView;
  live: McpServerLiveStatus;
}

// 注册/更新入参：url 与 secret_ref 形状在 http 边界（mcp-schemas / mcp-server-ref）校验后才到达仓储。
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
  // 读到无 revision 的存量活文档 → 迁移语义：按 revision=1 补齐并 append 快照行（幂等）。
  listPool(namespace: string): Promise<McpServerView[]>;
  // 会话快照解析：同 listPool 的有效池，但每项收敛成 McpGrant（含 revision + config_hash）。
  resolveGrants(namespace: string): Promise<McpGrantView[]>;
  // 按 (scope,name,revision) 取不可变快照行 + 活文档现况；快照不存在返回 null（agent fail-closed 拒装）。
  getRevisionSnapshot(
    scope: string,
    name: string,
    revision: number,
  ): Promise<McpServerRevisionResolution | null>;
  // 注册即 upsert：同名重注册更新定义并复活软删；enabled 只在首插默认 true，重注册不翻用户启停。
  // 内容变化（config_hash 变）→ revision+1 并 append 快照行；内容相同 → 幂等短路不 bump（对齐 skills）。
  upsertServer(input: UpsertMcpServerInput): Promise<McpServerView>;
  // 文档级启停（非 skills 的 per-user 偏好）；目标不存在或已软删抛 McpServerNotFoundError。
  setEnabled(scope: string, name: string, enabled: boolean): Promise<void>;
  // 软删：置 deleted_at，池即刻不可见；幂等（不存在静默通过，对齐 skills 面）。
  markDeleted(scope: string, name: string): Promise<void>;
  // 运营官方目录：只出 official scope、未软删，含禁用项（运营要看到停用的 server 才能重启），按 name 升序。
  // 不做 namespace 合并（这是运营视角，非租户有效池）。
  listOfficialCatalog(): Promise<McpServerView[]>;
}
