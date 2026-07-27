import { isProductionEnv, loadCallerSecrets, startHttpServer } from "@kokoro/platform-kit";
import { loadPaymentEnv, parseEnabledProviders } from "../../config/env.js";
import {
  createCreditGrantClient,
  createCreditReverseClient,
} from "../../infrastructure/credit-grant-client.js";
import { createPaymentServer } from "./server.js";

const env = loadPaymentEnv();
const callerSecrets = loadCallerSecrets();
// payment 出站身份=payment；调 credit 授信/退回时带 x-kokoro-service:payment + 该 caller secret。
// 未配即不带该头：接收端只认 per-caller secret，空值头一律 401。
const paymentOutboundSecret = callerSecrets.payment;
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
      enabledProviderKinds: parseEnabledProviders(env.KOKORO_PAYMENT_ENABLED_PROVIDERS),
      routeAccess: { secrets: callerSecrets, isProduction: isProductionEnv() },
      ...(env.KOKORO_PAYMENT_CONFIRM_SWEEP_INTERVAL_SECONDS > 0
        ? { confirmSweepIntervalMs: env.KOKORO_PAYMENT_CONFIRM_SWEEP_INTERVAL_SECONDS * 1000 }
        : {}),
      confirmStaleMs: env.KOKORO_PAYMENT_CONFIRM_STALE_SECONDS * 1000,
    }),
});
