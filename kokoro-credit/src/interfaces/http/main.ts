import { startHttpServer } from "@kokoro/platform-kit";
import { loadCreditEnv } from "../../config/env.js";
import { createCreditServer } from "./server.js";

const env = loadCreditEnv();
await startHttpServer({
  moduleName: "kokoro-credit",
  port: env.KOKORO_CREDIT_PORT,
  createServer: createCreditServer,
});
