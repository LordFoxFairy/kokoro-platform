import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createPlatformDatabaseClient,
  loadPlatformDatabaseConfig,
} from "../infrastructure/postgres/client.js";
import { createIdentityOutboxWorkerProductionComposition } from
  "./identity-outbox-worker-composition.js";
import {
  createPlatformWorkerProcess,
  loadPlatformWorkerId,
  shutdownPlatformWorkerRuntime,
} from "./worker.js";
import {
  createPlatformWorkerHealthServer,
  loadPlatformWorkerHealthPort,
} from "./worker-health-server.js";
import {
  PLATFORM_IDENTITY_WORKER_DEPLOYMENT_CONTRACT,
  resolveProcessDeploymentEnvironment,
} from "./worker-deployment-contract.js";

export async function runPlatformIdentityWorkerMain(): Promise<void> {
  const environment = resolveProcessDeploymentEnvironment(
    PLATFORM_IDENTITY_WORKER_DEPLOYMENT_CONTRACT,
    process.env,
  );
  const database = createPlatformDatabaseClient(
    loadPlatformDatabaseConfig("identity-worker", environment),
  );
  const identity = await createIdentityOutboxWorkerProductionComposition({
    database,
    workerId: loadPlatformWorkerId(environment),
    environment,
  });
  const worker = createPlatformWorkerProcess({
    database,
    runOneCycle: (context) => identity.runOneCycle(context),
    stopClaiming: () => identity.stopClaiming(),
    returnLease: (reason) => identity.returnLeases(reason),
    onCycleError: (error) => console.error("Platform Identity Worker cycle failed", error),
  });
  const health = createPlatformWorkerHealthServer({
    status: worker.status,
    port: loadPlatformWorkerHealthPort(environment),
  });
  await worker.start();
  try {
    await health.start();
  } catch (error) {
    await worker.shutdown();
    throw error;
  }
  const shutdown = () => {
    void shutdownPlatformWorkerRuntime(worker, health).catch((error: unknown) => {
      process.exitCode = 1;
      console.error("Platform Identity Worker failed to drain", error);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  console.log("Platform Identity Worker ready");
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  runPlatformIdentityWorkerMain().catch((error: unknown) => {
    process.exitCode = 1;
    console.error("Platform Identity Worker failed to start", error);
  });
}
