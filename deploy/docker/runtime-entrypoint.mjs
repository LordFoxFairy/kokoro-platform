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
  "platform-artifact-data-plane": {
    module: "../../dist/src/process/artifact-data-plane.js",
    start: "runArtifactDataPlaneMain",
  },
  "platform-model-gateway": { module: "../../dist/src/process/model-gateway.js", start: "runPlatformModelGatewayMain" },
  "platform-admin": { module: "../../dist/src/process/admin.js", start: "runPlatformAdminMain" },
  "platform-commerce-worker": {
    module: "../../dist/src/process/commerce-worker.js",
    start: "runPlatformCommerceWorkerMain",
  },
  "platform-site-worker": {
    module: "../../dist/src/process/site-worker.js",
    start: "runPlatformSiteWorkerMain",
  },
  "platform-asset-worker": {
    module: "../../dist/src/process/asset-worker.js",
    start: "runPlatformAssetWorkerMain",
  },
  "platform-admin-worker": {
    module: "../../dist/src/process/admin-worker.js",
    start: "runPlatformAdminWorkerMain",
  },
  "platform-identity-worker": {
    module: "../../dist/src/process/identity-worker.js",
    start: "runPlatformIdentityWorkerMain",
  },
  "platform-media-worker": {
    module: "../../dist/src/process/media-worker.js",
    start: "runPlatformMediaWorkerMain",
  },
  "platform-model-image-worker": {
    module: "../../dist/src/process/model-image-worker.js",
    start: "runPlatformModelImageWorkerMain",
  },
  "platform-authorization-maintenance": {
    module: "../../dist/src/process/authorization-maintenance.js",
    start: "runPlatformAuthorizationMaintenanceMain",
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
