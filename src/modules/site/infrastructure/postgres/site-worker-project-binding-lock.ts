import type { PlatformSqlTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import type { DeploymentEnvironment } from "../../../../shared/deployment-environment.js";

export interface LockedSiteWorkerProjectBinding extends Record<string, unknown> {
  readonly bindingRef: string;
  readonly bindingEpoch: bigint;
  readonly providerNamespace: string;
  readonly providerProjectRef: string;
}

export interface LockedSiteWorkerRuntimeProjectBinding extends Record<string, unknown> {
  readonly bindingEpoch: bigint;
  readonly providerNamespace: string;
  readonly providerProjectRef: string;
}

export interface SiteWorkerProjectBindingLock {
  lockActive(
    sql: PlatformSqlTransaction,
    input: Readonly<{
      siteRef: string;
      environment: DeploymentEnvironment;
      region: string;
    }>,
  ): Promise<LockedSiteWorkerProjectBinding | null>;
  lockRuntime(
    sql: PlatformSqlTransaction,
    input: Readonly<{
      bindingRef: string;
      siteRef: string;
      bindingEpoch?: bigint;
      environment: DeploymentEnvironment;
      region: string;
    }>,
  ): Promise<LockedSiteWorkerRuntimeProjectBinding | null>;
}

export class PostgresSiteWorkerProjectBindingLock implements SiteWorkerProjectBindingLock {
  async lockActive(
    sql: PlatformSqlTransaction,
    input: Readonly<{
      siteRef: string;
      environment: DeploymentEnvironment;
      region: string;
    }>,
  ): Promise<LockedSiteWorkerProjectBinding | null> {
    const rows = await sql.query<LockedSiteWorkerProjectBinding>(
      `SELECT binding_ref AS "bindingRef",binding_epoch AS "bindingEpoch",
              provider_namespace AS "providerNamespace",
              provider_project_ref AS "providerProjectRef"
       FROM platform.lock_site_worker_project_binding($1,$2,$3)`,
      [input.siteRef, input.environment, input.region],
    );
    if (rows.length > 1) throw new Error("SITE_PROJECT_BINDING_CONFLICT");
    return rows[0] ?? null;
  }

  async lockRuntime(
    sql: PlatformSqlTransaction,
    input: Readonly<{
      bindingRef: string;
      siteRef: string;
      bindingEpoch?: bigint;
      environment: DeploymentEnvironment;
      region: string;
    }>,
  ): Promise<LockedSiteWorkerRuntimeProjectBinding | null> {
    const rows = await sql.query<LockedSiteWorkerRuntimeProjectBinding>(
      `SELECT binding_epoch AS "bindingEpoch",provider_namespace AS "providerNamespace",
              provider_project_ref AS "providerProjectRef"
       FROM platform.lock_site_worker_runtime_project_binding($1,$2,$3::bigint,$4,$5)`,
      [input.bindingRef, input.siteRef, input.bindingEpoch ?? null, input.environment, input.region],
    );
    if (rows.length > 1) throw new Error("SITE_RUNTIME_PROJECT_BINDING_CONFLICT");
    return rows[0] ?? null;
  }
}
