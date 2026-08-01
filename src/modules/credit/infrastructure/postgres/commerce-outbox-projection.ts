import { createHash } from "node:crypto";
import type { CreditOutboxCommitment, CreditOutboxProjectionPort } from
  "../../application/contracts/commerce-projection.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";

export class PostgresCreditOutboxProjection implements CreditOutboxProjectionPort {
  async assertDeliverable(transaction: Parameters<CreditOutboxProjectionPort["assertDeliverable"]>[0],
    event: CreditOutboxCommitment): Promise<void> {
    const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown> & {
      result: unknown;
      resultDigest: string;
    }>(
      `SELECT receipt.result,receipt.result_digest AS "resultDigest"
       FROM platform.credit_budget_operation_receipt receipt
       JOIN platform.credit_authorization_segment segment
         ON segment.authorization_segment_ref=receipt.authorization_segment_ref
        AND segment.site_ref=receipt.site_ref
       WHERE receipt.outbox_event_ref=$1::uuid AND receipt.site_ref=$2
         AND receipt.authorization_segment_ref=$3::uuid AND receipt.operation_kind=$4`,
      [event.eventId, event.siteId, event.authorizationSegmentRef, event.operationKind],
    );
    const row = rows[0];
    if (row === undefined || rows.length !== 1 || row.resultDigest !== digest(event.result) ||
        canonicalJson(row.result) !== canonicalJson(event.result)) throw new Error("CREDIT_OUTBOX_PROJECTION_MISMATCH");
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("CREDIT_OUTBOX_RESULT_INVALID");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  throw new Error("CREDIT_OUTBOX_RESULT_INVALID");
}
