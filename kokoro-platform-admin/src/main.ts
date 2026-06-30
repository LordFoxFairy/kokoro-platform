import { startHttpServer } from "@kokoro/platform-kit";
import { loadConfig } from "./config.js";
import { createAdminServer } from "./server.js";

const config = loadConfig();
await startHttpServer({
  moduleName: "kokoro-platform-admin",
  port: config.adminPort,
  createServer: () => createAdminServer(config.modules),
});
