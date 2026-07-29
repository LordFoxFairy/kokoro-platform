import type { PlatformTransaction } from "../unit-of-work/platform-transaction.js";
import { resolvePlatformTransaction } from "../unit-of-work/platform-transaction.js";
import { assertDigest, type JsonValue } from "./receipt.js";

export interface OutboxEvent {
  readonly eventId: string;
  readonly owner: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly payload: JsonValue;
  readonly payloadDigest: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export interface ClaimedOutboxEvent extends OutboxEvent {
  readonly leaseToken: string;
  readonly attempt: number;
}

export class OutboxRepository {
  async enqueue(transaction: PlatformTransaction, event: OutboxEvent): Promise<void> {
    assertDigest(event.payloadDigest);
    const sql = resolvePlatformTransaction(transaction);
    const existing = await sql.query<{ payloadDigest: string }>(
      `INSERT INTO platform.outbox_event
       (event_id, owner, event_type, aggregate_id, payload, payload_digest, correlation_id, causation_id)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING payload_digest AS "payloadDigest"`,
      [event.eventId, event.owner, event.eventType, event.aggregateId, JSON.stringify(event.payload),
        event.payloadDigest, event.correlationId, event.causationId],
    );
    if (existing.length === 0) {
      const row = await sql.query<{ payloadDigest: string }>(
        `SELECT payload_digest AS "payloadDigest" FROM platform.outbox_event WHERE event_id=$1`,
        [event.eventId],
      );
      if (row[0]?.payloadDigest !== event.payloadDigest) throw new Error("OUTBOX_EVENT_DIGEST_CONFLICT");
    }
  }

  async claim(
    transaction: PlatformTransaction,
    input: { readonly workerId: string; readonly leaseToken: string; readonly owners: readonly string[]; readonly limit: number; readonly leaseSeconds: number },
  ): Promise<readonly ClaimedOutboxEvent[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Error("OUTBOX_CLAIM_LIMIT_INVALID");
    if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 1 || input.leaseSeconds > 300) throw new Error("OUTBOX_LEASE_SECONDS_INVALID");
    assertBoundedIdentifier(input.workerId, "OUTBOX_WORKER_ID_INVALID");
    assertBoundedIdentifier(input.leaseToken, "OUTBOX_LEASE_TOKEN_INVALID");
    if (input.owners.length === 0 || input.owners.length > 32) throw new Error("OUTBOX_OWNER_ALLOWLIST_INVALID");
    input.owners.forEach((owner) => assertBoundedIdentifier(owner, "OUTBOX_OWNER_ALLOWLIST_INVALID"));
    const sql = resolvePlatformTransaction(transaction);
    return sql.query<ClaimedOutboxEvent & Record<string, unknown>>(
      `WITH candidates AS (
         SELECT event_id FROM platform.outbox_event
         WHERE owner = ANY($5::text[]) AND ((state='pending' AND available_at <= now())
            OR (state='leased' AND lease_expires_at <= now()))
         ORDER BY available_at, created_at
         FOR UPDATE SKIP LOCKED LIMIT $1
       )
       UPDATE platform.outbox_event event
          SET state='leased', lease_owner=$2, lease_token=$3,
              lease_expires_at=now()+make_interval(secs => $4), attempt=attempt+1, updated_at=now()
         FROM candidates WHERE event.event_id=candidates.event_id
       RETURNING event.event_id AS "eventId", event.owner, event.event_type AS "eventType",
                 event.aggregate_id AS "aggregateId", event.payload, event.payload_digest AS "payloadDigest",
                 event.correlation_id AS "correlationId", event.causation_id AS "causationId",
                 event.lease_token AS "leaseToken", event.attempt`,
      [input.limit, input.workerId, input.leaseToken, input.leaseSeconds, input.owners],
    );
  }

  async complete(transaction: PlatformTransaction, eventId: string, leaseToken: string): Promise<void> {
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.outbox_event SET state='delivered', delivered_at=now(), lease_owner=NULL,
       lease_token=NULL, lease_expires_at=NULL, updated_at=now()
       WHERE event_id=$1 AND state='leased' AND lease_token=$2`,
      [eventId, leaseToken],
    );
    if (changed !== 1) throw new Error("OUTBOX_LEASE_LOST");
  }

  async retryOrDeadLetter(
    transaction: PlatformTransaction,
    input: { readonly eventId: string; readonly leaseToken: string; readonly errorCode: string; readonly retryAt: string | null; readonly maxAttempts: number },
  ): Promise<void> {
    if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 100 || input.errorCode.length < 1 || input.errorCode.length > 128 || (input.retryAt !== null && !Number.isFinite(Date.parse(input.retryAt)))) throw new Error("OUTBOX_RETRY_INPUT_INVALID");
    assertBoundedIdentifier(input.leaseToken, "OUTBOX_RETRY_INPUT_INVALID");
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.outbox_event
       SET state=CASE WHEN attempt >= $4 OR $5::timestamptz IS NULL THEN 'dead_letter' ELSE 'pending' END,
           available_at=COALESCE($5::timestamptz, available_at), last_error_code=$3,
           lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL, updated_at=now()
       WHERE event_id=$1 AND state='leased' AND lease_token=$2`,
      [input.eventId, input.leaseToken, input.errorCode, input.maxAttempts, input.retryAt],
    );
    if (changed !== 1) throw new Error("OUTBOX_LEASE_LOST");
  }
}

function assertBoundedIdentifier(value: string, code: string): void {
  if (
    value.length < 1 ||
    value.length > 128 ||
    [...value].some((character) => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127)
  ) throw new Error(code);
}
