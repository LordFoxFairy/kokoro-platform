import { z } from "zod";

// 不 .strict()：parse process.env 超集，strict 会被 PATH/HOME 等无关变量拒绝。
export const hubEnvSchema = z.object({
  KOKORO_HUB_PORT: z.coerce.number().int().min(1).max(65535).default(4251),
  KOKORO_HUB_BASE_URL: z.string().url().default("http://kokoro-hub:4251"),
  // 能力中台元数据库（Hub 私有；Agent 只能通过 mTLS ConnectRPC 消费运行时装配）。
  KOKORO_HUB_MONGO_URL: z.string().min(1).default("mongodb://127.0.0.1:27017"),
  KOKORO_HUB_MONGO_DB: z.string().min(1).default("kokoro_hub"),
  // 每 namespace 上传配额上限（包数 / 字节合计）；上传写面在 HUB-2 落地，本期只做只读配额视图。
  KOKORO_HUB_QUOTA_MAX_PACKAGES: z.coerce.number().int().min(0).default(100),
  KOKORO_HUB_QUOTA_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(0)
    .default(200 * 1024 * 1024),
  // ADR-009 存储 yaml（session/agent/hub 三侧读同一文件；hub 只取 hub 节做包体权威源）。
  // 缺省 = 包体存储未配置：上传 confirm 面 503，其余面照常。
  KOKORO_WORKSPACE_CONFIG: z.string().min(1).optional(),
  // s3 档凭据（env-only，ADR-010；与 agent 侧同名复用 workspace 对，永不进配置文件/日志）。
  KOKORO_WORKSPACE_S3_ACCESS_KEY: z.string().min(1).optional(),
  KOKORO_WORKSPACE_S3_SECRET_KEY: z.string().min(1).optional(),
  // MCP secret 信封加密主密钥（32B base64；env-only，永不进配置/日志/响应）。
  // 缺省 = secret broker 未配置：self secret 面 503，ConnectRPC 进程生产启动时 fail-fast。
  KOKORO_HUB_SECRET_MASTER_KEY: z.string().min(1).optional(),
  // 轮换双读的历史主密钥（逗号分隔 base64，各 32B）：新写用 primary，旧信封按 key_id 仍可解。
  KOKORO_HUB_SECRET_MASTER_KEY_PREVIOUS: z.string().min(1).optional(),
  // mcp_servers admin/official 面 env: 引用白名单（逗号分隔 VAR 名）；不在表的 env:VAR 注册 400。
  KOKORO_HUB_ENV_REF_ALLOWLIST: z.string().min(1).optional(),
  // 仅放行 http scheme（admin 面 + 本地/test profile）；地址公网单播防线始终启用。
  KOKORO_HUB_ALLOW_INSECURE_URL: z.string().optional(),
  // namespace self 面 MCP mutation 部署门（HUB-CONSIST 跨仓 E2E 过后才开）：
  // "on" 开启 self 注册/启停/软删（仍全量强制 secret_ref handle 归属 / URL 预校验防线）；
  // 缺省 = off → mutation 恒 503 capability_registration_disabled（fail-closed）。
  KOKORO_HUB_MCP_MUTATION: z.string().optional(),
});

export type HubEnv = z.infer<typeof hubEnvSchema>;

export function loadHubEnv(env: NodeJS.ProcessEnv = process.env): HubEnv {
  return hubEnvSchema.parse(env);
}
