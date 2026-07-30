import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type {
  ModelControlCommand,
  ModelControlCommandReceipt,
} from "../model-control-command.js";

/**
 * Composable local command journal. Implementations persist command identity
 * and mutation outcome in the supplied Platform transaction. The immutable
 * owner tables remain the business facts; this journal does not duplicate them
 * into an outbox without a defined remote consumer.
 */
export interface ModelControlCommandJournal {
  begin(
    transaction: PlatformTransaction,
    command: ModelControlCommand,
  ): Promise<void>;
  succeed(
    transaction: PlatformTransaction,
    command: ModelControlCommand,
    receipt: ModelControlCommandReceipt,
  ): Promise<void>;
}
