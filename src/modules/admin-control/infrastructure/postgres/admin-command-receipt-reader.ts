import {
  assertDigest,
  canonicalCommandId,
  type CommandReceipt,
} from "../../../../shared/outbox-inbox/receipt.js";
import type { VerifiedRequestSecurityContext } from
  "../../../../shared/security-context/index.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import type { AdminUnitOfWorkPort } from "../../application/admin-command-service.js";

export interface AdminCommandReceiptRecord extends CommandReceipt {
  readonly recordedAt: string;
}

export interface AdminCommandReceiptReaderPort {
  read(
    context: VerifiedRequestSecurityContext,
    input: Readonly<{ commandId: string; requestDigest: string; operation: string }>,
  ): Promise<AdminCommandReceiptRecord>;
}

export class PostgresAdminCommandReceiptReader implements AdminCommandReceiptReaderPort {
  constructor(private readonly unitOfWork: AdminUnitOfWorkPort) {}

  read(
    context: VerifiedRequestSecurityContext,
    input: Readonly<{ commandId: string; requestDigest: string; operation: string }>,
  ): Promise<AdminCommandReceiptRecord> {
    const commandId = canonicalCommandId(input.commandId);
    assertDigest(input.requestDigest);
    return this.unitOfWork.execute(
      { context, operation: input.operation },
      (transaction) => this.find(transaction, context, commandId, input.requestDigest),
    );
  }

  private async find(
    transaction: PlatformTransaction,
    context: VerifiedRequestSecurityContext,
    commandId: string,
    requestDigest: string,
  ): Promise<AdminCommandReceiptRecord> {
    const callerIdentity = `${context.trustedCaller.workloadIdentityId}:${context.actor.subjectId}:${context.actor.subjectGeneration}`;
    const rows = await resolvePlatformTransaction(transaction).query<ReceiptRow>(
      `SELECT command_id::text AS "commandId",environment,region,
              caller_identity AS "callerIdentity",operation,
              idempotency_key AS "idempotencyKey",request_digest AS "requestDigest",
              state,result,result_digest AS "resultDigest",updated_at AS "recordedAt"
       FROM platform.command_receipt
       WHERE command_id=$1::uuid AND request_digest=$2 AND environment=$3 AND region=$4
         AND caller_identity=$5
       LIMIT 1`,
      [commandId, requestDigest, context.environment, context.region, callerIdentity],
    );
    const row = rows[0];
    if (row === undefined) throw new Error("ADMIN_RECEIPT_NOT_FOUND");
    if (!["pending", "succeeded", "failed", "outcome_unknown"].includes(row.state)) {
      throw new Error("ADMIN_RECEIPT_STATE_INVALID");
    }
    return Object.freeze({
      ...row,
      state: row.state as CommandReceipt["state"],
      recordedAt: new Date(row.recordedAt).toISOString(),
    });
  }
}

interface ReceiptRow extends Omit<AdminCommandReceiptRecord, "state" | "recordedAt">, Record<string, unknown> {
  readonly state: string;
  readonly recordedAt: string | Date;
}
