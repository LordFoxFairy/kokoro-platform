import { startHttpServer } from "@kokoro/platform-kit";
import { loadUserEnv } from "../../config/env.js";
import { createUserServer } from "./server.js";

const env = loadUserEnv();
await startHttpServer({
  moduleName: "kokoro-user",
  port: env.KOKORO_USER_PORT,
  createServer: createUserServer,
});
