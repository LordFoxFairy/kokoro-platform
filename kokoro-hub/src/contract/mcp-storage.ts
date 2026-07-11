// mcp_servers 存储契约：已收编主仓 contract/spec/storage.yaml 单源(McpServerDoc/MCP_SERVERS_COLLECTION
// 经 contract/generate.py 生成进 ./storage.ts)。本文件只保留转发与本地便捷常量,勿再手写形状。
//
// 语义（capability-hub spec §1 / mcp-design spec）：
// - scope: 不透明 namespace 或 "official"（官方位）；namespace 覆盖 official 同名。
// - secret_ref: 凭据只存 env/secret 引用（env:VAR / secret:path），绝不明文；null = 无凭据。
// - enabled: 文档级启停（MCP 是活的外部连接，非 skills 的 per-user 偏好轴）。
// - deleted_at: 软删毫秒时间戳；null = 活跃。

export {
  MCP_SERVERS_COLLECTION,
  mcpServerDocSchema,
  type McpServerDoc,
} from "./storage.js";

export const MCP_TRANSPORTS = ["http", "streamable_http"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];
