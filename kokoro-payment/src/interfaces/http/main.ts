import { startHttpServer } from "@kokoro/platform-kit";
import { loadPaymentEnv } from "../../config/env.js";
import { createPaymentServer } from "./server.js";

const env = loadPaymentEnv();
await startHttpServer({
  moduleName: "kokoro-payment",
  port: env.KOKORO_PAYMENT_PORT,
  createServer: createPaymentServer,
});
