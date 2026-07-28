import { z } from "zod";

// Unknown keys are stripped intentionally. In particular, all former provider/worker
// switches are ignored so an old deployment environment cannot re-enable acquisition.
export const paymentEnvSchema = z.object({
  DATABASE_URL_PAYMENT: z.string().url(),
  KOKORO_PAYMENT_PORT: z.coerce.number().int().min(1).max(65535).default(4241),
});

export type PaymentEnv = z.infer<typeof paymentEnvSchema>;

export function loadPaymentEnv(env: NodeJS.ProcessEnv = process.env): PaymentEnv {
  return paymentEnvSchema.parse(env);
}
