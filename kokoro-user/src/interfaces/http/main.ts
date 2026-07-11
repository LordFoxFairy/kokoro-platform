import { startHttpServer } from "@kokoro/platform-kit";
import { loadUserEnv } from "../../config/env.js";
import { createUserServer } from "./server.js";

const env = loadUserEnv();
await startHttpServer({
  moduleName: "kokoro-user",
  port: env.KOKORO_USER_PORT,
  createServer: () =>
    createUserServer({
      internalSecret: env.KOKORO_INTERNAL_SECRET,
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
