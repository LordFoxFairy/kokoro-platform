import { isProductionEnv, loadCallerSecrets, startHttpServer } from "@kokoro/platform-kit";
import { loadPaymentEnv } from "../../config/env.js";
import {
  createCreditGrantClient,
  createCreditReverseClient,
} from "../../infrastructure/credit-grant-client.js";
import { createPaymentServer } from "./server.js";

const env = loadPaymentEnv();
const callerSecrets = loadCallerSecrets();
// payment 出站身份=payment；调 credit 授信/退回时带 x-kokoro-service:payment + 该 caller secret。
// 遗留单一 KOKORO_INTERNAL_SECRET 作缺失回退，便于灰度迁移。
const paymentOutboundSecret = callerSecrets.payment ?? env.KOKORO_INTERNAL_SECRET;
const grantPurchaseCredits = createCreditGrantClient(
  env.KOKORO_CREDIT_BASE_URL,
  paymentOutboundSecret,
);
const reverseCredits = createCreditReverseClient(
  env.KOKORO_CREDIT_BASE_URL,
  paymentOutboundSecret,
);
await startHttpServer({
  moduleName: "kokoro-payment",
  port: env.KOKORO_PAYMENT_PORT,
  createServer: () =>
    createPaymentServer({
      grantPurchaseCredits,
      reverseCredits,
      routeAccess: { secrets: callerSecrets, isProduction: isProductionEnv() },
      ...(env.KOKORO_PAYMENT_CONFIRM_SWEEP_INTERVAL_SECONDS > 0
        ? { confirmSweepIntervalMs: env.KOKORO_PAYMENT_CONFIRM_SWEEP_INTERVAL_SECONDS * 1000 }
        : {}),
      confirmStaleMs: env.KOKORO_PAYMENT_CONFIRM_STALE_SECONDS * 1000,
    }),
});
