import { z } from "zod";

export const creditEnvSchema = z.object({
  DATABASE_URL_CREDIT: z.string().url(),
  KOKORO_CREDIT_PORT: z.coerce.number().int().min(1).max(65535).default(4231),
  KOKORO_USER_BASE_URL: z.string().url().default("http://kokoro-user:4211"),
  KOKORO_MODEL_BASE_URL: z.string().url().default("http://kokoro-model:4221"),
  KOKORO_CREDIT_BASE_URL: z.string().url().default("http://kokoro-credit:4231"),
  KOKORO_PAYMENT_BASE_URL: z.string().url().default("http://kokoro-payment:4241"),
});

export type CreditEnv = z.infer<typeof creditEnvSchema>;

export function loadCreditEnv(env: NodeJS.ProcessEnv = process.env): CreditEnv {
  return creditEnvSchema.parse(env);
}
