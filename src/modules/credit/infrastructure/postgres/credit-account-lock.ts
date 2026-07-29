import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";

export type CreditAccountAuthorityIdentity = Readonly<{
  siteId: string;
  billingAccountId: string;
  unit: string;
  liabilityMerchantAccountId: string;
}>;

export type LockedCreditAccount = Readonly<{
  creditAccountId: string;
  state: "active" | "suspended" | "closed";
  aggregateVersion: bigint;
}>;

/**
 * Sole lock primitive for every native CreditAccount/Grant/Journal writer.
 * The natural authority identity is used so account creation and later writes share one fence.
 */
export async function lockCreditAccountAuthority(
  transaction: PlatformTransaction,
  identity: CreditAccountAuthorityIdentity,
): Promise<LockedCreditAccount | null> {
  const sql = resolvePlatformTransaction(transaction);
  await sql.query<Record<string, unknown>>(
    `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,0))`,
    [creditAccountAdvisoryKey(identity)],
  );
  const rows = await sql.query<Record<string, unknown> & {
    creditAccountId: string;
    state: LockedCreditAccount["state"];
    aggregateVersion: bigint | string;
  }>(
    `SELECT credit_account_ref AS "creditAccountId",state,aggregate_version AS "aggregateVersion"
     FROM platform.credit_account
     WHERE site_ref=$1 AND billing_account_ref=$2 AND unit=$3 AND liability_merchant_account_ref=$4
     FOR UPDATE`,
    [identity.siteId, identity.billingAccountId, identity.unit, identity.liabilityMerchantAccountId],
  );
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error("CREDIT_ACCOUNT_IDENTITY_AMBIGUOUS");
  const row = rows[0]!;
  return Object.freeze({ creditAccountId: row.creditAccountId, state: row.state,
    aggregateVersion: BigInt(row.aggregateVersion) });
}

export function creditAccountAdvisoryKey(identity: CreditAccountAuthorityIdentity): string {
  return `credit-account|${identity.siteId}|${identity.billingAccountId}|${identity.unit}|${identity.liabilityMerchantAccountId}`;
}
