import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import type { PlatformDatabaseClient, PlatformDatabaseConfig } from
  "../infrastructure/postgres/client.js";
import type {
  ImageEffectPool,
  ImageEffectPoolClient,
} from "../modules/model-gateway/infrastructure/postgres/image-effect-postgres.js";
import {
  createModelImageWorkerProductionComposition,
  loadModelImageWorkerProductionAdapters,
} from "./model-image-worker-composition.js";
import { loadDedicatedWorkerDatabaseConfig } from "./dedicated-worker-database.js";
import { loadPlatformWorkerId } from "./worker.js";
import { hostPlatformWorkerProcess } from "./worker-process-host.js";
import {
  PLATFORM_MODEL_IMAGE_WORKER_DEPLOYMENT_CONTRACT,
  resolveProcessDeploymentEnvironment,
} from "./worker-deployment-contract.js";

export async function runPlatformModelImageWorkerMain(): Promise<void> {
  const environment = resolveProcessDeploymentEnvironment(
    PLATFORM_MODEL_IMAGE_WORKER_DEPLOYMENT_CONTRACT,
    process.env,
  );
  // The released artifact contains the independent process boundary, but no provider is silently selected.
  // This throws before allocating a database pool until a certified adapter release is pinned.
  const adapters = loadModelImageWorkerProductionAdapters(environment);
  const resources = createModelImageWorkerDatabase(
    loadDedicatedWorkerDatabaseConfig("model-image-worker", environment),
  );
  const runtime = createModelImageWorkerProductionComposition({ pool: resources.pool,
    workerId: loadPlatformWorkerId(environment),
    leaseMilliseconds: optionalLeaseMilliseconds(environment), adapters });
  await hostPlatformWorkerProcess({ processName: "Platform Model Image Worker",
    database: resources.database, runtime, environment });
}

export function createModelImageWorkerDatabase(config: PlatformDatabaseConfig): Readonly<{
  database: PlatformDatabaseClient;
  pool: ImageEffectPool;
}> {
  if (config.role !== "model-image-worker" || config.credentialClass !== "model-image-worker") {
    throw new Error("PLATFORM_MODEL_IMAGE_WORKER_DATABASE_CONFIG_INVALID");
  }
  const postgres = new Pool({ connectionString: config.url, max: config.pool.max,
    connectionTimeoutMillis: config.pool.connectionTimeoutMs,
    application_name: config.applicationName,
    options: `-c statement_timeout=${config.session.statementTimeoutMs}` +
      ` -c lock_timeout=${config.session.lockTimeoutMs}` +
      ` -c idle_in_transaction_session_timeout=${config.session.idleTransactionTimeoutMs}` });
  const pool: ImageEffectPool = Object.freeze({
    connect: async (): Promise<ImageEffectPoolClient> => {
      const client = await postgres.connect();
      return Object.freeze({
        query: async (text: string, values: readonly unknown[] = []) => {
          const result = await client.query<Record<string, unknown>>(text, [...values]);
          return Object.freeze({ rows: result.rows, rowCount: result.rowCount });
        },
        release: (destroy = false) => client.release(destroy),
      });
    },
    end: () => postgres.end(),
  });
  const assertIdentity = async (): Promise<void> => {
    const result = await postgres.query(
      `SELECT platform.assert_model_image_effect_runtime_role('worker'),
              current_database() AS "databaseName"`,
    );
    if (result.rows.length !== 1 || result.rows[0]?.databaseName !== config.expectedDatabaseName) {
      throw new Error("PLATFORM_MODEL_IMAGE_WORKER_DATABASE_IDENTITY_INVALID");
    }
  };
  const database: PlatformDatabaseClient = Object.freeze({
    connect: assertIdentity,
    disconnect: () => postgres.end(),
    checkHealth: assertIdentity,
  });
  return Object.freeze({ database, pool });
}

function optionalLeaseMilliseconds(environment: Readonly<Record<string, string | undefined>>): number {
  const value = environment.PLATFORM_MODEL_IMAGE_WORKER_LEASE_MILLISECONDS ?? "30000";
  if (!/^[0-9]+$/u.test(value)) throw new Error("PLATFORM_MODEL_IMAGE_WORKER_LEASE_MILLISECONDS_INVALID");
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 300_000) {
    throw new Error("PLATFORM_MODEL_IMAGE_WORKER_LEASE_MILLISECONDS_INVALID");
  }
  return parsed;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isMainModule()) runPlatformModelImageWorkerMain().catch((error: unknown) => {
  process.exitCode = 1;
  console.error("Platform Model Image Worker failed to start", error);
});
