import { z } from "zod";

// 不 .strict()：parse process.env 超集，strict 会被 PATH/HOME 等无关变量拒绝
export const userEnvSchema = z.object({
  DATABASE_URL_USER: z.string().url(),
  KOKORO_USER_PORT: z.coerce.number().int().min(1).max(65535).default(4211),
  KOKORO_USER_BASE_URL: z.string().url().default("http://kokoro-user:4211"),
  KOKORO_MODEL_BASE_URL: z.string().url().default("http://kokoro-model:4221"),
  KOKORO_CREDIT_BASE_URL: z.string().url().default("http://kokoro-credit:4231"),
  KOKORO_PAYMENT_BASE_URL: z.string().url().default("http://kokoro-payment:4241"),
});

export type UserEnv = z.infer<typeof userEnvSchema>;

export function loadUserEnv(env: NodeJS.ProcessEnv = process.env): UserEnv {
  return userEnvSchema.parse(env);
}
