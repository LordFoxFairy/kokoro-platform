import { z } from "zod";

// Unknown system/process keys are stripped intentionally. Known acquisition keys are
// rejected before Zod parsing so a stale deployment cannot look healthy while carrying
// provider, worker, or webhook-secret configuration that the runtime refuses to use.
export const paymentEnvSchema = z.object({
  DATABASE_URL_PAYMENT: z.string().url(),
  KOKORO_PAYMENT_PORT: z.coerce.number().int().min(1).max(65535).default(4241),
});

export type PaymentEnv = z.infer<typeof paymentEnvSchema>;

export class DeprecatedPaymentAcquisitionEnvError extends Error {
  readonly code = "payment.acquisition_env_forbidden";

  constructor(readonly variables: string[]) {
    super(`redeem-only payment runtime rejects acquisition environment: ${variables.join(", ")}`);
    this.name = "DeprecatedPaymentAcquisitionEnvError";
  }
}

const DEPRECATED_ACQUISITION_ENV = /^KOKORO_PAYMENT_(?:ENABLED_PROVIDERS|CONFIRM_.+|ALIPAY_PUBLIC_KEY|WECHAT_PLATFORM_CERT)$/u;

function isDeprecatedAcquisitionEnv(key: string): boolean {
  return (
    DEPRECATED_ACQUISITION_ENV.test(key) ||
    (key.includes("WEBHOOK") && key.includes("SECRET"))
  );
}

export function loadPaymentEnv(env: NodeJS.ProcessEnv = process.env): PaymentEnv {
  const forbidden = Object.entries(env)
    .filter(([key, value]) => isDeprecatedAcquisitionEnv(key) && value?.trim())
    .map(([key]) => key)
    .sort();
  if (forbidden.length > 0) {
    throw new DeprecatedPaymentAcquisitionEnvError(forbidden);
  }
  return paymentEnvSchema.parse(env);
}
