import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPlatformDatabaseClient } from "../infrastructure/postgres/client.js";
import { createAuthorizationRetentionRunOnce } from
  "../modules/authorization/infrastructure/postgres/authorization-retention.js";
import { loadDedicatedWorkerDatabaseConfig } from "./dedicated-worker-database.js";
import { PLATFORM_AUTHORIZATION_MAINTENANCE_DEPLOYMENT_CONTRACT,
  resolveProcessDeploymentEnvironment } from "./worker-deployment-contract.js";

export async function runPlatformAuthorizationMaintenanceMain(): Promise<void> {
  const environment = resolveProcessDeploymentEnvironment(
    PLATFORM_AUTHORIZATION_MAINTENANCE_DEPLOYMENT_CONTRACT, process.env);
  const database = createPlatformDatabaseClient(
    loadDedicatedWorkerDatabaseConfig("authorization-maintenance", environment));
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("AUTHORIZATION_MAINTENANCE_DRAINING"));
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  try {
    await database.connect();
    await database.checkHealth();
    const retentionDays = boundedInteger(environment.PLATFORM_AUTHORIZATION_EVENT_RETENTION_DAYS ?? "7",
      1, 30, "PLATFORM_AUTHORIZATION_EVENT_RETENTION_DAYS_INVALID");
    await createAuthorizationRetentionRunOnce({ database,
      retentionMs: retentionDays * 24 * 60 * 60_000 })({ signal: controller.signal });
  } finally {
    process.off("SIGINT", abort); process.off("SIGTERM", abort); await database.disconnect();
  }
}

function boundedInteger(value: string, minimum: number, maximum: number, code: string): number {
  if (!/^[0-9]+$/u.test(value)) throw new Error(code); const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(code); return parsed;
}
function isMainModule(): boolean { const entry = process.argv[1]; return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url; }
if (isMainModule()) runPlatformAuthorizationMaintenanceMain().catch((error: unknown) => {
  process.exitCode = 1; console.error("Platform Authorization Maintenance failed", error);
});
