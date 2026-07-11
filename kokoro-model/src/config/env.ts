import { z } from "zod";

// 不 .strict()：parse process.env 超集，strict 会被 PATH/HOME 等无关变量拒绝
export const modelEnvSchema = z.object({
  DATABASE_URL_MODEL: z.string().url(),
  KOKORO_MODEL_PORT: z.coerce.number().int().min(1).max(65535).default(4221),
  // 服务间共享密钥：入站守门 /admin(网关)。空串=未配置直通。
  KOKORO_INTERNAL_SECRET: z.string().default(""),
  KOKORO_USER_BASE_URL: z.string().url().default("http://kokoro-user:4211"),
  KOKORO_MODEL_BASE_URL: z.string().url().default("http://kokoro-model:4221"),
  KOKORO_CREDIT_BASE_URL: z.string().url().default("http://kokoro-credit:4231"),
  KOKORO_PAYMENT_BASE_URL: z.string().url().default("http://kokoro-payment:4241"),
});

export type ModelEnv = z.infer<typeof modelEnvSchema>;

export function loadModelEnv(env: NodeJS.ProcessEnv = process.env): ModelEnv {
  return modelEnvSchema.parse(env);
}
