import type { PlatformTransaction } from "../unit-of-work/platform-transaction.js";
import { resolvePlatformTransaction } from "../unit-of-work/platform-transaction.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };
export type CommandReceiptState = "pending" | "succeeded" | "failed" | "outcome_unknown";

export interface CommandIdentity {
  readonly commandId: string;
  readonly environment: string;
  readonly region: string;
  readonly callerIdentity: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
}

export interface CommandReceipt extends CommandIdentity {
  readonly state: CommandReceiptState;
  readonly result: JsonValue | null;
  readonly resultDigest: string | null;
}

export class CommandReceiptRepository {
  async begin(transaction: PlatformTransaction, identity: CommandIdentity): Promise<CommandReceipt> {
    assertDigest(identity.requestDigest);
    const commandId = canonicalCommandId(identity.commandId);
    const sql = resolvePlatformTransaction(transaction);
    await sql.execute(
      `INSERT INTO platform.command_receipt
       (command_id, environment, region, caller_identity, operation, idempotency_key, request_digest)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (environment, caller_identity, operation, idempotency_key) DO NOTHING`,
      [commandId, identity.environment, identity.region, identity.callerIdentity,
        identity.operation, identity.idempotencyKey, identity.requestDigest],
    );
    const receipt = await this.#find(sql, identity);
    if (receipt.commandId !== commandId) throw new Error("COMMAND_IDENTITY_CONFLICT");
    if (receipt.requestDigest !== identity.requestDigest) throw new Error("COMMAND_DIGEST_CONFLICT");
    return receipt;
  }

  async recordOutcome(
    transaction: PlatformTransaction,
    identity: CommandIdentity,
    outcome: { readonly state: Exclude<CommandReceiptState, "pending">; readonly result: JsonValue | null; readonly resultDigest: string },
  ): Promise<CommandReceipt> {
    assertDigest(outcome.resultDigest);
    const sql = resolvePlatformTransaction(transaction);
    const receipt = await this.#find(sql, identity);
    if (receipt.commandId !== canonicalCommandId(identity.commandId)) {
      throw new Error("COMMAND_IDENTITY_CONFLICT");
    }
    if (receipt.requestDigest !== identity.requestDigest) throw new Error("COMMAND_DIGEST_CONFLICT");
    if (receipt.state !== "pending" && receipt.state !== "outcome_unknown") {
      if (receipt.state === outcome.state && receipt.resultDigest === outcome.resultDigest) return receipt;
      throw new Error("COMMAND_OUTCOME_CONFLICT");
    }
    await sql.execute(
      `UPDATE platform.command_receipt SET state=$1, result=$2::jsonb, result_digest=$3, updated_at=now()
       WHERE command_id=$4 AND request_digest=$5`,
      [outcome.state, JSON.stringify(outcome.result), outcome.resultDigest, receipt.commandId, identity.requestDigest],
    );
    return this.#find(sql, identity);
  }

  async #find(sql: ReturnType<typeof resolvePlatformTransaction>, identity: CommandIdentity): Promise<CommandReceipt> {
    const rows = await sql.query<ReceiptRow>(
      `SELECT command_id AS "commandId", environment, region, caller_identity AS "callerIdentity",
              operation, idempotency_key AS "idempotencyKey", request_digest AS "requestDigest",
              state, result, result_digest AS "resultDigest"
       FROM platform.command_receipt
       WHERE environment=$1 AND caller_identity=$2 AND operation=$3 AND idempotency_key=$4
       FOR UPDATE`,
      [identity.environment, identity.callerIdentity, identity.operation, identity.idempotencyKey],
    );
    const receipt = rows[0];
    if (!receipt) throw new Error("COMMAND_RECEIPT_NOT_FOUND");
    return receipt;
  }
}

type ReceiptRow = CommandReceipt & Record<string, unknown>;

export function assertDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("SHA256_DIGEST_REQUIRED");
}

export function canonicalCommandId(value: string): string {
  const normalized = value.toLowerCase();
  if (/^[a-f0-9]{32}$/u.test(normalized) || /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(normalized)) {
    return normalized;
  }
  throw new Error("COMMAND_ID_INVALID");
}
