import process from "node:process";
import { URL } from "node:url";

const serviceEntries = Object.freeze({
  "@kokoro/hub": { module: "../../kokoro-hub/dist/interfaces/http/main.js" },
  "platform-hub-connect": {
    module: "../../kokoro-hub/dist/interfaces/connect/main.js",
    start: "runHubConnectMain",
  },
  "platform-api": { module: "../../dist/src/process/api.js", start: "runPlatformApiMain" },
  "platform-admission": { module: "../../dist/src/process/admission.js", start: "runPlatformAdmissionMain" },
  "platform-authorization": { module: "../../dist/src/process/authorization.js", start: "runPlatformAuthorizationMain" },
  "platform-asset-data-plane": { module: "../../dist/src/process/asset-data-plane.js", start: "runAssetDataPlaneMain" },
  "platform-model-gateway": { module: "../../dist/src/process/model-gateway.js", start: "runPlatformModelGatewayMain" },
  "platform-admin": { module: "../../dist/src/process/admin.js", start: "runPlatformAdminMain" },
  "platform-worker": { module: "../../dist/src/process/worker.js", start: "runPlatformWorkerMain" },
  "platform-identity-worker": {
    module: "../../dist/src/process/identity-worker.js",
    start: "runPlatformIdentityWorkerMain",
  },
  "platform-migrator": {
    module: "../../dist/src/infrastructure/postgres/migrator.js",
    start: "runPlatformMigrations",
  },
});

const selected = process.env.KOKORO_SERVICE_PACKAGE ?? "platform-api";
const entry = serviceEntries[selected];
if (entry === undefined) {
  throw new Error(`Unsupported KOKORO_SERVICE_PACKAGE: ${selected}`);
}

const loaded = await import(new URL(entry.module, import.meta.url));
if (entry.start !== undefined) {
  const start = loaded[entry.start];
  if (typeof start !== "function") {
    throw new Error(`Missing runtime start export for ${selected}: ${entry.start}`);
  }
  await start();
}
