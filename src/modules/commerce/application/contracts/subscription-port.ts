import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { CommerceLockSequence } from "../command-lock-order.js";

export interface CommerceSubscriptionPort {
  resolveBillingAccount(transaction: PlatformTransaction, locks: CommerceLockSequence, input: { readonly siteId: string; readonly subjectId: string; readonly subjectGeneration: string }): Promise<{ readonly billingAccountId: string; readonly membershipEpoch: string; readonly aggregateVersion: string }>;
  lockSubscription(transaction: PlatformTransaction, locks: CommerceLockSequence, input: { readonly billingAccountId: string; readonly serviceScope: string }): Promise<void>;
  lockTermAllocation(transaction: PlatformTransaction, locks: CommerceLockSequence, subscriptionId: string): Promise<void>;
}
