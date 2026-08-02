import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { CommerceLockSequence } from "../command-lock-order.js";

export interface CommerceCatalogPort {
  lockProgramAvailability(transaction: PlatformTransaction, locks: CommerceLockSequence, programVersion: string): Promise<void>;
  lockBatchAvailability(transaction: PlatformTransaction, locks: CommerceLockSequence, batchId: string): Promise<void>;
}
