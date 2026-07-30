import type { PlatformDatabaseClient } from "../infrastructure/postgres/client.js";
import { createPlatformWorkerHealthServer, loadPlatformWorkerHealthPort } from "./worker-health-server.js";
import {
  createPlatformWorkerProcess,
  shutdownPlatformWorkerRuntime,
  type PlatformWorkerCycleContext,
} from "./worker.js";

export interface PlatformWorkerRuntimeAdapter {
  runOneCycle(context: PlatformWorkerCycleContext): Promise<void>;
  stopClaiming(): Promise<void>;
  returnLeases(reason: "shutdown" | "shutdown-deadline" | "stop-claim-failed"): Promise<void>;
}

export async function hostPlatformWorkerProcess(input: Readonly<{
  processName: string;
  database: PlatformDatabaseClient;
  runtime: PlatformWorkerRuntimeAdapter;
  environment: Readonly<Record<string, string | undefined>>;
}>): Promise<void> {
  const worker = createPlatformWorkerProcess({
    database: input.database,
    runOneCycle: (context) => input.runtime.runOneCycle(context),
    stopClaiming: () => input.runtime.stopClaiming(),
    returnLease: (reason) => input.runtime.returnLeases(reason),
    onCycleError: (error) => console.error(`${input.processName} cycle failed`, error),
  });
  const health = createPlatformWorkerHealthServer({
    status: worker.status,
    port: loadPlatformWorkerHealthPort(input.environment),
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
      console.error(`${input.processName} failed to drain`, error);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  console.log(`${input.processName} ready`);
}
