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
  // 用量计费面：token 计价 unit、hold 预估用量、冻结冗余系数（估算冗余，先守不透支）。
  KOKORO_CREDIT_USAGE_INPUT_UNIT: z.string().min(1).default("input_token"),
  KOKORO_CREDIT_USAGE_OUTPUT_UNIT: z.string().min(1).default("output_token"),
  KOKORO_CREDIT_HOLD_EST_INPUT_TOKENS: z.coerce.number().int().nonnegative().default(1000),
  KOKORO_CREDIT_HOLD_EST_OUTPUT_TOKENS: z.coerce.number().int().nonnegative().default(1000),
  KOKORO_CREDIT_HOLD_BUFFER_PERCENT: z.coerce.number().int().min(0).default(20),
});

export type CreditEnv = z.infer<typeof creditEnvSchema>;

export function loadCreditEnv(env: NodeJS.ProcessEnv = process.env): CreditEnv {
  return creditEnvSchema.parse(env);
}
