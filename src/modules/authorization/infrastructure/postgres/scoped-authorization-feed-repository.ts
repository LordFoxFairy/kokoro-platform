import type { ScopedAuthorizationReservation } from "../../application/contracts/scoped-session-authorization-port.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";

export type StoredScopedIdentitySessionEvent = Readonly<{
  reservation: ScopedAuthorizationReservation;
  eventId: string;
  occurredAt: string;
  signingPayload: Uint8Array;
  payloadDigest: string;
  signingKeyRevision: string;
  signature: Uint8Array;
  correlationId: string;
}>;

export class PostgresScopedAuthorizationFeedRepository {
  async reserveIdentitySessionMutation(
    transaction: PlatformTransaction,
    siteRef: string,
  ): Promise<ScopedAuthorizationReservation> {
    const sql = resolvePlatformTransaction(transaction);
    // Contract lock order: the global v2 stream, the Site aggregate, then the
    // caller mutates the exact IdentitySession owner row.
    const stream = await sql.query<{ streamSequence: bigint }>(
      `UPDATE platform.authorization_scoped_stream_state
       SET high_watermark=high_watermark+1,updated_at=now()
       WHERE singleton=TRUE RETURNING high_watermark AS "streamSequence"`,
    );
    const aggregate = await sql.query<{ aggregateSequence: bigint }>(
      `INSERT INTO platform.authorization_scoped_site_cursor(site_ref,aggregate_sequence)
       VALUES ($1,1)
       ON CONFLICT (site_ref) DO UPDATE
       SET aggregate_sequence=platform.authorization_scoped_site_cursor.aggregate_sequence+1,
           updated_at=now()
       RETURNING aggregate_sequence AS "aggregateSequence"`,
      [siteRef],
    );
    if (stream[0] === undefined || aggregate[0] === undefined) {
      throw new Error("SCOPED_AUTHORIZATION_RESERVATION_FAILED");
    }
    return Object.freeze({
      siteRef,
      streamSequence: stream[0].streamSequence,
      aggregateSequence: aggregate[0].aggregateSequence,
    });
  }

  async appendIdentitySessionCurrent(
    transaction: PlatformTransaction,
    event: StoredScopedIdentitySessionEvent,
  ): Promise<void> {
    const changed = await resolvePlatformTransaction(transaction).execute(
      `INSERT INTO platform.authorization_scoped_event_log
       (stream_sequence,event_id,site_ref,aggregate_sequence,event_type,occurred_at,
        signing_payload,payload_digest,signing_key_revision,signature_algorithm,signature,correlation_id)
       VALUES ($1,$2::uuid,$3,$4,'identity_session_current_changed',$5::timestamptz,
               $6,$7,$8,'RS256',$9,$10)`,
      [
        event.reservation.streamSequence,
        event.eventId,
        event.reservation.siteRef,
        event.reservation.aggregateSequence,
        event.occurredAt,
        Buffer.from(event.signingPayload),
        event.payloadDigest,
        event.signingKeyRevision,
        Buffer.from(event.signature),
        event.correlationId,
      ],
    );
    if (changed !== 1) throw new Error("SCOPED_AUTHORIZATION_EVENT_APPEND_FAILED");
  }
}
