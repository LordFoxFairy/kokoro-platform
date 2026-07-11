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
  // 服务间共享密钥：出站(调 user/site active 携带)与入站(守门 /admin、/credit)同一把。
  // 空串=未配置语义：入站受保护端点直通并告警，出站不带头；配置后入站 fail-closed 校验。
  KOKORO_INTERNAL_SECRET: z.string().default(""),
  // 用量计费面：token 计价 unit、hold 预估用量、冻结冗余系数（估算冗余，先守不透支）。
  KOKORO_CREDIT_USAGE_INPUT_UNIT: z.string().min(1).default("input_token"),
  KOKORO_CREDIT_USAGE_OUTPUT_UNIT: z.string().min(1).default("output_token"),
  KOKORO_CREDIT_HOLD_EST_INPUT_TOKENS: z.coerce.number().int().nonnegative().default(1000),
  KOKORO_CREDIT_HOLD_EST_OUTPUT_TOKENS: z.coerce.number().int().nonnegative().default(1000),
  KOKORO_CREDIT_HOLD_BUFFER_PERCENT: z.coerce.number().int().min(0).default(20),
  // 用量冻结 TTL：hold 落 expiresAt = now + TTL，供过期回收兜底调用方崩溃后的悬挂冻结。缺省 24h。
  KOKORO_CREDIT_HOLD_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  // 进程内过期回收 sweeper 周期；缺省 5 分钟。停机随进程退，不引外部调度。
  KOKORO_CREDIT_HOLD_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
});

export type CreditEnv = z.infer<typeof creditEnvSchema>;

export function loadCreditEnv(env: NodeJS.ProcessEnv = process.env): CreditEnv {
  return creditEnvSchema.parse(env);
}
