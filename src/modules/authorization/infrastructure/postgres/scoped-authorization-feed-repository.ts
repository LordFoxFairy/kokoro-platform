import type { ScopedAuthorizationReservation } from "../../application/contracts/scoped-session-authorization-port.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  AuthorizationEpochVectorSchema,
  AuthorizationIdentitySessionState,
  AuthorizationProjectMembershipState,
  AuthorizationSiteState,
  AuthorizationSnapshotRecordSchema,
  AuthorizationSubjectState,
  DeliveredGrantFactSchema,
  IdentitySessionCurrentSchema,
  ProjectMembershipCurrentSchema,
  SiteCurrentSchema,
  SiteCurrentSnapshotSchema,
  SubjectCurrentSchema,
  type AuthorizationSnapshotRecord,
} from "../../../../generated/proto/kokoro/platform/authorization/v2/scoped_session_authorization_pb.js";

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

export type StoredScopedSubjectEvent = StoredScopedIdentitySessionEvent;

export class PostgresScopedAuthorizationFeedRepository {
  async reserveOwnerMutations(
    transaction: PlatformTransaction,
    siteRef: string,
    count: number,
  ): Promise<readonly ScopedAuthorizationReservation[]> {
    if (!Number.isSafeInteger(count) || count < 1 || count > 32) {
      throw new Error("SCOPED_AUTHORIZATION_RESERVATION_COUNT_INVALID");
    }
    const sql = resolvePlatformTransaction(transaction);
    // Every writer uses one statement per lock level. Incrementing the counters by the whole
    // batch lets a compound owner command reserve every sequence before it locks any owner row.
    const stream = await sql.query<{ firstStreamSequence: bigint }>(
      `UPDATE platform.authorization_scoped_stream_state
       SET high_watermark=high_watermark+$1,updated_at=now()
       WHERE singleton=TRUE RETURNING high_watermark-$1+1 AS "firstStreamSequence"`,
      [count],
    );
    const aggregate = await sql.query<{ firstAggregateSequence: bigint }>(
      `INSERT INTO platform.authorization_scoped_site_cursor(site_ref,aggregate_sequence)
       VALUES ($1,$2)
       ON CONFLICT (site_ref) DO UPDATE
       SET aggregate_sequence=platform.authorization_scoped_site_cursor.aggregate_sequence+$2,
           updated_at=now()
       RETURNING aggregate_sequence-$2+1 AS "firstAggregateSequence"`,
      [siteRef, count],
    );
    const firstStream = stream[0]?.firstStreamSequence;
    const firstAggregate = aggregate[0]?.firstAggregateSequence;
    if (firstStream === undefined || firstAggregate === undefined) {
      throw new Error("SCOPED_AUTHORIZATION_RESERVATION_FAILED");
    }
    return Object.freeze(Array.from({ length: count }, (_, index) => Object.freeze({
      siteRef,
      streamSequence: firstStream + BigInt(index),
      aggregateSequence: firstAggregate + BigInt(index),
    })));
  }

  async reserveSiteMutation(
    transaction: PlatformTransaction,
    siteRef: string,
  ): Promise<ScopedAuthorizationReservation> {
    return this.reserveOwnerMutation(transaction, siteRef);
  }

  async reserveSubjectMutation(
    transaction: PlatformTransaction,
    siteRef: string,
  ): Promise<ScopedAuthorizationReservation> {
    return this.reserveOwnerMutation(transaction, siteRef);
  }

  async reserveIdentitySessionMutation(
    transaction: PlatformTransaction,
    siteRef: string,
  ): Promise<ScopedAuthorizationReservation> {
    return this.reserveOwnerMutation(transaction, siteRef);
  }

  async reserveProjectMembershipMutation(
    transaction: PlatformTransaction,
    siteRef: string,
  ): Promise<ScopedAuthorizationReservation> {
    return this.reserveOwnerMutation(transaction, siteRef);
  }

  async reserveGrantDelivery(
    transaction: PlatformTransaction,
    siteRef: string,
  ): Promise<ScopedAuthorizationReservation> {
    return this.reserveOwnerMutation(transaction, siteRef);
  }

