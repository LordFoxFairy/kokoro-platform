import { isProductionEnv, loadCallerSecrets, startHttpServer } from "@kokoro/platform-kit";
import { loadPaymentEnv } from "../../config/env.js";
import { createPaymentServer } from "./server.js";

const env = loadPaymentEnv();
const callerSecrets = loadCallerSecrets();

// Redeem-only process bootstrap deliberately has no provider SDK, webhook secret,
// credit client or acquisition worker imports. Environment cannot widen this graph.
await startHttpServer({
  moduleName: "kokoro-payment",
  port: env.KOKORO_PAYMENT_PORT,
  createServer: () =>
    createPaymentServer({
      routeAccess: { secrets: callerSecrets, isProduction: isProductionEnv() },
    }),
});
