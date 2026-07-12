import { isProductionEnv, loadCallerSecrets, startHttpServer } from "@kokoro/platform-kit";
import { loadUserEnv } from "../../config/env.js";
import { createUserServer } from "./server.js";

const env = loadUserEnv();
const callerSecrets = loadCallerSecrets();
await startHttpServer({
  moduleName: "kokoro-user",
  port: env.KOKORO_USER_PORT,
  createServer: () =>
    createUserServer({
      routeAccess: { secrets: callerSecrets, isProduction: isProductionEnv() },
      magicLinks: {
        ttlSeconds: env.KOKORO_AUTH_MAGIC_TTL_SECONDS,
        deliveryMode: env.KOKORO_AUTH_MAGIC_DELIVERY,
        rateLimitMax: env.KOKORO_AUTH_MAGIC_RATE_MAX,
        rateLimitWindowSeconds: env.KOKORO_AUTH_MAGIC_RATE_WINDOW_SECONDS,
      },
      ...(env.KOKORO_AUTH_JWT_SECRET
        ? {
            sessionSigning: {
              secret: env.KOKORO_AUTH_JWT_SECRET,
              ttlSeconds: env.KOKORO_AUTH_JWT_TTL_SECONDS,
              issuer: env.KOKORO_AUTH_JWT_ISSUER,
            },
          }
        : {}),
    }),
});
