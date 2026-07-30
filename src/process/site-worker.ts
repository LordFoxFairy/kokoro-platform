import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPlatformDatabaseClient } from "../infrastructure/postgres/client.js";
import { loadDedicatedWorkerDatabaseConfig } from "./dedicated-worker-database.js";
import { createSiteRuntimeWorkerProductionComposition } from "./site-runtime-worker-composition.js";
import { loadPlatformWorkerId } from "./worker.js";
import { hostPlatformWorkerProcess } from "./worker-process-host.js";
import { PLATFORM_SITE_WORKER_DEPLOYMENT_CONTRACT, resolveProcessDeploymentEnvironment } from
  "./worker-deployment-contract.js";

export async function runPlatformSiteWorkerMain(): Promise<void> {
  const environment = resolveProcessDeploymentEnvironment(PLATFORM_SITE_WORKER_DEPLOYMENT_CONTRACT, process.env);
  const database = createPlatformDatabaseClient(loadDedicatedWorkerDatabaseConfig("site-worker", environment));
  const siteRuntime = await createSiteRuntimeWorkerProductionComposition({ database,
    workerId: loadPlatformWorkerId(environment), environment });
  await hostPlatformWorkerProcess({ processName: "Platform Site Worker", database,
    runtime: { runOneCycle: siteRuntime.runOneCycle, stopClaiming: siteRuntime.stopClaiming,
      returnLeases: siteRuntime.returnLease }, environment });
}

function isMainModule(): boolean { const entry = process.argv[1]; return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url; }
if (isMainModule()) runPlatformSiteWorkerMain().catch((error: unknown) => {
  process.exitCode = 1; console.error("Platform Site Worker failed to start", error);
});
