import type { PlatformTransaction } from "../unit-of-work/platform-transaction.js";
import { resolvePlatformTransaction } from "../unit-of-work/platform-transaction.js";
import { assertDigest, type JsonValue } from "./receipt.js";

export interface InboxDeliveryIdentity {
  readonly deliveryId: string;
  readonly provider: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
}
export interface InboxClaim { readonly handlerId: string; readonly leaseToken: string; readonly leaseSeconds: number; readonly maxAttempts: number; }
export type InboxAdmission =
  | { readonly kind: "accepted" | "reclaimed"; readonly deliveryId: string; readonly attempt: number }
  | { readonly kind: "duplicate"; readonly deliveryId: string; readonly outcome: JsonValue | null }
  | { readonly kind: "dead_letter"; readonly deliveryId: string };

export class InboxRepository {
  async admit(transaction: PlatformTransaction, identity: InboxDeliveryIdentity, claim: InboxClaim): Promise<InboxAdmission> {
    assertDigest(identity.requestDigest);
    validateClaim(claim);
    const sql = resolvePlatformTransaction(transaction);
    const inserted = await sql.query<{ deliveryId: string; attempt: number }>(
      `INSERT INTO platform.inbox_delivery
       (delivery_id, provider, operation, idempotency_key, request_digest, state, handler_id, lease_token, lease_expires_at, attempt)
       VALUES ($1,$2,$3,$4,$5,'processing',$6,$7,now()+make_interval(secs => $8),1)
       ON CONFLICT (provider, operation, idempotency_key) DO NOTHING
       RETURNING delivery_id AS "deliveryId", attempt`,
      [identity.deliveryId, identity.provider, identity.operation, identity.idempotencyKey, identity.requestDigest,
        claim.handlerId, claim.leaseToken, claim.leaseSeconds],
    );
    if (inserted[0]) return { kind: "accepted", ...inserted[0] };
    const rows = await sql.query<InboxRow>(
      `SELECT delivery_id AS "deliveryId", request_digest AS "requestDigest", state, outcome,
              COALESCE(lease_expires_at <= now(), TRUE) AS "leaseExpired", attempt
       FROM platform.inbox_delivery WHERE provider=$1 AND operation=$2 AND idempotency_key=$3 FOR UPDATE`,
      [identity.provider, identity.operation, identity.idempotencyKey],
    );
    const row = rows[0];
    if (!row) throw new Error("INBOX_DELIVERY_NOT_FOUND");
    if (row.requestDigest !== identity.requestDigest) throw new Error("INBOX_DIGEST_CONFLICT");
    if (row.state === "completed") return { kind: "duplicate", deliveryId: row.deliveryId, outcome: row.outcome };
    if (row.state === "dead_letter") return { kind: "dead_letter", deliveryId: row.deliveryId };
    if (row.state === "processing" && !row.leaseExpired) throw new Error("INBOX_DELIVERY_IN_PROGRESS");
    if (row.attempt >= claim.maxAttempts) {
      await sql.execute(`UPDATE platform.inbox_delivery SET state='dead_letter', handler_id=NULL, lease_token=NULL, lease_expires_at=NULL, updated_at=now() WHERE delivery_id=$1`, [row.deliveryId]);
      return { kind: "dead_letter", deliveryId: row.deliveryId };
    }
    await sql.execute(
      `UPDATE platform.inbox_delivery SET state='processing', handler_id=$2, lease_token=$3,
       lease_expires_at=now()+make_interval(secs => $4), attempt=attempt+1, updated_at=now() WHERE delivery_id=$1`,
      [row.deliveryId, claim.handlerId, claim.leaseToken, claim.leaseSeconds],
    );
    return { kind: "reclaimed", deliveryId: row.deliveryId, attempt: row.attempt + 1 };
  }

  async complete(transaction: PlatformTransaction, deliveryId: string, leaseToken: string, outcome: JsonValue | null, outcomeDigest: string): Promise<void> {
    assertDigest(outcomeDigest);
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.inbox_delivery SET state='completed', outcome=$3::jsonb, outcome_digest=$4,
       completed_at=now(), handler_id=NULL, lease_token=NULL, lease_expires_at=NULL, updated_at=now()
       WHERE delivery_id=$1 AND state='processing' AND lease_token=$2`,
      [deliveryId, leaseToken, JSON.stringify(outcome), outcomeDigest],
    );
    if (changed !== 1) throw new Error("INBOX_LEASE_LOST");
  }

  async recordOutcomeUnknown(transaction: PlatformTransaction, deliveryId: string, leaseToken: string, observationCode: string): Promise<void> {
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.inbox_delivery SET state='outcome_unknown', last_observation_code=$3,
       handler_id=NULL, lease_token=NULL, lease_expires_at=NULL, updated_at=now()
       WHERE delivery_id=$1 AND state='processing' AND lease_token=$2`,
      [deliveryId, leaseToken, observationCode],
    );
    if (changed !== 1) throw new Error("INBOX_LEASE_LOST");
  }
}

interface InboxRow extends Record<string, unknown> { deliveryId: string; requestDigest: string; state: "processing" | "outcome_unknown" | "completed" | "dead_letter"; outcome: JsonValue | null; leaseExpired: boolean; attempt: number; }
function validateClaim(claim: InboxClaim): void {
  if (claim.handlerId.length < 1 || claim.handlerId.length > 128 || claim.leaseToken.length < 1 || claim.leaseToken.length > 128) throw new Error("INBOX_CLAIM_IDENTITY_INVALID");
  if (!Number.isInteger(claim.leaseSeconds) || claim.leaseSeconds < 1 || claim.leaseSeconds > 300) throw new Error("INBOX_LEASE_SECONDS_INVALID");
  if (!Number.isInteger(claim.maxAttempts) || claim.maxAttempts < 1 || claim.maxAttempts > 100) throw new Error("INBOX_MAX_ATTEMPTS_INVALID");
}
