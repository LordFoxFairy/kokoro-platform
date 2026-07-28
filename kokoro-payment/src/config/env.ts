import { z } from "zod";

// Unknown system/process keys are stripped intentionally. Known acquisition keys are
// rejected before Zod parsing so a stale deployment cannot look healthy while carrying
// provider, worker, or webhook-secret configuration that the runtime refuses to use.
export const paymentEnvSchema = z.object({
  DATABASE_URL_PAYMENT_READ: z.string().url(),
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

const DEPRECATED_ACQUISITION_ENV = new Set([
  "KOKOROPAYMENTENABLEDPROVIDERS",
  "KOKOROPAYMENTALIPAYPUBLICKEY",
  "KOKOROPAYMENTWECHATPLATFORMCERT",
]);

function normalizeEnvSemanticKey(key: string): string {
  return key.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/gu, "");
}

function isDeprecatedAcquisitionEnv(key: string): boolean {
  const semanticKey = normalizeEnvSemanticKey(key);
  return (
    DEPRECATED_ACQUISITION_ENV.has(semanticKey) ||
    semanticKey.startsWith("KOKOROPAYMENTCONFIRM") ||
    (semanticKey.includes("WEBHOOK") && semanticKey.includes("SECRET"))
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
