import type { CommerceSubscriptionPort } from "../../application/contracts/subscription-port.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";

type BillingAuthorityRow = Record<string, unknown> & {
  readonly billingAccountId: string;
  readonly accountState: string;
  readonly aggregateVersion: bigint;
  readonly membershipState: string;
  readonly membershipEpoch: bigint;
  readonly subjectGeneration: bigint;
};

export class PostgresCommerceBillingAccountPort implements Pick<CommerceSubscriptionPort, "resolveBillingAccount"> {
  async resolveBillingAccount(
    transaction: Parameters<CommerceSubscriptionPort["resolveBillingAccount"]>[0],
    locks: Parameters<CommerceSubscriptionPort["resolveBillingAccount"]>[1],
    input: Parameters<CommerceSubscriptionPort["resolveBillingAccount"]>[2],
  ): ReturnType<CommerceSubscriptionPort["resolveBillingAccount"]> {
    locks.enter("billing_account");
    const rows = await resolvePlatformTransaction(transaction).query<BillingAuthorityRow>(
      `SELECT account.billing_account_ref AS "billingAccountId", account.state AS "accountState",
              account.aggregate_version AS "aggregateVersion", membership.state AS "membershipState",
              membership.membership_epoch AS "membershipEpoch",
              membership.subject_generation AS "subjectGeneration"
       FROM platform.commerce_billing_account_membership membership
       JOIN platform.commerce_billing_account account
         ON account.billing_account_ref=membership.billing_account_ref AND account.site_ref=membership.site_ref
       WHERE membership.site_ref=$1 AND membership.subject_ref=$2
         AND membership.is_default=TRUE
       FOR UPDATE OF account,membership`,
      [input.siteId, input.subjectId],
    );
    const row = rows[0];
    if (
      row === undefined || row.accountState !== "active" || row.membershipState !== "active" ||
      row.subjectGeneration.toString() !== input.subjectGeneration || row.aggregateVersion <= 0n || row.membershipEpoch <= 0n
    ) throw new Error("COMMERCE_EFFECT_NOT_AUTHORIZED");
    return Object.freeze({
      billingAccountId: row.billingAccountId,
      membershipEpoch: row.membershipEpoch.toString(),
      aggregateVersion: row.aggregateVersion.toString(),
    });
  }
}
