import { startHttpServer } from "@kokoro/platform-kit";
import { loadPaymentEnv } from "../../config/env.js";
import {
  createCreditGrantClient,
  createCreditReverseClient,
} from "../../infrastructure/credit-grant-client.js";
import { createPaymentServer } from "./server.js";

const env = loadPaymentEnv();
const grantPurchaseCredits = createCreditGrantClient(
  env.KOKORO_CREDIT_BASE_URL,
  env.KOKORO_INTERNAL_SECRET,
);
const reverseCredits = createCreditReverseClient(
  env.KOKORO_CREDIT_BASE_URL,
  env.KOKORO_INTERNAL_SECRET,
);
await startHttpServer({
  moduleName: "kokoro-payment",
  port: env.KOKORO_PAYMENT_PORT,
  createServer: () =>
    createPaymentServer({
      grantPurchaseCredits,
      reverseCredits,
      internalSecret: env.KOKORO_INTERNAL_SECRET,
      ...(env.KOKORO_PAYMENT_CONFIRM_SWEEP_INTERVAL_SECONDS > 0
        ? { confirmSweepIntervalMs: env.KOKORO_PAYMENT_CONFIRM_SWEEP_INTERVAL_SECONDS * 1000 }
        : {}),
      confirmStaleMs: env.KOKORO_PAYMENT_CONFIRM_STALE_SECONDS * 1000,
    }),
});
