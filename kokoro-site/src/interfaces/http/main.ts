import { startHttpServer } from "@kokoro/platform-kit";
import { loadSiteEnv } from "../../config/env.js";
import { createSiteServer } from "./server.js";

const env = loadSiteEnv();
await startHttpServer({
  moduleName: "kokoro-site",
  port: env.KOKORO_SITE_PORT,
  createServer: createSiteServer,
});
