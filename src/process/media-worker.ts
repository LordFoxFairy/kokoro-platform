import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PlatformDatabaseClient } from "../infrastructure/postgres/client.js";
import {
  assertMediaWorkerGeneratedContractsAvailable,
  type MediaWorkerApplicationComposition,
} from "./media-worker-composition.js";
import { hostPlatformWorkerProcess } from "./worker-process-host.js";
import {
  PLATFORM_MEDIA_WORKER_DEPLOYMENT_CONTRACT,
  resolveProcessDeploymentEnvironment,
} from "./worker-deployment-contract.js";

export function hostPlatformMediaWorker(input: Readonly<{
  database: PlatformDatabaseClient;
  runtime: MediaWorkerApplicationComposition;
  environment: Readonly<Record<string, string | undefined>>;
}>): Promise<void> {
  return hostPlatformWorkerProcess({ processName: "Platform Media Worker", database: input.database,
    runtime: input.runtime, environment: input.environment });
}

/**
 * Deliberately fails before opening PostgreSQL while Root-generated image-effect/output-data-plane,
 * Session projection, capability-envelope, and canonical-receipt contracts are absent.
 */
export async function runPlatformMediaWorkerMain(): Promise<void> {
  resolveProcessDeploymentEnvironment(PLATFORM_MEDIA_WORKER_DEPLOYMENT_CONTRACT, process.env);
  assertMediaWorkerGeneratedContractsAvailable({ imageEffectConnectClient: false,
    imageOutputDataPlaneClient: false, sessionProjectionClient: false, canonicalReceiptHelpers: false,
    capabilityEnvelopeOpener: false });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}
if (isMainModule()) runPlatformMediaWorkerMain().catch((error: unknown) => {
  process.exitCode = 1; console.error("Platform Media Worker failed to start", error);
});
