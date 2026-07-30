import { canonicalCommandId } from "../../../../shared/outbox-inbox/receipt.js";
import { createHash } from "node:crypto";
import type { JsonValue } from "../../../../shared/outbox-inbox/receipt.js";
import type { VerifiedRequestSecurityContext } from
  "../../../../shared/security-context/index.js";
import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/index.js";

export interface ControlCommandReceiptRecord {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly operation: string;
  readonly state: "succeeded";
  readonly recordedAt: string;
  readonly result: JsonValue;
}

export interface ControlCommandReceiptTimestampReader {
  read(
    context: VerifiedRequestSecurityContext,
    input: Readonly<{ commandId: string; operation: string }>,
  ): Promise<string>;
  get?(
    context: VerifiedRequestSecurityContext,
    input: Readonly<{ commandId: string; operation: string; siteId: string | null }>,
  ): Promise<ControlCommandReceiptRecord | null>;
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

  get(
    context: VerifiedRequestSecurityContext,
    input: Readonly<{ commandId: string; operation: string; siteId: string | null }>,
  ): Promise<ControlCommandReceiptRecord | null> {
    const commandId = canonicalCommandId(input.commandId);
    return this.unitOfWork.execute(
      { context, operation: input.operation },
      async (transaction) => {
        const rows = await resolvePlatformTransaction(transaction).query<{
          commandId: unknown;
          idempotencyKey: unknown;
          requestDigest: unknown;
          operation: unknown;
          state: unknown;
          result: unknown;
          resultDigest: unknown;
          recordedAt: unknown;
        }>(
          `SELECT command_id AS "commandId",idempotency_key AS "idempotencyKey",
                  request_digest AS "requestDigest",operation,state,result,
                  result_digest AS "resultDigest",updated_at AS "recordedAt"
           FROM platform.command_receipt
           WHERE command_id=$1 AND environment=$2 AND region=$3 AND caller_identity=$4
           LIMIT 1`,
          [commandId, context.environment, context.region,
            context.trustedCaller.workloadIdentityId],
        );
        const row = rows[0];
        if (row === undefined || row.state !== "succeeded") return null;
        if (row.commandId !== commandId || typeof row.idempotencyKey !== "string" ||
            typeof row.requestDigest !== "string" || !/^[a-f0-9]{64}$/u.test(row.requestDigest) ||
            typeof row.operation !== "string" || !isJsonValue(row.result) ||
            typeof row.resultDigest !== "string" || digest(row.result) !== row.resultDigest) {
          throw new Error("MODEL_CONTROL_RECEIPT_INVALID");
        }
        const recordedAt = row.recordedAt instanceof Date
          ? row.recordedAt.toISOString()
          : typeof row.recordedAt === "string"
            ? new Date(row.recordedAt).toISOString()
            : null;
        if (recordedAt === null || !Number.isFinite(Date.parse(recordedAt))) {
          throw new Error("MODEL_CONTROL_RECEIPT_TIME_INVALID");
        }
        return Object.freeze({
          commandId, idempotencyKey: row.idempotencyKey, requestDigest: row.requestDigest,
          operation: row.operation, state: "succeeded" as const, recordedAt, result: row.result,
        });
      },
    );
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function digest(value: JsonValue): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
}
