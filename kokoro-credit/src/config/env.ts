import { z } from "zod";

// 不 .strict()：parse process.env 超集，strict 会被 PATH/HOME 等无关变量拒绝
export const creditEnvSchema = z.object({
  DATABASE_URL_CREDIT: z.string().url(),
  KOKORO_CREDIT_PORT: z.coerce.number().int().min(1).max(65535).default(4231),
  KOKORO_USER_BASE_URL: z.string().url().default("http://kokoro-user:4211"),
  KOKORO_SITE_BASE_URL: z.string().url().default("http://kokoro-site:4201"),
  KOKORO_MODEL_BASE_URL: z.string().url().default("http://kokoro-model:4221"),
  KOKORO_CREDIT_BASE_URL: z.string().url().default("http://kokoro-credit:4231"),
  KOKORO_PAYMENT_BASE_URL: z.string().url().default("http://kokoro-payment:4241"),
  // 服务间认证密钥：记账前调 user/site active 时携带（user/site 未来校验，纵深防御）。
  KOKORO_INTERNAL_SECRET: z.string().default(""),
});

export type CreditEnv = z.infer<typeof creditEnvSchema>;

export function loadCreditEnv(env: NodeJS.ProcessEnv = process.env): CreditEnv {
  return creditEnvSchema.parse(env);
}
