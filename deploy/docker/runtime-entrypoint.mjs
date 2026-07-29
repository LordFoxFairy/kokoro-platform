import process from "node:process";
import { URL } from "node:url";

const serviceEntries = Object.freeze({
  "@kokoro/site": { module: "../../kokoro-site/dist/interfaces/http/main.js" },
  "@kokoro/user": { module: "../../kokoro-user/dist/interfaces/http/main.js" },
  "@kokoro/model": { module: "../../kokoro-model/dist/interfaces/http/main.js" },
  "@kokoro/credit": { module: "../../kokoro-credit/dist/interfaces/http/main.js" },
  "@kokoro/payment": { module: "../../kokoro-payment/dist/interfaces/http/main.js" },
  "@kokoro/hub": { module: "../../kokoro-hub/dist/interfaces/http/main.js" },
  "@kokoro/platform-admin": { module: "../../kokoro-platform-admin/dist/main.js" },
  "platform-api": { module: "../../dist/src/process/api.js", start: "runPlatformApiMain" },
  "platform-admission": { module: "../../dist/src/process/admission.js", start: "runPlatformAdmissionMain" },
  "platform-authorization": { module: "../../dist/src/process/authorization.js", start: "runPlatformAuthorizationMain" },
  "platform-admin": { module: "../../dist/src/process/admin.js", start: "runPlatformAdminMain" },
  "platform-worker": { module: "../../dist/src/process/worker.js", start: "runPlatformWorkerMain" },
  "platform-migrator": {
    module: "../../dist/src/infrastructure/postgres/migrator.js",
    start: "runPlatformMigrations",
  },
});

const selected = process.env.KOKORO_SERVICE_PACKAGE ?? "@kokoro/user";
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
