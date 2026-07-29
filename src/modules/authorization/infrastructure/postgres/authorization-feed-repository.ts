import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  AuthorizationSiteSnapshotSchema,
  AuthorizationSiteState,
  AuthorizationSnapshotRecordSchema,
  AuthorizationEpochVectorSchema,
  DeliveredGrantFactSchema,
  type AuthorizationSnapshotRecord,
} from "../../../../interfaces/connect/generated-authorization/kokoro/platform/authorization/v1/session_authorization_pb.js";

export type AuthorizationSequenceReservation = Readonly<{
  streamSequence: bigint;
  aggregateSequence: bigint;
}>;

export type StoredSignedAuthorizationEvent = Readonly<{
  streamSequence: bigint;
  eventId: string;
  siteRef: string;
  aggregateSequence: bigint;
  occurredAt: string;
  signingPayload: Uint8Array;
  payloadDigest: string;
  signingKeyRevision: string;
  signature: Uint8Array;
}>;

export class PostgresAuthorizationFeedRepository {
  async reserveSequence(
    transaction: PlatformTransaction,
    siteRef: string,
  ): Promise<AuthorizationSequenceReservation> {
    const sql = resolvePlatformTransaction(transaction);
    const stream = await sql.query<{ streamSequence: bigint }>(
      `UPDATE platform.authorization_stream_state
       SET high_watermark=high_watermark+1, updated_at=now()
       WHERE singleton=TRUE
       RETURNING high_watermark AS "streamSequence"`,
    );
    const aggregate = await sql.query<{ aggregateSequence: bigint }>(
      `UPDATE platform.authorization_site
       SET event_sequence=event_sequence+1, updated_at=now()
       WHERE site_ref=$1
       RETURNING event_sequence AS "aggregateSequence"`,
      [siteRef],
    );
    if (stream[0] === undefined || aggregate[0] === undefined) {
      throw new Error("AUTHORIZATION_EVENT_AGGREGATE_NOT_FOUND");
    }
    return Object.freeze({
      streamSequence: stream[0].streamSequence,
      aggregateSequence: aggregate[0].aggregateSequence,
    });
  }

  async reserveAndBumpRevocation(
    transaction: PlatformTransaction,
    input: Readonly<{ siteRef: string; expectedRevocationEpoch: bigint; changedAt: string }>,
  ): Promise<AuthorizationSequenceReservation & Readonly<{ revocationEpoch: bigint }>> {
    const sql = resolvePlatformTransaction(transaction);
    // Global stream then Site is the only lock order used by every authorization event path.
    const stream = await sql.query<{ streamSequence: bigint }>(
      `UPDATE platform.authorization_stream_state
       SET high_watermark=high_watermark+1,updated_at=now()
       WHERE singleton=TRUE RETURNING high_watermark AS "streamSequence"`,
    );
    const site = await sql.query<{ aggregateSequence: bigint; revocationEpoch: bigint }>(
      `UPDATE platform.authorization_site
       SET event_sequence=event_sequence+1,revocation_epoch=revocation_epoch+1,updated_at=$3::timestamptz
       WHERE site_ref=$1 AND revocation_epoch=$2
       RETURNING event_sequence AS "aggregateSequence",revocation_epoch AS "revocationEpoch"`,
      [input.siteRef, input.expectedRevocationEpoch, input.changedAt],
    );
    if (stream[0] === undefined || site[0] === undefined) throw new Error("AUTHORIZATION_STALE");
    return Object.freeze({
      streamSequence: stream[0].streamSequence,
      aggregateSequence: site[0].aggregateSequence,
      revocationEpoch: site[0].revocationEpoch,
    });
  }

  async append(
    transaction: PlatformTransaction,
    event: StoredSignedAuthorizationEvent & Readonly<{
      eventType: "grant_delivered" | "revocation_epoch_changed";
      correlationId: string;
    }>,
  ): Promise<void> {
    const changed = await resolvePlatformTransaction(transaction).execute(
      `INSERT INTO platform.authorization_event_log
       (stream_sequence,event_id,site_ref,aggregate_sequence,event_type,occurred_at,
        signing_payload,payload_digest,signing_key_revision,signature_algorithm,signature,correlation_id)
       VALUES ($1,$2::uuid,$3,$4,$5,$6::timestamptz,$7,$8,$9,'RS256',$10,$11)`,
      [
        event.streamSequence,
        event.eventId,
        event.siteRef,
        event.aggregateSequence,
        event.eventType,
        event.occurredAt,
        Buffer.from(event.signingPayload),
        event.payloadDigest,
        event.signingKeyRevision,
        Buffer.from(event.signature),
        event.correlationId,
      ],
    );
    if (changed !== 1) throw new Error("AUTHORIZATION_EVENT_APPEND_FAILED");
  }

