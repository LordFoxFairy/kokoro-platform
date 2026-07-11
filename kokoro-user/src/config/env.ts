import { z } from "zod";

// 不 .strict()：parse process.env 超集，strict 会被 PATH/HOME 等无关变量拒绝
export const userEnvSchema = z.object({
  DATABASE_URL_USER: z.string().url(),
  KOKORO_USER_PORT: z.coerce.number().int().min(1).max(65535).default(4211),
  KOKORO_USER_BASE_URL: z.string().url().default("http://kokoro-user:4211"),
  // 服务间共享密钥：入站守门 /admin(网关) 与 /owners(credit 查 active)。空串=未配置直通。
  KOKORO_INTERNAL_SECRET: z.string().default(""),
  KOKORO_MODEL_BASE_URL: z.string().url().default("http://kokoro-model:4221"),
  KOKORO_CREDIT_BASE_URL: z.string().url().default("http://kokoro-credit:4231"),
  KOKORO_PAYMENT_BASE_URL: z.string().url().default("http://kokoro-payment:4241"),
  // 终端用户会话签发密钥（HS256）：与 kokoro-session 同名同值部署，session 验签共享。
  // 未配置 = /auth/sessions fail-closed（503），绝不签发未签名 token；其它路由不受影响。
  KOKORO_AUTH_JWT_SECRET: z.string().min(1).optional(),
  KOKORO_AUTH_JWT_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),
  KOKORO_AUTH_JWT_ISSUER: z.string().min(1).default("kokoro-user"),
});

export type UserEnv = z.infer<typeof userEnvSchema>;

export function loadUserEnv(env: NodeJS.ProcessEnv = process.env): UserEnv {
  return userEnvSchema.parse(env);
}
