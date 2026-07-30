import type { PlatformSqlTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";

export interface AdminWorkerOperatorAuthorityRow extends Record<string, unknown> {
  readonly operatorRef: string;
  readonly operatorGeneration: bigint | string;
  readonly state: string;
  readonly permissions: readonly string[];
  readonly siteScopes: readonly string[];
  readonly globalScopes: readonly string[];
  readonly environments: readonly string[];
  readonly regions: readonly string[];
  readonly authorizationEpoch: bigint | string;
  readonly expiresAt: Date | string;
  readonly breakGlassExpiresAt: Date | string | null;
}

export interface AdminWorkerOperatorAuthorityLock {
  lock(
    sql: PlatformSqlTransaction,
    input: Readonly<{ operatorRef: string; operatorGeneration: bigint }>,
  ): Promise<AdminWorkerOperatorAuthorityRow | null>;
}

export class PostgresAdminWorkerOperatorAuthorityLock
implements AdminWorkerOperatorAuthorityLock {
  async lock(
    sql: PlatformSqlTransaction,
    input: Readonly<{ operatorRef: string; operatorGeneration: bigint }>,
  ): Promise<AdminWorkerOperatorAuthorityRow | null> {
    const authorityRows = await sql.query<AdminWorkerOperatorAuthorityRow>(
      `SELECT operator_ref AS "operatorRef",operator_generation AS "operatorGeneration",
              state,permissions,site_scopes AS "siteScopes",global_scopes AS "globalScopes",
              environments,regions,authorization_epoch AS "authorizationEpoch",
              expires_at AS "expiresAt",break_glass_expires_at AS "breakGlassExpiresAt"
       FROM platform.lock_admin_worker_operator_authority($1,$2::bigint)`,
      [input.operatorRef, input.operatorGeneration],
    );
    const authority = authorityRows[0];
    if (authority === undefined) return null;
    return Object.freeze({ ...authority });
  }
}
