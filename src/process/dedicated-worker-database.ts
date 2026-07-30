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

/** Integration seam for the separately reviewed least-privilege database-authority change. */
export function loadDedicatedWorkerDatabaseConfig(
  role: DedicatedWorkerDatabaseRole,
  environment: Readonly<Record<string, string | undefined>>,
): PlatformDatabaseConfig {
  return Reflect.apply(loadPlatformDatabaseConfig, undefined, [role, environment]) as PlatformDatabaseConfig;
}
