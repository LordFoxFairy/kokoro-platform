import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPlatformDatabaseClient } from "../infrastructure/postgres/client.js";
import { createCommerceOutboxReconciliationCycle, HmacHttpOutboxDeliveryTransport } from
  "../modules/commerce/infrastructure/postgres/commerce-outbox-reconciler.js";
import { createBoundedFileReaderWithinTrustRoot } from "./secret-files.js";
import { loadDedicatedWorkerDatabaseConfig } from "./dedicated-worker-database.js";
import { loadPlatformWorkerId } from "./worker.js";
import { hostPlatformWorkerProcess } from "./worker-process-host.js";
import { PLATFORM_COMMERCE_WORKER_DEPLOYMENT_CONTRACT, resolveProcessDeploymentEnvironment } from
  "./worker-deployment-contract.js";

export async function runPlatformCommerceWorkerMain(): Promise<void> {
  const environment = resolveProcessDeploymentEnvironment(PLATFORM_COMMERCE_WORKER_DEPLOYMENT_CONTRACT, process.env);
  const database = createPlatformDatabaseClient(loadDedicatedWorkerDatabaseConfig("commerce-worker", environment));
  const secretReader = await createBoundedFileReaderWithinTrustRoot(
    required(environment, "PLATFORM_COMMERCE_WORKER_SECRET_TRUST_ROOT"),
    "PLATFORM_COMMERCE_WORKER_SECRET_TRUST_ROOT_INVALID",
  );
  const secretBase64 = (await secretReader.readPrivate(
    required(environment, "PLATFORM_COMMERCE_OUTBOX_DELIVERY_SECRET_FILE"), 512,
    "PLATFORM_COMMERCE_OUTBOX_DELIVERY_SECRET_FILE_INVALID",
  )).trim();
  const commerce = createCommerceOutboxReconciliationCycle({ database,
    transport: new HmacHttpOutboxDeliveryTransport({
      endpoint: required(environment, "PLATFORM_OUTBOX_DELIVERY_ENDPOINT"),
      keyId: required(environment, "PLATFORM_OUTBOX_DELIVERY_KEY_ID"), secretBase64,
      timeoutMs: boundedInteger(environment.PLATFORM_OUTBOX_DELIVERY_TIMEOUT_MS ?? "10000", 100, 60_000,
        "PLATFORM_OUTBOX_DELIVERY_TIMEOUT_MS_INVALID"),
    }), workerId: loadPlatformWorkerId(environment) });
  await hostPlatformWorkerProcess({ processName: "Platform Commerce Worker", database,
    runtime: { runOneCycle: commerce.runOneCycle, stopClaiming: commerce.stopClaiming,
      returnLeases: commerce.returnLeases }, environment });
}

function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name]; if (value === undefined || value.length === 0) throw new Error(`${name}_REQUIRED`); return value;
}
function boundedInteger(value: string, minimum: number, maximum: number, code: string): number {
  if (!/^[0-9]+$/u.test(value)) throw new Error(code); const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(code); return parsed;
}
function isMainModule(): boolean { const entry = process.argv[1]; return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url; }
if (isMainModule()) runPlatformCommerceWorkerMain().catch((error: unknown) => {
  process.exitCode = 1; console.error("Platform Commerce Worker failed to start", error);
});
