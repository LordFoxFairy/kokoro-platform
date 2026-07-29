import type { CommandIdentity, CommandReceipt, JsonValue } from "../../../../shared/outbox-inbox/receipt.js";
import type { OutboxEvent } from "../../../../shared/outbox-inbox/outbox.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type { AssetUserAuthority } from "../asset-user-authority.js";
import type { AssetUploadSession } from "../../domain/upload-intent.js";

export interface AssetCompletionReceiptPort {
  begin(transaction: PlatformTransaction, identity: CommandIdentity): Promise<CommandReceipt>;
  recordOutcome(
    transaction: PlatformTransaction,
    identity: CommandIdentity,
    outcome: Readonly<{ state: "succeeded" | "failed" | "outcome_unknown"; result: JsonValue | null; resultDigest: string }>,
  ): Promise<CommandReceipt>;
}

export interface AssetCompletionOutboxPort {
  enqueue(transaction: PlatformTransaction, event: OutboxEvent): Promise<void>;
}

export interface AssetUploadCompletionRepositoryPort {
  beginCompletion(
    transaction: PlatformTransaction,
    input: Readonly<{
      authority: AssetUserAuthority;
      intentRef: string;
      sessionRef: string;
      expectedVersion: bigint;
    }>,
  ): Promise<AssetUploadSession>;
}
