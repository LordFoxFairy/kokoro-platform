import { z } from "zod";

// WHY: 解析 process.env 超集，故意保留 strip；strict 会被 PATH/HOME 等无关变量拒绝。
export const paymentEnvSchema = z.object({
  DATABASE_URL_PAYMENT: z.string().url(),
  KOKORO_PAYMENT_PORT: z.coerce.number().int().min(1).max(65535).default(4241),
  // 服务间共享密钥：入站守门 /admin(网关)，出站调 credit 记账时携带。空串=未配置直通/不带头。
  KOKORO_INTERNAL_SECRET: z.string().default(""),
  // confirming 悬挂收尾:sweep 周期(0=关)与判定阈值(updatedAt 早于此秒数才算悬挂,避开正常确认在途窗口)。
  KOKORO_PAYMENT_CONFIRM_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(300),
  KOKORO_PAYMENT_CONFIRM_STALE_SECONDS: z.coerce.number().int().min(1).default(120),
  KOKORO_USER_BASE_URL: z.string().url().default("http://kokoro-user:4211"),
  KOKORO_MODEL_BASE_URL: z.string().url().default("http://kokoro-model:4221"),
  KOKORO_CREDIT_BASE_URL: z.string().url().default("http://kokoro-credit:4231"),
  KOKORO_PAYMENT_BASE_URL: z.string().url().default("http://kokoro-payment:4241"),
});

export type PaymentEnv = z.infer<typeof paymentEnvSchema>;

export function loadPaymentEnv(env: NodeJS.ProcessEnv = process.env): PaymentEnv {
  return paymentEnvSchema.parse(env);
}