  async readWindow(
    transaction: PlatformTransaction,
    input: Readonly<{ afterStreamSequence: bigint; limit: number }>,
  ): Promise<Readonly<{
    highWatermark: bigint;
    oldestAvailable: bigint;
    snapshotRequired: boolean;
    events: readonly StoredSignedAuthorizationEvent[];
  }>> {
    const sql = resolvePlatformTransaction(transaction);
    const state = await sql.query<{ highWatermark: bigint; oldestAvailable: bigint | null }>(
      `SELECT state.high_watermark AS "highWatermark", oldest.stream_sequence AS "oldestAvailable"
       FROM platform.authorization_stream_state state
       LEFT JOIN LATERAL (
         SELECT stream_sequence FROM platform.authorization_event_log ORDER BY stream_sequence LIMIT 1
       ) oldest ON TRUE
       WHERE state.singleton=TRUE`,
    );
    const row = state[0];
    if (row === undefined) throw new Error("AUTHORIZATION_STREAM_STATE_MISSING");
    const oldestAvailable = row.oldestAvailable ?? row.highWatermark + 1n;
    if (input.afterStreamSequence + 1n < oldestAvailable) {
      return Object.freeze({
        highWatermark: row.highWatermark,
        oldestAvailable,
        snapshotRequired: true,
        events: Object.freeze([]),
      });
    }
    const events = await sql.query<EventRow>(
      `SELECT stream_sequence AS "streamSequence",event_id::text AS "eventId",site_ref AS "siteRef",
              aggregate_sequence AS "aggregateSequence",occurred_at AS "occurredAt",
              signing_payload AS "signingPayload",payload_digest AS "payloadDigest",
              signing_key_revision AS "signingKeyRevision",signature
       FROM platform.authorization_event_log
       WHERE stream_sequence>$1 ORDER BY stream_sequence LIMIT $2`,
      [input.afterStreamSequence, input.limit],
    );
    return Object.freeze({
      highWatermark: row.highWatermark,
      oldestAvailable,
      snapshotRequired: false,
      events: Object.freeze(events.map(storedEvent)),
    });
  }

