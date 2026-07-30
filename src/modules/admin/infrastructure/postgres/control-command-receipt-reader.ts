import { canonicalCommandId } from "../../../../shared/outbox-inbox/receipt.js";
import type { VerifiedRequestSecurityContext } from
  "../../../../shared/security-context/index.js";
import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/index.js";

export interface ControlCommandReceiptTimestampReader {
  read(
    context: VerifiedRequestSecurityContext,
    input: Readonly<{ commandId: string; operation: string }>,
  ): Promise<string>;
}

export class PostgresControlCommandReceiptTimestampReader
  implements ControlCommandReceiptTimestampReader
{
  constructor(private readonly unitOfWork: PlatformUnitOfWork) {}

  read(
    context: VerifiedRequestSecurityContext,
    input: Readonly<{ commandId: string; operation: string }>,
  ): Promise<string> {
    const commandId = canonicalCommandId(input.commandId);
    return this.unitOfWork.execute(
      { context, operation: input.operation },
      async (transaction) => {
        const rows = await resolvePlatformTransaction(transaction).query<{
          state: unknown;
          recordedAt: unknown;
        }>(
          `SELECT state,updated_at AS "recordedAt"
           FROM platform.command_receipt
           WHERE command_id=$1 AND environment=$2 AND region=$3
             AND caller_identity=$4 AND operation=$5
           LIMIT 1`,
          [commandId, context.environment, context.region,
            context.trustedCaller.workloadIdentityId, input.operation],
        );
        const row = rows[0];
        if (row === undefined || row.state !== "succeeded") {
          throw new Error("CONTROL_COMMAND_RECEIPT_NOT_COMMITTED");
        }
        const recordedAt = row.recordedAt instanceof Date
          ? row.recordedAt.toISOString()
          : typeof row.recordedAt === "string"
            ? new Date(row.recordedAt).toISOString()
            : null;
        if (recordedAt === null || !Number.isFinite(Date.parse(recordedAt))) {
          throw new Error("CONTROL_COMMAND_RECEIPT_TIMESTAMP_INVALID");
        }
        return recordedAt;
      },
    );
  }
}