  private async reserveOwnerMutation(
    transaction: PlatformTransaction,
    siteRef: string,
  ): Promise<ScopedAuthorizationReservation> {
    const reservations = await this.reserveOwnerMutations(transaction, siteRef, 1);
    const reservation = reservations[0];
    if (reservation === undefined) throw new Error("SCOPED_AUTHORIZATION_RESERVATION_FAILED");
    return reservation;
  }

  async appendSiteCurrent(
    transaction: PlatformTransaction,
    event: StoredScopedIdentitySessionEvent,
  ): Promise<void> {
    return this.appendOwnerCurrent(transaction, event, "site_current_changed");
  }

  async appendSubjectCurrent(
    transaction: PlatformTransaction,
    event: StoredScopedSubjectEvent,
  ): Promise<void> {
    return this.appendOwnerCurrent(transaction, event, "subject_current_changed");
  }

  async appendIdentitySessionCurrent(
    transaction: PlatformTransaction,
    event: StoredScopedIdentitySessionEvent,
  ): Promise<void> {
    return this.appendOwnerCurrent(transaction, event, "identity_session_current_changed");
  }

  async appendProjectMembershipCurrent(
    transaction: PlatformTransaction,
    event: StoredScopedIdentitySessionEvent,
  ): Promise<void> {
    return this.appendOwnerCurrent(transaction, event, "project_membership_current_changed");
  }

  async appendGrantDelivered(
    transaction: PlatformTransaction,
    event: StoredScopedIdentitySessionEvent,
  ): Promise<void> {
    return this.appendOwnerCurrent(transaction, event, "grant_delivered");
  }

