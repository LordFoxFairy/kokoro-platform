import {
  loadPlatformDatabaseConfig,
  type PlatformDatabaseConfig,
} from "../infrastructure/postgres/client.js";

export type DedicatedWorkerDatabaseRole =
  | "commerce-worker"
  | "site-worker"
  | "asset-worker"
  | "admin-worker"
  | "authorization-maintenance";

/** Shared typed entry point for independently deployed worker database credentials. */
export function loadDedicatedWorkerDatabaseConfig(
  role: DedicatedWorkerDatabaseRole,
  environment: Readonly<Record<string, string | undefined>>,
): PlatformDatabaseConfig {
  return loadPlatformDatabaseConfig(role, environment);
}
