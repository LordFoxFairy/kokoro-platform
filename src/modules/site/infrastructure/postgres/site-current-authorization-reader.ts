import type { SiteCurrentFact } from
  "../../../authorization/application/contracts/scoped-session-authorization-port.js";
import type { SiteCurrentAuthorizationReader } from
  "../../application/services/site-current-authorization-mutation.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";

interface SiteCurrentRow extends Record<string, unknown> {
  readonly siteRef: string;
  readonly state: string;
  readonly siteSecurityEpoch: bigint;
  readonly policyEpoch: bigint;
  readonly revocationEpoch: bigint;
  readonly updatedAt: string | Date;
  readonly retainUntil: string | Date;
}

export class PostgresSiteCurrentAuthorizationReader implements SiteCurrentAuthorizationReader {
  async loadSiteCurrent(
    transaction: PlatformTransaction,
    siteRef: string,
  ): Promise<SiteCurrentFact | null> {
    const rows = await resolvePlatformTransaction(transaction).query<SiteCurrentRow>(
      `SELECT site_ref AS "siteRef",state,security_epoch AS "siteSecurityEpoch",
              policy_epoch AS "policyEpoch",revocation_epoch AS "revocationEpoch",
              updated_at AS "updatedAt",updated_at+interval '5 minutes' AS "retainUntil"
       FROM platform.authorization_site WHERE site_ref=$1 FOR SHARE`,
      [siteRef],
    );
    if (rows.length > 1) throw new Error("SITE_AUTHORIZATION_CURRENT_CONFLICT");
    const row = rows[0];
    if (row === undefined) return null;
    return Object.freeze({
      siteRef: row.siteRef,
      state: state(row.state),
      siteSecurityEpoch: row.siteSecurityEpoch.toString(),
      policyEpoch: row.policyEpoch.toString(),
      revocationEpoch: row.revocationEpoch.toString(),
      updatedAt: instant(row.updatedAt),
      retainUntil: instant(row.retainUntil),
    });
  }
}

function state(value: string): SiteCurrentFact["state"] {
  if (value === "active" || value === "suspended" ||
      value === "decommissioning" || value === "decommissioned") return value;
  throw new Error("SITE_AUTHORIZATION_CURRENT_STATE_INVALID");
}

function instant(value: string | Date): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("SITE_AUTHORIZATION_CURRENT_TIME_INVALID");
  return parsed.toISOString();
}
