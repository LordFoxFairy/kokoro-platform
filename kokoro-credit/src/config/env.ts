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
  // 遗留单一共享密钥：仅作 per-caller secret（KOKORO_INTERNAL_SECRET_CREDIT）缺失时的出站回退。
  // 入站校验改由 route-access 按 per-caller 注册表（loadCallerSecrets）执行。
  // @deprecated 迁移到 per-caller secret 后删除。
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
  // owner/site active 正向缓存 TTL：只缓存 active=true，负向不缓存（fail-closed 不放松）。0=关闭缓存。
  KOKORO_CREDIT_ACTIVE_CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(30),
  // active 缓存条数上限，防无界膨胀；超限逐最旧。
  KOKORO_CREDIT_ACTIVE_CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(10_000),
  // 新账户首次开通即发放的 welcome 授信（微单位字符串）。0=关闭。产品默认：新用户送 100 积分=1000000。
  KOKORO_CREDIT_WELCOME_MICROS: z.string().regex(/^\d+$/).default("0"),
});

export type CreditEnv = z.infer<typeof creditEnvSchema>;

export function loadCreditEnv(env: NodeJS.ProcessEnv = process.env): CreditEnv {
  return creditEnvSchema.parse(env);
}
