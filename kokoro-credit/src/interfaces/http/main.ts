import { startHttpServer } from "@kokoro/platform-kit";
import { loadCreditEnv } from "../../config/env.js";
import { HttpOwnerSiteChecker } from "../../infrastructure/http/owner-site-checker.js";
import { createCreditServer } from "./server.js";

const env = loadCreditEnv();
// 生产启用跨服务 enforcement：记账前校验 owner/site active。
const activeChecker = new HttpOwnerSiteChecker(
  env.KOKORO_USER_BASE_URL,
  env.KOKORO_SITE_BASE_URL,
  env.KOKORO_INTERNAL_SECRET,
);
await startHttpServer({
  moduleName: "kokoro-credit",
  port: env.KOKORO_CREDIT_PORT,
  createServer: () => createCreditServer({ activeChecker }),
});
