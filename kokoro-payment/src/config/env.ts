import { z } from "zod";

// WHY: 解析 process.env 超集，故意保留 strip；strict 会被 PATH/HOME 等无关变量拒绝。
export const paymentEnvSchema = z.object({
  DATABASE_URL_PAYMENT: z.string().url(),
  KOKORO_PAYMENT_PORT: z.coerce.number().int().min(1).max(65535).default(4241),
  KOKORO_USER_BASE_URL: z.string().url().default("http://kokoro-user:4211"),
  KOKORO_MODEL_BASE_URL: z.string().url().default("http://kokoro-model:4221"),
  KOKORO_CREDIT_BASE_URL: z.string().url().default("http://kokoro-credit:4231"),
  KOKORO_PAYMENT_BASE_URL: z.string().url().default("http://kokoro-payment:4241"),
});

export type PaymentEnv = z.infer<typeof paymentEnvSchema>;

export function loadPaymentEnv(env: NodeJS.ProcessEnv = process.env): PaymentEnv {
  return paymentEnvSchema.parse(env);
}
