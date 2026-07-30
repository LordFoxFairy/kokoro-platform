import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPlatformDatabaseClient } from "../infrastructure/postgres/client.js";
import { createAssetWorkerProductionComposition, loadAssetWorkerProductionAdapters } from
  "./asset-worker-composition.js";
import { loadDedicatedWorkerDatabaseConfig } from "./dedicated-worker-database.js";
import { loadPlatformWorkerId } from "./worker.js";
import { hostPlatformWorkerProcess } from "./worker-process-host.js";
import { PLATFORM_ASSET_WORKER_DEPLOYMENT_CONTRACT, resolveProcessDeploymentEnvironment } from
  "./worker-deployment-contract.js";

export async function runPlatformAssetWorkerMain(): Promise<void> {
  const environment = resolveProcessDeploymentEnvironment(PLATFORM_ASSET_WORKER_DEPLOYMENT_CONTRACT, process.env);
  const database = createPlatformDatabaseClient(loadDedicatedWorkerDatabaseConfig("asset-worker", environment));
  const adapters = await loadAssetWorkerProductionAdapters(environment);
  const assetRuntime = await createAssetWorkerProductionComposition({ database,
    workerId: loadPlatformWorkerId(environment), environment, adapters });
  await hostPlatformWorkerProcess({ processName: "Platform Asset Worker", database,
    runtime: assetRuntime, environment });
}

function isMainModule(): boolean { const entry = process.argv[1]; return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url; }
if (isMainModule()) runPlatformAssetWorkerMain().catch((error: unknown) => {
  process.exitCode = 1; console.error("Platform Asset Worker failed to start", error);
});
