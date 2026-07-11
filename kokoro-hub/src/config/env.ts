import { z } from "zod";

// 不 .strict()：parse process.env 超集，strict 会被 PATH/HOME 等无关变量拒绝。
export const hubEnvSchema = z.object({
  KOKORO_HUB_PORT: z.coerce.number().int().min(1).max(65535).default(4251),
  KOKORO_HUB_BASE_URL: z.string().url().default("http://kokoro-hub:4251"),
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
});

export type HubEnv = z.infer<typeof hubEnvSchema>;

export function loadHubEnv(env: NodeJS.ProcessEnv = process.env): HubEnv {
  return hubEnvSchema.parse(env);
}