  private async appendOwnerCurrent(
    transaction: PlatformTransaction,
    event: StoredScopedIdentitySessionEvent,
    eventType: "site_current_changed" | "subject_current_changed" |
      "identity_session_current_changed" | "project_membership_current_changed" | "grant_delivered",
  ): Promise<void> {
    const changed = await resolvePlatformTransaction(transaction).execute(
      `INSERT INTO platform.authorization_scoped_event_log
       (stream_sequence,event_id,site_ref,aggregate_sequence,event_type,occurred_at,
       signing_payload,payload_digest,signing_key_revision,signature_algorithm,signature,correlation_id)
       VALUES ($1,$2::uuid,$3,$4,$5,$6::timestamptz,
               $7,$8,$9,'RS256',$10,$11)`,
      [
        event.reservation.streamSequence,
        event.eventId,
        event.reservation.siteRef,
        event.reservation.aggregateSequence,
        eventType,
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

  async readWindow(
    transaction: PlatformTransaction,
    input: Readonly<{ afterStreamSequence: bigint; limit: number }>,
  ): Promise<Readonly<{
    highWatermark: bigint;
    oldestAvailable: bigint;
    snapshotRequired: boolean;
    events: readonly StoredScopedIdentitySessionEvent[];
  }>> {
    const sql = resolvePlatformTransaction(transaction);
    const states = await sql.query<{ highWatermark: bigint; oldestAvailable: bigint | null }>(
      `SELECT state.high_watermark AS "highWatermark",oldest.stream_sequence AS "oldestAvailable"
       FROM platform.authorization_scoped_stream_state state
       LEFT JOIN LATERAL (
         SELECT stream_sequence FROM platform.authorization_scoped_event_log
         ORDER BY stream_sequence LIMIT 1
       ) oldest ON TRUE WHERE state.singleton=TRUE`,
    );
    const state = states[0];
    if (state === undefined) throw new Error("SCOPED_AUTHORIZATION_STREAM_STATE_MISSING");
    const oldestAvailable = state.oldestAvailable ?? state.highWatermark + 1n;
    if (input.afterStreamSequence + 1n < oldestAvailable) {
      return Object.freeze({ highWatermark: state.highWatermark, oldestAvailable,
        snapshotRequired: true, events: Object.freeze([]) });
    }
    const rows = await sql.query<ScopedEventRow>(
      `SELECT stream_sequence AS "streamSequence",event_id::text AS "eventId",site_ref AS "siteRef",
              aggregate_sequence AS "aggregateSequence",occurred_at AS "occurredAt",
              signing_payload AS "signingPayload",payload_digest AS "payloadDigest",
              signing_key_revision AS "signingKeyRevision",signature,correlation_id AS "correlationId"
       FROM platform.authorization_scoped_event_log
       WHERE stream_sequence>$1 ORDER BY stream_sequence LIMIT $2`,
      [input.afterStreamSequence, input.limit],
    );
    return Object.freeze({
      highWatermark: state.highWatermark,
      oldestAvailable,
      snapshotRequired: false,
      events: Object.freeze(rows.map((row) => Object.freeze({
        reservation: Object.freeze({ siteRef: row.siteRef, streamSequence: row.streamSequence,
          aggregateSequence: row.aggregateSequence }),
        eventId: row.eventId,
        occurredAt: new Date(row.occurredAt).toISOString(),
        signingPayload: bytes(row.signingPayload),
        payloadDigest: row.payloadDigest,
        signingKeyRevision: row.signingKeyRevision,
        signature: bytes(row.signature),
        correlationId: row.correlationId,
      }))),
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
    // The definer function grants only this lock operation; the runtime role has no UPDATE
    // authority on the global counter. Every writer locks that counter first, so this freezes
    // owner rows, grants and the watermark at one transactional authority view.
    const states = await sql.query<{ highWatermark: bigint }>(
      `SELECT platform.lock_authorization_snapshot_watermark() AS "highWatermark"`,
    );
    const state = states[0];
    if (state === undefined) throw new Error("SCOPED_AUTHORIZATION_STREAM_STATE_MISSING");
    const maximumRecords = 20_000;
    const records: AuthorizationSnapshotRecord[] = [];
    const limit = () => maximumRecords - input.keyRecords.length - records.length + 1;

    const sites = await sql.query<ScopedSiteSnapshotRow>(
      `SELECT site.site_ref AS "siteRef",cursor.aggregate_sequence AS "aggregateSequence",site.state,
              site.security_epoch AS "siteSecurityEpoch",site.policy_epoch AS "policyEpoch",
              site.revocation_epoch AS "revocationEpoch",site.updated_at AS "updatedAt",
              GREATEST(site.updated_at+interval '5 minutes',COALESCE(delivered_grant.max_expires_at,
                site.updated_at+interval '5 minutes')) AS "retainUntil"
       FROM platform.authorization_site site
       JOIN platform.authorization_scoped_site_cursor cursor ON cursor.site_ref=site.site_ref
       LEFT JOIN LATERAL (
         SELECT MAX(expires_at) AS max_expires_at FROM platform.authorization_session_access_grant
         WHERE site_ref=site.site_ref AND delivery_state='delivered'
       ) delivered_grant ON TRUE
       ORDER BY site.site_ref LIMIT $1`,
      [limit()],
    );
    ensureCapacity(records.length + input.keyRecords.length, sites.length, maximumRecords);
    records.push(...sites.map(siteSnapshotRecord));

    const subjects = await sql.query<ScopedSubjectSnapshotRow>(
      `SELECT subject.site_ref AS "siteRef",subject.subject_ref AS "subjectRef",subject.state,
              subject.subject_generation AS "subjectGeneration",subject.restriction_epoch AS "restrictionEpoch",
              subject.updated_at AS "updatedAt",GREATEST(subject.updated_at+interval '5 minutes',
                COALESCE(delivered_grant.max_expires_at,subject.updated_at+interval '5 minutes')) AS "retainUntil"
       FROM platform.authorization_subject subject
       LEFT JOIN LATERAL (
         SELECT MAX(expires_at) AS max_expires_at FROM platform.authorization_session_access_grant
         WHERE site_ref=subject.site_ref AND subject_ref=subject.subject_ref AND delivery_state='delivered'
       ) delivered_grant ON TRUE
       ORDER BY subject.site_ref,subject.subject_ref LIMIT $1`,
      [limit()],
    );
    ensureCapacity(records.length + input.keyRecords.length, subjects.length, maximumRecords);
    records.push(...subjects.map(subjectSnapshotRecord));

    const identities = await sql.query<ScopedIdentitySnapshotRow>(
      `SELECT identity.site_ref AS "siteRef",identity.subject_ref AS "subjectRef",
              identity.session_ref AS "identitySessionRef",identity.state,
              identity.session_epoch AS "identitySessionEpoch",identity.credential_epoch AS "credentialEpoch",
              identity.expires_at AS "expiresAt",identity.updated_at AS "updatedAt",
              GREATEST(identity.updated_at+interval '5 minutes',identity.expires_at,
                COALESCE(delivered_grant.max_expires_at,identity.updated_at+interval '5 minutes')) AS "retainUntil"
       FROM platform.authorization_identity_session identity
       LEFT JOIN LATERAL (
         SELECT MAX(expires_at) AS max_expires_at FROM platform.authorization_session_access_grant
         WHERE site_ref=identity.site_ref AND subject_ref=identity.subject_ref
           AND identity_session_ref=identity.session_ref AND delivery_state='delivered'
       ) delivered_grant ON TRUE
       ORDER BY identity.site_ref,identity.subject_ref,identity.session_ref LIMIT $1`,
      [limit()],
    );
    ensureCapacity(records.length + input.keyRecords.length, identities.length, maximumRecords);
    records.push(...identities.map(identitySnapshotRecord));

    const memberships = await sql.query<ScopedMembershipSnapshotRow>(
      `SELECT project.site_ref AS "siteRef",membership.subject_ref AS "subjectRef",
              membership.project_ref AS "projectRef",membership.state,
              membership.membership_epoch AS "membershipEpoch",
              membership.authorization_epoch AS "authorizationEpoch",membership.updated_at AS "updatedAt",
              GREATEST(membership.updated_at+interval '5 minutes',COALESCE(delivered_grant.max_expires_at,
                membership.updated_at+interval '5 minutes')) AS "retainUntil"
       FROM platform.authorization_project_membership membership
       JOIN platform.authorization_project project ON project.project_ref=membership.project_ref
       JOIN platform.authorization_subject subject ON subject.subject_ref=membership.subject_ref
         AND subject.site_ref=project.site_ref
       LEFT JOIN LATERAL (
         SELECT MAX(expires_at) AS max_expires_at FROM platform.authorization_session_access_grant
         WHERE site_ref=project.site_ref AND subject_ref=membership.subject_ref
           AND project_ref=membership.project_ref AND delivery_state='delivered'
       ) delivered_grant ON TRUE
       ORDER BY project.site_ref,membership.subject_ref,membership.project_ref LIMIT $1`,
      [limit()],
    );
    ensureCapacity(records.length + input.keyRecords.length, memberships.length, maximumRecords);
    records.push(...memberships.map(membershipSnapshotRecord));

    const grants = await sql.query<ScopedGrantSnapshotRow>(
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
      [input.frozenAt, limit()],
    );
    ensureCapacity(records.length + input.keyRecords.length, grants.length, maximumRecords);
    records.push(...grants.map(grantSnapshotRecord), ...input.keyRecords);

    await sql.execute(
      `INSERT INTO platform.authorization_scoped_snapshot
       (snapshot_ref,high_watermark,key_set_revision,frozen_at,expires_at)
       VALUES ($1::uuid,$2,$3,$4::timestamptz,$5::timestamptz)`,
      [input.snapshotRef, state.highWatermark, input.keySetRevision, input.frozenAt, input.expiresAt],
    );
    for (let offset = 0; offset < records.length; offset += 500) {
      const batch = records.slice(offset, offset + 500);
      const ordinals = batch.map((_, index) => BigInt(offset + index));
      const payloads = batch.map((record) => Buffer.from(toBinary(AuthorizationSnapshotRecordSchema,
        record, { writeUnknownFields: false })));
      await sql.execute(
        `INSERT INTO platform.authorization_scoped_snapshot_record(snapshot_ref,ordinal,record_payload)
         SELECT $1::uuid,entry.ordinal,entry.payload
         FROM unnest($2::bigint[],$3::bytea[]) AS entry(ordinal,payload)`,
        [input.snapshotRef, ordinals, payloads],
      );
    }
    return Object.freeze({ highWatermark: state.highWatermark, recordCount: records.length });
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
    const snapshots = await sql.query<ScopedSnapshotRow>(
      `SELECT high_watermark AS "highWatermark",key_set_revision AS "keySetRevision",
              frozen_at AS "frozenAt",expires_at AS "expiresAt"
       FROM platform.authorization_scoped_snapshot
       WHERE snapshot_ref=$1::uuid AND expires_at>$2::timestamptz`,
      [input.snapshotRef, input.now],
    );
    const snapshot = snapshots[0];
    if (snapshot === undefined) return null;
    const rows = await sql.query<{ ordinal: bigint; recordPayload: Uint8Array }>(
      `SELECT ordinal,record_payload AS "recordPayload"
       FROM platform.authorization_scoped_snapshot_record
       WHERE snapshot_ref=$1::uuid AND ordinal>$2 ORDER BY ordinal LIMIT $3`,
      [input.snapshotRef, input.afterOrdinal, input.limit],
    );
    return Object.freeze({
      highWatermark: snapshot.highWatermark,
      keySetRevision: snapshot.keySetRevision,
      frozenAt: instant(snapshot.frozenAt),
      expiresAt: instant(snapshot.expiresAt),
      records: Object.freeze(rows.map((row) => Object.freeze({
        ordinal: row.ordinal,
        record: fromBinary(AuthorizationSnapshotRecordSchema, bytes(row.recordPayload), {
          readUnknownFields: false,
        }),
      }))),
    });
  }

  async assertReady(transaction: PlatformTransaction): Promise<void> {
    const rows = await resolvePlatformTransaction(transaction).query<{
      highWatermark: bigint;
      latestSequence: bigint | null;
    }>(
      `SELECT state.high_watermark AS "highWatermark",latest.stream_sequence AS "latestSequence"
       FROM platform.authorization_scoped_stream_state state
       LEFT JOIN LATERAL (
         SELECT stream_sequence FROM platform.authorization_scoped_event_log
         ORDER BY stream_sequence DESC LIMIT 1
       ) latest ON TRUE WHERE state.singleton=TRUE`,
    );
    const row = rows[0];
    if (row === undefined || row.highWatermark < 0n ||
        (row.latestSequence !== null && row.latestSequence !== row.highWatermark)) {
      throw new Error("SCOPED_AUTHORIZATION_NOT_READY");
    }
  }

  async retain(
    transaction: PlatformTransaction,
    input: Readonly<{ now: string; appendedBefore: string }>,
  ): Promise<Readonly<{ snapshotsDeleted: number; eventsDeleted: number }>> {
    const sql = resolvePlatformTransaction(transaction);
    const snapshotsDeleted = await sql.execute(
      `DELETE FROM platform.authorization_scoped_snapshot WHERE expires_at<=$1::timestamptz`,
      [input.now],
    );
    const eventsDeleted = await sql.execute(
      `WITH retention_boundary AS (
         SELECT MIN(stream_sequence) AS first_retained
         FROM platform.authorization_scoped_event_log WHERE created_at >= $1::timestamptz
       )
       DELETE FROM platform.authorization_scoped_event_log event
       USING retention_boundary boundary
       WHERE event.created_at < $1::timestamptz
         AND (boundary.first_retained IS NULL OR event.stream_sequence < boundary.first_retained)`,
      [input.appendedBefore],
    );
    return Object.freeze({ snapshotsDeleted, eventsDeleted });
  }
}

interface ScopedEventRow extends Record<string, unknown> {
  streamSequence: bigint; eventId: string; siteRef: string; aggregateSequence: bigint;
  occurredAt: string; signingPayload: Uint8Array; payloadDigest: string;
  signingKeyRevision: string; signature: Uint8Array; correlationId: string;
}
interface ScopedSiteSnapshotRow extends Record<string, unknown> {
  siteRef: string; aggregateSequence: bigint; state: string; siteSecurityEpoch: bigint;
  policyEpoch: bigint; revocationEpoch: bigint; updatedAt: string; retainUntil: string;
}
interface ScopedSubjectSnapshotRow extends Record<string, unknown> {
  siteRef: string; subjectRef: string; state: string; subjectGeneration: bigint;
  restrictionEpoch: bigint; updatedAt: string; retainUntil: string;
}
interface ScopedIdentitySnapshotRow extends Record<string, unknown> {
  siteRef: string; subjectRef: string; identitySessionRef: string; state: string;
  identitySessionEpoch: bigint; credentialEpoch: bigint; expiresAt: string;
  updatedAt: string; retainUntil: string;
}
interface ScopedMembershipSnapshotRow extends Record<string, unknown> {
  siteRef: string; subjectRef: string; projectRef: string; state: string;
  membershipEpoch: bigint; authorizationEpoch: bigint; updatedAt: string; retainUntil: string;
}
interface ScopedGrantSnapshotRow extends Record<string, unknown> {
  grantRef: string; siteRef: string; subjectRef: string; identitySessionRef: string;
  projectRef: string; purpose: string; audience: string; claimsDigest: string;
  grantKeyRevision: string; siteSecurityEpoch: bigint | null; subjectGeneration: bigint | null;
  identitySessionEpoch: bigint | null; membershipEpoch: bigint | null;
  authorizationEpoch: bigint | null; restrictionEpoch: bigint | null;
  credentialEpoch: bigint | null; policyEpoch: bigint; revocationEpoch: bigint; expiresAt: string;
}
interface ScopedSnapshotRow extends Record<string, unknown> {
  highWatermark: bigint; keySetRevision: string; frozenAt: string; expiresAt: string;
}

function siteSnapshotRecord(row: ScopedSiteSnapshotRow): AuthorizationSnapshotRecord {
  return create(AuthorizationSnapshotRecordSchema, { record: { case: "siteCurrent", value: create(
    SiteCurrentSnapshotSchema, { aggregateSequence: row.aggregateSequence, current: create(SiteCurrentSchema, {
      siteRef: row.siteRef, state: siteState(row.state), siteSecurityEpoch: row.siteSecurityEpoch,
      policyEpoch: row.policyEpoch, siteRevocationEpoch: row.revocationEpoch,
      updatedAt: timestampFromDate(new Date(row.updatedAt)), retainUntil: timestampFromDate(new Date(row.retainUntil)),
    }) },
  ) } });
}
function subjectSnapshotRecord(row: ScopedSubjectSnapshotRow): AuthorizationSnapshotRecord {
  return create(AuthorizationSnapshotRecordSchema, { record: { case: "subjectCurrent", value: create(
    SubjectCurrentSchema, { siteRef: row.siteRef, subjectRef: row.subjectRef,
      state: subjectState(row.state), subjectGeneration: row.subjectGeneration,
      restrictionEpoch: row.restrictionEpoch, updatedAt: timestampFromDate(new Date(row.updatedAt)),
      retainUntil: timestampFromDate(new Date(row.retainUntil)) },
  ) } });
}
function identitySnapshotRecord(row: ScopedIdentitySnapshotRow): AuthorizationSnapshotRecord {
  return create(AuthorizationSnapshotRecordSchema, { record: { case: "identitySessionCurrent", value: create(
    IdentitySessionCurrentSchema, { siteRef: row.siteRef, subjectRef: row.subjectRef,
      identitySessionRef: row.identitySessionRef, state: identityState(row.state),
      identitySessionEpoch: row.identitySessionEpoch, credentialEpoch: row.credentialEpoch,
      expiresAt: timestampFromDate(new Date(row.expiresAt)), updatedAt: timestampFromDate(new Date(row.updatedAt)),
      retainUntil: timestampFromDate(new Date(row.retainUntil)) },
  ) } });
}
function membershipSnapshotRecord(row: ScopedMembershipSnapshotRow): AuthorizationSnapshotRecord {
  return create(AuthorizationSnapshotRecordSchema, { record: { case: "projectMembershipCurrent", value: create(
    ProjectMembershipCurrentSchema, { siteRef: row.siteRef, subjectRef: row.subjectRef,
      projectRef: row.projectRef, state: membershipState(row.state), membershipEpoch: row.membershipEpoch,
      authorizationEpoch: row.authorizationEpoch, updatedAt: timestampFromDate(new Date(row.updatedAt)),
      retainUntil: timestampFromDate(new Date(row.retainUntil)) },
  ) } });
}
function grantSnapshotRecord(row: ScopedGrantSnapshotRow): AuthorizationSnapshotRecord {
  if (row.siteSecurityEpoch === null || row.subjectGeneration === null || row.identitySessionEpoch === null ||
      row.membershipEpoch === null || row.authorizationEpoch === null || row.restrictionEpoch === null ||
      row.credentialEpoch === null) throw new Error("SCOPED_AUTHORIZATION_GRANT_EPOCH_VECTOR_MISSING");
  return create(AuthorizationSnapshotRecordSchema, { record: { case: "deliveredGrant", value: create(
    DeliveredGrantFactSchema, { grantRef: row.grantRef, siteRef: row.siteRef, subjectRef: row.subjectRef,
      identitySessionRef: row.identitySessionRef, projectRef: row.projectRef, purpose: row.purpose,
      audience: row.audience, claimsDigest: row.claimsDigest, grantKeyRevision: row.grantKeyRevision,
      epochs: create(AuthorizationEpochVectorSchema, { siteSecurityEpoch: row.siteSecurityEpoch,
        subjectGeneration: row.subjectGeneration, identitySessionEpoch: row.identitySessionEpoch,
        membershipEpoch: row.membershipEpoch, authorizationEpoch: row.authorizationEpoch,
        restrictionEpoch: row.restrictionEpoch, credentialEpoch: row.credentialEpoch,
        policyEpoch: row.policyEpoch, siteRevocationEpoch: row.revocationEpoch }),
      expiresAt: timestampFromDate(new Date(row.expiresAt)) },
  ) } });
}
function ensureCapacity(current: number, added: number, maximum: number): void {
  if (current + added > maximum) throw new Error("SCOPED_AUTHORIZATION_SNAPSHOT_TOO_LARGE");
}
function bytes(value: Uint8Array): Uint8Array { return new Uint8Array(value); }
function instant(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("SCOPED_AUTHORIZATION_TIME_INVALID");
  return new Date(milliseconds).toISOString();
}
function siteState(value: string): AuthorizationSiteState {
  if (value === "active") return AuthorizationSiteState.ACTIVE;
  if (value === "suspended") return AuthorizationSiteState.SUSPENDED;
  if (value === "decommissioning") return AuthorizationSiteState.DECOMMISSIONING;
  if (value === "decommissioned") return AuthorizationSiteState.DECOMMISSIONED;
  throw new Error("SCOPED_AUTHORIZATION_SITE_STATE_INVALID");
}
function subjectState(value: string): AuthorizationSubjectState {
  if (value === "active") return AuthorizationSubjectState.ACTIVE;
  if (value === "disabled") return AuthorizationSubjectState.DISABLED;
  if (value === "removed") return AuthorizationSubjectState.REMOVED;
  throw new Error("SCOPED_AUTHORIZATION_SUBJECT_STATE_INVALID");
}
function identityState(value: string): AuthorizationIdentitySessionState {
  if (value === "active") return AuthorizationIdentitySessionState.ACTIVE;
  if (value === "revoked") return AuthorizationIdentitySessionState.REVOKED;
  if (value === "expired") return AuthorizationIdentitySessionState.EXPIRED;
  if (value === "removed") return AuthorizationIdentitySessionState.REMOVED;
  throw new Error("SCOPED_AUTHORIZATION_IDENTITY_STATE_INVALID");
}
function membershipState(value: string): AuthorizationProjectMembershipState {
  if (value === "active") return AuthorizationProjectMembershipState.ACTIVE;
  if (value === "revoked") return AuthorizationProjectMembershipState.REVOKED;
  if (value === "removed") return AuthorizationProjectMembershipState.REMOVED;
  throw new Error("SCOPED_AUTHORIZATION_MEMBERSHIP_STATE_INVALID");
}
