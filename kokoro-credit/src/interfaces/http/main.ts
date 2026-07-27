import { isProductionEnv, loadCallerSecrets, startHttpServer } from "@kokoro/platform-kit";
import type { RunBillingConfig } from "../../application/credit-service.js";
import { loadCreditEnv } from "../../config/env.js";
import { HttpOwnerSiteChecker } from "../../infrastructure/http/owner-site-checker.js";
import { createCreditServer } from "./server.js";

const env = loadCreditEnv();
const callerSecrets = loadCallerSecrets();
// credit 出站身份=credit；调 user/site active 时带 x-kokoro-service:credit + 该 caller secret。
// 未配即不带该头：接收端只认 per-caller secret，空值头一律 401。
const creditOutboundSecret = callerSecrets.credit;
// 生产启用跨服务 enforcement：记账前校验 owner/site active。
const activeChecker = new HttpOwnerSiteChecker(
  env.KOKORO_USER_BASE_URL,
  env.KOKORO_SITE_BASE_URL,
  creditOutboundSecret,
  undefined,
  {
    ttlMs: env.KOKORO_CREDIT_ACTIVE_CACHE_TTL_SECONDS * 1000,
    maxEntries: env.KOKORO_CREDIT_ACTIVE_CACHE_MAX_ENTRIES,
  },
);
const runBilling: RunBillingConfig = {
  inputUnit: env.KOKORO_CREDIT_USAGE_INPUT_UNIT,
  outputUnit: env.KOKORO_CREDIT_USAGE_OUTPUT_UNIT,
  estInputTokens: String(env.KOKORO_CREDIT_HOLD_EST_INPUT_TOKENS),
  estOutputTokens: String(env.KOKORO_CREDIT_HOLD_EST_OUTPUT_TOKENS),
  bufferPercent: env.KOKORO_CREDIT_HOLD_BUFFER_PERCENT,
  holdTtlSeconds: env.KOKORO_CREDIT_HOLD_TTL_SECONDS,
};
const sweepIntervalMs = env.KOKORO_CREDIT_HOLD_SWEEP_INTERVAL_SECONDS * 1000;
await startHttpServer({
  moduleName: "kokoro-credit",
  port: env.KOKORO_CREDIT_PORT,
  createServer: () =>
    createCreditServer({
      activeChecker,
      runBilling,
      sweepIntervalMs,
      welcomeGrantMicros: BigInt(env.KOKORO_CREDIT_WELCOME_MICROS),
      routeAccess: { secrets: callerSecrets, isProduction: isProductionEnv() },
    }),
});
