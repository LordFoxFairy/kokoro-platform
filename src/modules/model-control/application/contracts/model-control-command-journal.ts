import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type {
  ModelControlCommand,
  ModelControlCommandReceipt,
} from "../model-control-command.js";

/**
 * Composable local effect port. Implementations must persist command identity,
 * mutation outcome, and the event in the supplied Platform transaction; they
 * never dispatch to Gateway/cache/projectors before commit.
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
    trace: { readonly requestId: string; readonly correlationId: string },
  ): Promise<void>;
}
