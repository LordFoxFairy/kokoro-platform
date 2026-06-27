import { startHttpServer } from "@kokoro/platform-kit";
import { loadModelEnv } from "../../config/env.js";
import { createModelServer } from "./server.js";

const env = loadModelEnv();
await startHttpServer({
  moduleName: "kokoro-model",
  port: env.KOKORO_MODEL_PORT,
  createServer: createModelServer,
});
