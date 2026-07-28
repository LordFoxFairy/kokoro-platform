import { isProductionEnv, loadCallerSecrets, startHttpServer } from "@kokoro/platform-kit";
import { loadPaymentEnv } from "../../config/env.js";
import { openPrismaPaymentReadStore } from "../../infrastructure/prisma/prisma-payment-read-repository.js";
import { createPaymentServer } from "./server.js";

const env = loadPaymentEnv();
const callerSecrets = loadCallerSecrets();
const readStore = openPrismaPaymentReadStore(env.DATABASE_URL_PAYMENT_READ);

// Redeem-only process bootstrap deliberately has no provider SDK, webhook secret,
// credit client or acquisition worker imports. Environment cannot widen this graph.
await startHttpServer({
  moduleName: "kokoro-payment",
  port: env.KOKORO_PAYMENT_PORT,
  createServer: () =>
    createPaymentServer({
      readCapabilities: readStore.capabilities,
      closeReadStore: readStore.close,
      routeAccess: { secrets: callerSecrets, isProduction: isProductionEnv() },
    }),
});
