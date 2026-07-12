import { z } from "zod";

// 不 .strict()：parse process.env 超集，strict 会被 PATH/HOME 等无关变量拒绝。
export const hubEnvSchema = z.object({
  KOKORO_HUB_PORT: z.coerce.number().int().min(1).max(65535).default(4251),
  KOKORO_HUB_BASE_URL: z.string().url().default("http://kokoro-hub:4251"),
  // user 服务基址：self 面成员校验经 caller=hub 调其 /memberships/check（HUB-AUTHZ）。
  KOKORO_USER_BASE_URL: z.string().url().default("http://kokoro-user:4211"),
  // 能力中台元数据库（Mongo，与 agent 装配读路同库，hub 写 / agent 读）。
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
});

export type HubEnv = z.infer<typeof hubEnvSchema>;

export function loadHubEnv(env: NodeJS.ProcessEnv = process.env): HubEnv {
  return hubEnvSchema.parse(env);
}