  async createSnapshot(
    transaction: PlatformTransaction,
    input: Readonly<{
      snapshotRef: string;
      frozenAt: string;
      expiresAt: string;
      keySetRevision: string;
      keyRecords: readonly AuthorizationSnapshotRecord[];
    }>,
  ): Promise<Readonly<{ highWatermark: bigint; recordCount: number }>> {
    const sql = resolvePlatformTransaction(transaction);
    // Every event appender updates this row first. FOR SHARE freezes the high-watermark and blocks
    // new appenders until all snapshot records have been materialized in this transaction.
    const state = await sql.query<{ highWatermark: bigint }>(
      `SELECT high_watermark AS "highWatermark"
       FROM platform.authorization_stream_state WHERE singleton=TRUE FOR SHARE`,
    );
    if (state[0] === undefined) throw new Error("AUTHORIZATION_STREAM_STATE_MISSING");
    const maximumRecords = 20_000;
    if (input.keyRecords.length > maximumRecords) throw new Error("AUTHORIZATION_SNAPSHOT_TOO_LARGE");
    const sites = await sql.query<SiteRow>(
      `SELECT site_ref AS "siteRef",event_sequence AS "aggregateSequence",state,
              security_epoch AS "siteSecurityEpoch",policy_epoch AS "policyEpoch",
              revocation_epoch AS "revocationEpoch",updated_at AS "updatedAt"
       FROM platform.authorization_site ORDER BY site_ref LIMIT $1`,
      [maximumRecords - input.keyRecords.length + 1],
    );
    if (sites.length + input.keyRecords.length > maximumRecords) throw new Error("AUTHORIZATION_SNAPSHOT_TOO_LARGE");
    const remaining = maximumRecords - input.keyRecords.length - sites.length;
    const grants = await sql.query<GrantSnapshotRow>(
      `SELECT grant_ref::text AS "grantRef",site_ref AS "siteRef",subject_ref AS "subjectRef",
              identity_session_ref AS "identitySessionRef",project_ref AS "projectRef",purpose,audience,
              claims_digest AS "claimsDigest",key_revision AS "grantKeyRevision",
              site_security_epoch AS "siteSecurityEpoch",subject_generation AS "subjectGeneration",
              identity_session_epoch AS "identitySessionEpoch",membership_epoch AS "membershipEpoch",
              authorization_epoch AS "authorizationEpoch",restriction_epoch AS "restrictionEpoch",
              credential_epoch AS "credentialEpoch",policy_epoch AS "policyEpoch",
              revocation_epoch AS "revocationEpoch",expires_at AS "expiresAt"
       FROM platform.authorization_session_access_grant
       WHERE delivery_state='delivered' AND expires_at>$1::timestamptz
       ORDER BY site_ref,grant_ref LIMIT $2`,
      [input.frozenAt, remaining + 1],
    );
    if (grants.length > remaining) throw new Error("AUTHORIZATION_SNAPSHOT_TOO_LARGE");
    const records: AuthorizationSnapshotRecord[] = sites.map((site) => create(
      AuthorizationSnapshotRecordSchema,
      {
        record: {
          case: "site",
          value: create(AuthorizationSiteSnapshotSchema, {
            siteRef: site.siteRef,
            aggregateSequence: site.aggregateSequence,
            state: siteState(site.state),
            siteSecurityEpoch: site.siteSecurityEpoch,
            policyEpoch: site.policyEpoch,
            revocationEpoch: site.revocationEpoch,
            updatedAt: timestampFromDate(new Date(site.updatedAt)),
          }),
        },
      },
    ));
    for (const grant of grants) {
      if (grant.siteSecurityEpoch === null || grant.subjectGeneration === null ||
          grant.identitySessionEpoch === null || grant.membershipEpoch === null ||
          grant.authorizationEpoch === null || grant.restrictionEpoch === null ||
          grant.credentialEpoch === null) throw new Error("AUTHORIZATION_GRANT_EPOCH_VECTOR_MISSING");
      records.push(create(AuthorizationSnapshotRecordSchema, {
        record: {
          case: "deliveredGrant",
          value: create(DeliveredGrantFactSchema, {
            grantRef: grant.grantRef,
            siteRef: grant.siteRef,
            subjectRef: grant.subjectRef,
            identitySessionRef: grant.identitySessionRef,
            projectRef: grant.projectRef,
            purpose: grant.purpose,
            audience: grant.audience,
            claimsDigest: grant.claimsDigest,
            grantKeyRevision: grant.grantKeyRevision,
            epochs: create(AuthorizationEpochVectorSchema, {
              siteSecurityEpoch: grant.siteSecurityEpoch,
              subjectGeneration: grant.subjectGeneration,
              identitySessionEpoch: grant.identitySessionEpoch,
              membershipEpoch: grant.membershipEpoch,
              authorizationEpoch: grant.authorizationEpoch,
              restrictionEpoch: grant.restrictionEpoch,
              credentialEpoch: grant.credentialEpoch,
              policyEpoch: grant.policyEpoch,
              revocationEpoch: grant.revocationEpoch,
            }),
            expiresAt: timestampFromDate(new Date(grant.expiresAt)),
          }),
        },
      }));
    }
    records.push(...input.keyRecords);
    await sql.execute(
      `INSERT INTO platform.authorization_snapshot
       (snapshot_ref,high_watermark,key_set_revision,frozen_at,expires_at)
       VALUES ($1::uuid,$2,$3,$4::timestamptz,$5::timestamptz)`,
      [input.snapshotRef, state[0].highWatermark, input.keySetRevision, input.frozenAt, input.expiresAt],
    );
    for (let offset = 0; offset < records.length; offset += 500) {
      const batch = records.slice(offset, offset + 500);
      const ordinals = batch.map((_, index) => BigInt(offset + index));
      const payloads = batch.map((record) => Buffer.from(toBinary(AuthorizationSnapshotRecordSchema, record, {
        writeUnknownFields: false,
      })));
      await sql.execute(
        `INSERT INTO platform.authorization_snapshot_record(snapshot_ref,ordinal,record_payload)
         SELECT $1::uuid,entry.ordinal,entry.payload
         FROM unnest($2::bigint[],$3::bytea[]) AS entry(ordinal,payload)`,
        [input.snapshotRef, ordinals, payloads],
      );
    }
    return Object.freeze({ highWatermark: state[0].highWatermark, recordCount: records.length });
  }

