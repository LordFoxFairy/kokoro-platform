import { startHttpServer } from "@kokoro/platform-kit";
import { loadPaymentEnv } from "../../config/env.js";
import {
  createCreditGrantClient,
  createCreditReverseClient,
} from "../../infrastructure/credit-grant-client.js";
import { createPaymentServer } from "./server.js";

const env = loadPaymentEnv();
const grantPurchaseCredits = createCreditGrantClient(env.KOKORO_CREDIT_BASE_URL);
const reverseCredits = createCreditReverseClient(env.KOKORO_CREDIT_BASE_URL);
await startHttpServer({
  moduleName: "kokoro-payment",
  port: env.KOKORO_PAYMENT_PORT,
  createServer: () => createPaymentServer({ grantPurchaseCredits, reverseCredits }),
});
