import { isProductionEnv, loadCallerSecrets, startHttpServer } from "@kokoro/platform-kit";
import { loadUserEnv } from "../../config/env.js";
import { createUserServer } from "./server.js";

const env = loadUserEnv();
const callerSecrets = loadCallerSecrets();
const isProduction = isProductionEnv();
// 签发物料在此按 env 组装；档位裁决与生产 fail-fast 由 resolveSessionSigning 统一执行（server 内）。
// 配了私钥或 HS256 secret 才注入 sessionSigning；都没配（非生产）→ /auth/sessions 503。
const hasSigningMaterial =
  env.KOKORO_USER_JWT_PRIVATE_KEY !== undefined || env.KOKORO_AUTH_JWT_SECRET !== undefined;
await startHttpServer({
  moduleName: "kokoro-user",
  port: env.KOKORO_USER_PORT,
  createServer: () =>
    createUserServer({
      routeAccess: { secrets: callerSecrets, isProduction },
      magicLinks: {
        ttlSeconds: env.KOKORO_AUTH_MAGIC_TTL_SECONDS,
        deliveryMode: env.KOKORO_AUTH_MAGIC_DELIVERY,
        rateLimitMax: env.KOKORO_AUTH_MAGIC_RATE_MAX,
        rateLimitWindowSeconds: env.KOKORO_AUTH_MAGIC_RATE_WINDOW_SECONDS,
        ...(env.KOKORO_AUTH_MAGIC_RATE_IP_MAX !== undefined
          ? { rateLimitIpMax: env.KOKORO_AUTH_MAGIC_RATE_IP_MAX }
          : {}),
        ...(env.KOKORO_REDIS_URL ? { redisUrl: env.KOKORO_REDIS_URL } : {}),
      },
      teams: {
        inviteTtlSeconds: env.KOKORO_TEAM_INVITE_TTL_SECONDS,
      },
      // 生产未配私钥时，resolveSessionSigning 在此路径 fail-fast（isProduction=true）；
      // 因此即便只配了 HS256 secret，生产也会拒启动（HS256 不许生产签发）。
      ...(hasSigningMaterial || isProduction
        ? {
            sessionSigning: {
              ttlSeconds: env.KOKORO_AUTH_JWT_TTL_SECONDS,
              issuer: env.KOKORO_AUTH_JWT_ISSUER,
              refreshTtlSeconds: env.KOKORO_AUTH_REFRESH_TTL_SECONDS,
              isProduction,
              ...(env.KOKORO_AUTH_JWT_SECRET ? { secret: env.KOKORO_AUTH_JWT_SECRET } : {}),
              ...(env.KOKORO_USER_JWT_PRIVATE_KEY
                ? { privateKeyPem: env.KOKORO_USER_JWT_PRIVATE_KEY }
                : {}),
              ...(env.KOKORO_USER_JWT_PRIVATE_KEY_PREVIOUS
                ? { previousPrivateKeyPem: env.KOKORO_USER_JWT_PRIVATE_KEY_PREVIOUS }
                : {}),
            },
          }
        : {}),
    }),
});