  async readSnapshotPage(
    transaction: PlatformTransaction,
    input: Readonly<{ snapshotRef: string; afterOrdinal: bigint; limit: number; now: string }>,
  ): Promise<Readonly<{
    highWatermark: bigint;
    keySetRevision: string;
    frozenAt: string;
    expiresAt: string;
    records: readonly Readonly<{ ordinal: bigint; record: AuthorizationSnapshotRecord }>[];
  }> | null> {
    const sql = resolvePlatformTransaction(transaction);
    const snapshots = await sql.query<{
      highWatermark: bigint;
      keySetRevision: string;
      frozenAt: string;
      expiresAt: string;
    }>(
      `SELECT high_watermark AS "highWatermark",key_set_revision AS "keySetRevision",
              frozen_at AS "frozenAt",expires_at AS "expiresAt"
       FROM platform.authorization_snapshot
       WHERE snapshot_ref=$1::uuid AND expires_at>$2::timestamptz`,
      [input.snapshotRef, input.now],
    );
    const snapshot = snapshots[0];
    if (snapshot === undefined) return null;
    const rows = await sql.query<{ ordinal: bigint; recordPayload: Uint8Array }>(
      `SELECT ordinal,record_payload AS "recordPayload"
       FROM platform.authorization_snapshot_record
       WHERE snapshot_ref=$1::uuid AND ordinal>$2 ORDER BY ordinal LIMIT $3`,
      [input.snapshotRef, input.afterOrdinal, input.limit],
    );
    return Object.freeze({
      highWatermark: snapshot.highWatermark,
      keySetRevision: snapshot.keySetRevision,
      frozenAt: new Date(snapshot.frozenAt).toISOString(),
      expiresAt: new Date(snapshot.expiresAt).toISOString(),
      records: Object.freeze(rows.map((row) => Object.freeze({
        ordinal: row.ordinal,
        record: fromBinary(AuthorizationSnapshotRecordSchema, bytes(row.recordPayload), {
          readUnknownFields: false,
        }),
      }))),
    });
  }

  async retain(
    transaction: PlatformTransaction,
    input: Readonly<{ now: string; eventsBefore: string }>,
  ): Promise<Readonly<{ snapshotsDeleted: number; eventsDeleted: number }>> {
    const sql = resolvePlatformTransaction(transaction);
    const snapshotsDeleted = await sql.execute(
      `DELETE FROM platform.authorization_snapshot WHERE expires_at<=$1::timestamptz`,
      [input.now],
    );
    const eventsDeleted = await sql.execute(
      `DELETE FROM platform.authorization_event_log WHERE occurred_at<$1::timestamptz`,
      [input.eventsBefore],
    );
    return Object.freeze({ snapshotsDeleted, eventsDeleted });
  }
}

interface EventRow extends Record<string, unknown> {
  streamSequence: bigint;
  eventId: string;
  siteRef: string;
  aggregateSequence: bigint;
  occurredAt: string;
  signingPayload: Uint8Array;
  payloadDigest: string;
  signingKeyRevision: string;
  signature: Uint8Array;
}

interface SiteRow extends Record<string, unknown> {
  siteRef: string;
  aggregateSequence: bigint;
  state: string;
  siteSecurityEpoch: bigint;
  policyEpoch: bigint;
  revocationEpoch: bigint;
  updatedAt: string;
}

interface GrantSnapshotRow extends Record<string, unknown> {
  grantRef: string;
  siteRef: string;
  subjectRef: string;
  identitySessionRef: string;
  projectRef: string;
  purpose: string;
  audience: string;
  claimsDigest: string;
  grantKeyRevision: string;
  siteSecurityEpoch: bigint | null;
  subjectGeneration: bigint | null;
  identitySessionEpoch: bigint | null;
  membershipEpoch: bigint | null;
  authorizationEpoch: bigint | null;
  restrictionEpoch: bigint | null;
  credentialEpoch: bigint | null;
  policyEpoch: bigint;
  revocationEpoch: bigint;
  expiresAt: string;
}

function storedEvent(row: EventRow): StoredSignedAuthorizationEvent {
  return Object.freeze({
    ...row,
    occurredAt: new Date(row.occurredAt).toISOString(),
    signingPayload: bytes(row.signingPayload),
    signature: bytes(row.signature),
  });
}

function bytes(value: Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
}

function siteState(value: string): AuthorizationSiteState {
  if (value === "active") return AuthorizationSiteState.ACTIVE;
  if (value === "suspended") return AuthorizationSiteState.SUSPENDED;
  if (value === "decommissioned") return AuthorizationSiteState.DECOMMISSIONED;
  if (value === "decommissioning") return AuthorizationSiteState.DECOMMISSIONING;
  throw new Error("AUTHORIZATION_SITE_STATE_INVALID");
}
