import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPlatformDatabaseClient } from "../infrastructure/postgres/client.js";
import { createAdminTerminalizerCycle } from "../modules/admin-control/application/admin-terminalizer.js";
import { PostgresAdminAuthorityRepository } from
  "../modules/admin-control/infrastructure/postgres/admin-authority-repository.js";
import { createAdminWorkerExecutionRuntime } from
  "../modules/admin-control/infrastructure/postgres/admin-worker-composition.js";
import { loadDedicatedWorkerDatabaseConfig } from "./dedicated-worker-database.js";
import { loadPlatformWorkerId, runPlatformWorkerActivities } from "./worker.js";
import { hostPlatformWorkerProcess } from "./worker-process-host.js";
import { PLATFORM_ADMIN_WORKER_DEPLOYMENT_CONTRACT, resolveProcessDeploymentEnvironment } from
  "./worker-deployment-contract.js";

export async function runPlatformAdminWorkerMain(): Promise<void> {
  const environment = resolveProcessDeploymentEnvironment(PLATFORM_ADMIN_WORKER_DEPLOYMENT_CONTRACT, process.env);
  const database = createPlatformDatabaseClient(loadDedicatedWorkerDatabaseConfig("admin-worker", environment));
  const terminalize = createAdminTerminalizerCycle({ database, repository: new PostgresAdminAuthorityRepository() });
  const execution = createAdminWorkerExecutionRuntime({ database, workerId: loadPlatformWorkerId(environment) });
  await hostPlatformWorkerProcess({ processName: "Platform Admin Worker", database,
    runtime: { runOneCycle: (context) => runPlatformWorkerActivities(context,
      [terminalize, execution.runOneCycle]), stopClaiming: execution.stopClaiming,
      returnLeases: execution.returnLeases }, environment });
}

function isMainModule(): boolean { const entry = process.argv[1]; return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url; }
if (isMainModule()) runPlatformAdminWorkerMain().catch((error: unknown) => {
  process.exitCode = 1; console.error("Platform Admin Worker failed to start", error);
});
