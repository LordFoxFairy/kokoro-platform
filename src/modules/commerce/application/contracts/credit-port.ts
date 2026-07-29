import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { CommerceLockSequence } from "../../../../workflows/commerce/lock-order.js";

export interface CommerceCreditPort {
  lockCreditAccount(transaction: PlatformTransaction, locks: CommerceLockSequence, creditAccountId: string): Promise<void>;
  lockCreditGrants(transaction: PlatformTransaction, locks: CommerceLockSequence, creditAccountId: string): Promise<void>;
  lockCreditHold(transaction: PlatformTransaction, locks: CommerceLockSequence, holdId: string): Promise<void>;
  lockHoldAllocations(transaction: PlatformTransaction, locks: CommerceLockSequence, holdId: string): Promise<void>;
}
