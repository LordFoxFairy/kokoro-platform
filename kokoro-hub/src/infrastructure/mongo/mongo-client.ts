import { type Collection, type Db, MongoClient } from "mongodb";
import { MCP_SECRETS_COLLECTION } from "../../contract/mcp-secret-storage.js";
import {
  MCP_SERVER_REVISIONS_COLLECTION,
  MCP_SERVERS_COLLECTION,
  type McpTransport,
} from "../../contract/mcp-storage.js";
import type { ReviewStatus } from "../../contract/skill-curation-storage.js";
import type { CapabilityCatalogSnapshot } from "../../domain/capability-catalog.js";
import { SKILL_REVISIONS_COLLECTION, SKILL_STATE_COLLECTION, SKILLS_COLLECTION } from "../../contract/storage.js";

// Mongo 存储态记录（hub 写、agent 读，同库读写分离）。deleted_at 显式可空：
// upsert 时写 null，软删时写毫秒时间戳；查询 { deleted_at: null } 同时命中 null 与缺省。
export interface SkillRecord {
  scope: string;
  name: string;
  description: string;
  skill_md: string;
  files_manifest: { path: string; size: number }[];
  file_count: number;
  package_size: number;
  content_hash: string;
  package_ref: string;
  source: string;
  revision: number;
  official_enabled: boolean;
  official_required: boolean;
  updated_at: number;
  deleted_at: number | null;
  // 运营位 + 审核态（HUB-4，旁注记 contract/skill-curation-storage.ts，待收编 storage.yaml）。
  // 可选 = 存量文档缺字段；读侧按 SKILL_CURATION_DEFAULTS 补缺省（display_weight 0 / pinned false /
  // category null / review_status approved），不做存量迁移写。
  display_weight?: number;
  pinned?: boolean;
  category?: string | null;
  review_status?: ReviewStatus;
}

export interface SkillStateRecord {
  namespace: string;
  name: string;
  enabled: boolean;
  updated_at: number;
}

// 版本历史附集合（HUB-2，hub 自有、暂未入 storage.yaml 契约单源）：append-only，
// upsert 真实写入时顺手落一条；软删/幂等短路不落。包体 zip 本就按 content_hash 永存=回滚零成本。
export interface SkillRevisionRecord {
  scope: string;
  name: string;
  revision: number;
  content_hash: string;
  package_size: number;
  source: string;
  created_at: number;
}

// MCP server 注册表记录（HUB-3）：per-namespace + official scope，enabled 为文档级启停。
// secret_ref 只存 env/secret 引用（形状在 http 边界钉死），绝不明文凭据。
// TODO(主控): mcp_servers 文档 schema 收编进主仓 contract/spec/storage.yaml 单源后，
// 本类型与 src/contract/mcp-storage.ts 改由 generate.py 生成镜像。
export interface McpServerRecord {
  scope: string;
  name: string;
  // revision = 当前版号（MCP-REVISION）。存量文档无此字段：读侧按 revision=1 补齐并 append 快照行（迁移语义）。
  revision?: number;
  transport: McpTransport;
  url: string;
  allowed_tools: string[];
  secret_ref: string | null;
  enabled: boolean;
  updated_at: number;
  deleted_at: number | null;
}

// MCP server 版本快照记录（MCP-REVISION，append-only 同 skill_revisions）：define/update 内容变化时
// 落一格不可变快照。行永不改写；grant 按 (scope,name,revision) 取此行定死会话内容，disable/revoke
// 是活文档（McpServerRecord）的事，快照只保真历史。config_hash=规范化配置 sha256（内容锁）。
export interface McpServerRevisionRecord {
  scope: string;
  name: string;
  revision: number;
  config_hash: string;
  transport: McpTransport;
  url: string;
  allowed_tools: string[];
  secret_ref: string | null;
  created_at: number;
}

// MCP secret 记录（MCP-SECRET HUB 半场）：明文绝不落库——ciphertext 是 AES-256-GCM 信封串，
// key_id 是加密所用主密钥指纹（轮换双读定位键）。handle 是对外唯一暴露的不透明句柄。
// TODO(主控): mcp_secrets 文档 schema 收编进主仓 contract/spec/storage.yaml 单源后，
// 本类型与 src/contract/mcp-secret-storage.ts 改由 generate.py 生成镜像（参照 mcp_servers 先例）。
export interface McpSecretRecord {
  scope: string;
  handle: string;
  name: string;
  ciphertext: string;
  key_id: string;
  created_at: number;
  deleted_at: number | null;
}

export interface CapabilityPublicationRecord {
  site_id: string;
  site_release_ref: string;
  command_id: string;
  idempotency_key: string;
  request_digest: string;
  agent_catalog_ref: string;
  snapshot_digest: string;
  snapshot: CapabilityCatalogSnapshot;
  frozen_at: string;
  signing_key_ref: string;
  signature_algorithm: "ed25519-sha256-v1";
  signature_payload_digest: string;
  signature: Uint8Array;
  recorded_at: string;
  projection_state: "pending" | "committed" | "rejected" | "outcome_unknown";
  projection_attempt: number;
  projection_next_attempt_at: string;
  projection_lease_id: string | null;
  projection_lease_until: string | null;
  projected_at: string | null;
  last_projection_error_code: string | null;
}

export interface HubCollections {
  skills: Collection<SkillRecord>;
  state: Collection<SkillStateRecord>;
  revisions: Collection<SkillRevisionRecord>;
  mcpServers: Collection<McpServerRecord>;
  mcpServerRevisions: Collection<McpServerRevisionRecord>;
  mcpSecrets: Collection<McpSecretRecord>;
  capabilityPublications: Collection<CapabilityPublicationRecord>;
}

export function createMongoClient(url: string): MongoClient {
  return new MongoClient(url);
}

export function hubCollections(db: Db): HubCollections {
  return {
    skills: db.collection<SkillRecord>(SKILLS_COLLECTION),
    state: db.collection<SkillStateRecord>(SKILL_STATE_COLLECTION),
    revisions: db.collection<SkillRevisionRecord>(SKILL_REVISIONS_COLLECTION),
    mcpServers: db.collection<McpServerRecord>(MCP_SERVERS_COLLECTION),
    mcpServerRevisions: db.collection<McpServerRevisionRecord>(MCP_SERVER_REVISIONS_COLLECTION),
    mcpSecrets: db.collection<McpSecretRecord>(MCP_SECRETS_COLLECTION),
    capabilityPublications: db.collection<CapabilityPublicationRecord>("capability_publications"),
  };
}
