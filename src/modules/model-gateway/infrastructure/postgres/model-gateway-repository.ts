import { createHash, randomUUID } from "node:crypto";
import type {
  ModelGatewayInvocationRecord,
  ModelGatewayOutcomeUnknownAuthority,
  ModelGatewayOwnedDispatchAuthority,
  ModelGatewayRepository,
  ModelGatewayRequest,
  ModelGatewayStreamFrame,
  ModelGatewayStreamPayload,
  ModelGatewayStreamingRepository,
  ModelUsageDimension,
} from "../../application/model-gateway-service.js";
import type {
  ModelGatewayResponseEnvelope,
  ModelGatewayResponseProtector,
} from "../crypto/response-protector.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import { modelStreamFrameDigest } from
  "../../../../generated/contracts/model-gateway@v1/digest.js";

interface InvocationRow extends Record<string, unknown> {
  siteId: string;
  invocationRef: string;
  modelAuthorizationHandle: string;
  executionManifestRef: string;
  authorizationSegmentRef: string;
  logicalCallRef: string;
  attemptRef: string;
  producerContext: string;
  producerGeneration: bigint | string;
  requestDigest: string;
  requestEnvelope: unknown;
  gatewayModel: string;
  maximumDimensions: unknown;
  attemptAuthorizationRef: string;
  fenceEpoch: bigint | string;
  state: ModelGatewayInvocationRecord["state"];
  responseEnvelope: unknown;
  evidenceRef: string | null;
  sourceDigest: string | null;
  ownerEvidenceRef: string | null;
  dispatchOwnerRef: string | null;
  dispatchFence: bigint | string;
  dispatchLeaseExpiresAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface FrameRow extends Record<string, unknown> {
  sequence: bigint | string;
  previousFrameDigest: string;
  frameDigest: string;
  frameEnvelope: unknown;
}

interface StreamStateRow extends Record<string, unknown> {
  state: ModelGatewayInvocationRecord["state"];
  dispatchOwnerRef: string | null;
  dispatchFence: bigint | string;
  dispatchLeaseExpiresAt: Date | string | null;
  lastFrameSequence: bigint | string;
  lastFrameDigest: string;
  frameCount: bigint | string;
  totalFrameBytes: bigint | string;
}

export class PostgresModelGatewayRepository implements ModelGatewayRepository, ModelGatewayStreamingRepository {
  readonly #reference: () => string;

  constructor(private readonly dependencies: Readonly<{
    responseProtector: ModelGatewayResponseProtector;
    reference?: () => string;
  }>) {
    this.#reference = dependencies.reference ?? (() => randomUUID());
  }

  async lockInvocation(
    transaction: PlatformTransaction,
    input: Readonly<{ logicalCallRef: string }>,
  ): Promise<ModelGatewayInvocationRecord | null> {
    const rows = await resolvePlatformTransaction(transaction).query<InvocationRow>(
      `${SELECT_INVOCATION} WHERE logical_call_ref=$1 FOR UPDATE`,
      [input.logicalCallRef],
    );
    if (rows.length > 1) throw new Error("MODEL_GATEWAY_INVOCATION_IDENTITY_AMBIGUOUS");
    return rows[0] === undefined ? null : mapInvocation(rows[0], this.dependencies.responseProtector);
  }

  async reserveCapacity(
    transaction: PlatformTransaction,
    limits: Readonly<{ maximumActive: number; maximumQueued: number }>,
  ): Promise<void> {
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.model_gateway_capacity
       SET queued_count=queued_count+1,updated_at=now()
       WHERE singleton=TRUE AND maximum_active=$1 AND maximum_queued=$2
         AND queued_count<$2`,
      [limits.maximumActive, limits.maximumQueued],
    );
    if (changed !== 1) throw new Error("MODEL_GATEWAY_RESOURCE_EXHAUSTED");
  }

  async persistAccepted(
    transaction: PlatformTransaction,
    record: ModelGatewayInvocationRecord,
    request: ModelGatewayRequest,
  ): Promise<ModelGatewayInvocationRecord> {
    if (record.state !== "queued" || record.responseBody !== null || record.usageEvidence !== null ||
        record.evidenceRef !== null || record.ownerEvidenceRef !== null) {
      throw new Error("MODEL_GATEWAY_ACCEPTED_RECORD_INVALID");
    }
    const sql = resolvePlatformTransaction(transaction);
    const requestBody = new TextEncoder().encode(canonical(request));
    if (requestBody.byteLength < 1 || requestBody.byteLength > 2 * 1024 * 1024) {
      throw new Error("MODEL_GATEWAY_REQUEST_ENVELOPE_INVALID");
    }
    const requestEnvelope = this.dependencies.responseProtector.seal(requestBody, {
      ...record,
      purpose: "request",
    });
    const accepted = createFrame(record, 1n, "0".repeat(64), { kind: "accepted" });
    await one(sql.execute(
      `INSERT INTO platform.model_gateway_invocation
       (site_ref,invocation_ref,authorization_handle,execution_manifest_ref,
        authorization_segment_ref,logical_call_ref,attempt_ref,producer_context,
        producer_generation,request_digest,request_envelope,gateway_model,maximum_dimensions,
        attempt_authorization_ref,fence_epoch,state,response_envelope,evidence_ref,
        source_digest,owner_evidence_ref,dispatch_owner_ref,dispatch_fence,
        dispatch_lease_expires_at,last_frame_sequence,last_frame_digest,frame_count,
        total_frame_bytes,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::jsonb,$14,$15,'queued',
         NULL,NULL,NULL,NULL,NULL,0,NULL,1,$16,1,$17,
         date_trunc('milliseconds',statement_timestamp()),
         date_trunc('milliseconds',statement_timestamp()))`,
      [record.siteId, record.invocationRef, record.modelAuthorizationHandle,
        record.executionManifestRef, record.authorizationSegmentRef, record.logicalCallRef,
        record.attemptRef, record.producerContext, record.producerGeneration.toString(),
        record.requestDigest, canonical(requestEnvelope), record.gatewayModel,
        canonical(record.maximumDimensions), record.attemptAuthorizationRef,
        record.fenceEpoch.toString(), accepted.frameDigest,
        framePlaintext(accepted.payload).byteLength],
    ), "MODEL_GATEWAY_ACCEPT_PERSIST_FAILED");
    await one(sql.execute(
      `INSERT INTO platform.model_gateway_dispatch_queue
       (site_ref,invocation_ref,authorization_handle,logical_call_ref,state)
       VALUES ($1,$2,$3,$4,'queued')`,
      [record.siteId, record.invocationRef, record.modelAuthorizationHandle, record.logicalCallRef],
    ), "MODEL_GATEWAY_DISPATCH_QUEUE_PERSIST_FAILED");
    const persisted = await this.lockInvocation(transaction, {
      logicalCallRef: record.logicalCallRef,
    });
    if (persisted === null || persisted.state !== "queued" ||
        persisted.invocationRef !== record.invocationRef ||
        persisted.requestDigest !== record.requestDigest) {
      throw new Error("MODEL_GATEWAY_ACCEPT_PERSISTED_RECORD_INVALID");
    }
    await insertFrame(sql, persisted, accepted, this.dependencies.responseProtector);
    await this.#writeOutbox(sql, persisted, "model_gateway.invocation_prepared.v1");
    return persisted;
  }

  async loadRequest(
    transaction: PlatformTransaction,
    record: ModelGatewayInvocationRecord,
  ): Promise<ModelGatewayRequest> {
    const rows = await resolvePlatformTransaction(transaction).query<Pick<InvocationRow, "requestEnvelope">>(
      `SELECT request_envelope AS "requestEnvelope"
         FROM platform.model_gateway_invocation
        WHERE site_ref=$1 AND invocation_ref=$2 AND request_digest=$3`,
      [record.siteId, record.invocationRef, record.requestDigest],
    );
    if (rows.length !== 1 || rows[0] === undefined) throw new Error("MODEL_GATEWAY_REQUEST_NOT_FOUND");
    const plaintext = this.dependencies.responseProtector.unseal(envelope(rows[0].requestEnvelope), {
      ...record,
      purpose: "request",
    });
    return modelRequest(plaintext);
  }

  async claimInvocation(
    transaction: PlatformTransaction,
    input: Readonly<{
      record: ModelGatewayInvocationRecord;
      ownerInstanceRef: string;
      leaseDurationMs: number;
    }>,
  ): Promise<ModelGatewayInvocationRecord | null> {
    validateLeaseDuration(input.leaseDurationMs);
    const sql = resolvePlatformTransaction(transaction);
    const capacity = await sql.execute(
      `UPDATE platform.model_gateway_capacity
       SET queued_count=queued_count-1,active_count=active_count+1,updated_at=now()
       WHERE singleton=TRUE AND active_count<maximum_active AND queued_count>0`,
    );
    if (capacity === 0) return null;
    await one(sql.execute(
      `UPDATE platform.model_gateway_invocation
       SET state='dispatching',dispatch_owner_ref=$1,dispatch_fence=dispatch_fence+1,
           dispatch_lease_expires_at=date_trunc('milliseconds',clock_timestamp())+
             ($2::bigint*interval '1 millisecond'),
           updated_at=clock_timestamp()
       WHERE site_ref=$3 AND invocation_ref=$4 AND logical_call_ref=$5
         AND request_digest=$6 AND state='queued'`,
      [input.ownerInstanceRef, input.leaseDurationMs.toString(), input.record.siteId,
        input.record.invocationRef, input.record.logicalCallRef, input.record.requestDigest],
    ), "MODEL_GATEWAY_DISPATCH_CLAIM_LOST");
    await one(sql.execute(
      `UPDATE platform.model_gateway_dispatch_queue
       SET state='dispatching',dispatch_owner_ref=$1,
           dispatch_lease_expires_at=date_trunc('milliseconds',clock_timestamp())+
             ($2::bigint*interval '1 millisecond'),
           updated_at=clock_timestamp()
       WHERE site_ref=$3 AND invocation_ref=$4 AND state='queued'`,
      [input.ownerInstanceRef, input.leaseDurationMs.toString(),
        input.record.siteId, input.record.invocationRef],
    ), "MODEL_GATEWAY_DISPATCH_QUEUE_CLAIM_LOST");
    const claimed = await this.lockInvocation(transaction, { logicalCallRef: input.record.logicalCallRef });
    if (claimed === null || claimed.state !== "dispatching") {
      throw new Error("MODEL_GATEWAY_DISPATCH_CLAIM_INVALID");
    }
    return claimed;
  }

  async appendFrame(
    transaction: PlatformTransaction,
    input: Readonly<{
      record: ModelGatewayInvocationRecord;
      ownerInstanceRef: string;
      payload: Extract<ModelGatewayStreamPayload,
        { kind: "content_delta" | "reasoning_delta" | "tool_call_delta" }>;
    }>,
  ): Promise<ModelGatewayStreamFrame> {
    const sql = resolvePlatformTransaction(transaction);
    const state = await streamState(sql, input.record, true);
    if (state.state !== "dispatching" || state.dispatchOwnerRef !== input.ownerInstanceRef ||
        state.dispatchFence !== input.record.dispatchFence || state.dispatchLeaseExpiresAt === null) {
      throw new Error("MODEL_GATEWAY_DISPATCH_FENCE_LOST");
    }
    const frame = createFrame(input.record, state.lastFrameSequence + 1n,
      state.lastFrameDigest, input.payload);
    await advanceFrameState(sql, input.record, frame, {
      ownerInstanceRef: input.ownerInstanceRef,
      dispatchFence: state.dispatchFence,
    });
    await insertFrame(sql, input.record, frame, this.dependencies.responseProtector);
    return frame;
  }

  async heartbeat(
    transaction: PlatformTransaction,
    input: Readonly<{
      record: ModelGatewayInvocationRecord;
      ownerInstanceRef: string;
      leaseDurationMs: number;
    }>,
  ): Promise<ModelGatewayInvocationRecord> {
    validateLeaseDuration(input.leaseDurationMs);
    const sql = resolvePlatformTransaction(transaction);
    await one(sql.execute(
      `UPDATE platform.model_gateway_invocation
       SET dispatch_lease_expires_at=date_trunc('milliseconds',clock_timestamp())+
             ($1::bigint*interval '1 millisecond'),
           updated_at=clock_timestamp()
       WHERE site_ref=$2 AND invocation_ref=$3 AND request_digest=$4
         AND state='dispatching' AND dispatch_owner_ref=$5
         AND dispatch_fence=$6::bigint
         AND dispatch_lease_expires_at>clock_timestamp()`,
      [input.leaseDurationMs.toString(), input.record.siteId, input.record.invocationRef,
        input.record.requestDigest, input.ownerInstanceRef, (input.record.dispatchFence ?? 0n).toString()],
    ), "MODEL_GATEWAY_DISPATCH_HEARTBEAT_FENCE_LOST");
    await one(sql.execute(
      `UPDATE platform.model_gateway_dispatch_queue
       SET dispatch_lease_expires_at=date_trunc('milliseconds',clock_timestamp())+
             ($1::bigint*interval '1 millisecond'),
           updated_at=clock_timestamp()
       WHERE site_ref=$2 AND invocation_ref=$3 AND state='dispatching'
         AND dispatch_owner_ref=$4 AND dispatch_lease_expires_at>clock_timestamp()`,
      [input.leaseDurationMs.toString(), input.record.siteId,
        input.record.invocationRef, input.ownerInstanceRef],
    ), "MODEL_GATEWAY_DISPATCH_QUEUE_HEARTBEAT_FENCE_LOST");
    const current = await this.lockInvocation(transaction, {
      logicalCallRef: input.record.logicalCallRef,
    });
    if (current === null || current.state !== "dispatching" ||
        current.dispatchOwnerRef !== input.ownerInstanceRef ||
        current.dispatchFence !== input.record.dispatchFence) {
      throw new Error("MODEL_GATEWAY_DISPATCH_HEARTBEAT_INVALID");
    }
    return current;
  }

  async appendTerminalFrame(
    transaction: PlatformTransaction,
    record: ModelGatewayInvocationRecord,
    payload: Extract<ModelGatewayStreamPayload, { kind: "completed" | "failed" | "outcome_unknown" }>,
  ): Promise<ModelGatewayStreamFrame> {
    const sql = resolvePlatformTransaction(transaction);
    const state = await streamState(sql, record, true);
    if (!new Set(["succeeded", "failed", "outcome_unknown"]).has(state.state)) {
      throw new Error("MODEL_GATEWAY_TERMINAL_FRAME_STATE_INVALID");
    }
    const frame = createFrame(record, state.lastFrameSequence + 1n,
      state.lastFrameDigest, payload);
    await advanceFrameState(sql, record, frame);
    await insertFrame(sql, record, frame, this.dependencies.responseProtector, true);
    return frame;
  }

  async listFrames(
    transaction: PlatformTransaction,
    input: Readonly<{ record: ModelGatewayInvocationRecord; afterSequence: bigint; limit: number }>,
  ): Promise<readonly ModelGatewayStreamFrame[]> {
    if (input.afterSequence < 0n || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 128) {
      throw new Error("MODEL_GATEWAY_STREAM_CURSOR_INVALID");
    }
    const rows = await resolvePlatformTransaction(transaction).query<FrameRow>(
      `SELECT sequence,previous_frame_digest AS "previousFrameDigest",frame_digest AS "frameDigest",
              frame_envelope AS "frameEnvelope"
         FROM platform.model_gateway_frame
        WHERE site_ref=$1 AND invocation_ref=$2 AND sequence>$3
        ORDER BY sequence ASC LIMIT $4`,
      [input.record.siteId, input.record.invocationRef, input.afterSequence.toString(), input.limit],
    );
    return Object.freeze(rows.map((row) => mapFrame(row, input.record, this.dependencies.responseProtector)));
  }

  async persistTerminal(
    transaction: PlatformTransaction,
    record: ModelGatewayInvocationRecord,
    priorState: "dispatching" | "outcome_unknown",
    authority: ModelGatewayOwnedDispatchAuthority | null,
  ): Promise<void> {
    if (!(["succeeded", "failed"] as const).includes(record.state as "succeeded" | "failed") ||
        record.responseBody === null || record.usageEvidence === null || record.evidenceRef === null ||
        record.sourceDigest === null || record.ownerEvidenceRef !== null || record.fenceEpoch < 2n) {
      throw new Error("MODEL_GATEWAY_TERMINAL_RECORD_INVALID");
    }
    if ((priorState === "dispatching") !== (authority !== null) ||
        (authority !== null && (
          authority.ownerInstanceRef.length < 1 || authority.ownerInstanceRef.length > 256 ||
          /[\0\r\n]/u.test(authority.ownerInstanceRef) || authority.dispatchFence <= 0n
        ))) {
      throw new Error("MODEL_GATEWAY_TERMINAL_AUTHORITY_INVALID");
    }
    const sql = resolvePlatformTransaction(transaction);
    const envelope = this.dependencies.responseProtector.seal(record.responseBody, record);
    await one(sql.execute(
      `UPDATE platform.model_gateway_invocation
       SET state=$1,response_envelope=$2::jsonb,evidence_ref=$3,source_digest=$4,owner_evidence_ref=NULL,
           fence_epoch=$5,updated_at=$6::timestamptz
       WHERE site_ref=$7 AND invocation_ref=$8 AND logical_call_ref=$9
         AND request_digest=$10
         AND state=$12
         AND ($12='outcome_unknown' OR
           (dispatch_owner_ref=$11 AND dispatch_fence=$13::bigint
             AND dispatch_lease_expires_at>clock_timestamp()))
         AND fence_epoch=($5::bigint-1)`,
      [record.state, canonical(envelope), record.evidenceRef, record.sourceDigest,
        record.fenceEpoch.toString(), record.updatedAt, record.siteId, record.invocationRef,
        record.logicalCallRef, record.requestDigest, authority?.ownerInstanceRef ?? "", priorState,
        (authority?.dispatchFence ?? 0n).toString()],
    ), "MODEL_GATEWAY_TERMINAL_CAS_LOST");
    if (priorState === "dispatching") {
      await one(sql.execute(
        `UPDATE platform.model_gateway_capacity
         SET active_count=active_count-1,updated_at=now()
         WHERE singleton=TRUE AND active_count>0`,
      ), "MODEL_GATEWAY_CAPACITY_RELEASE_FAILED");
      await one(sql.execute(
        `UPDATE platform.model_gateway_dispatch_queue
         SET state='terminal',updated_at=now()
         WHERE site_ref=$1 AND invocation_ref=$2 AND state='dispatching'`,
        [record.siteId, record.invocationRef],
      ), "MODEL_GATEWAY_DISPATCH_QUEUE_TERMINAL_FAILED");
    }
    await one(sql.execute(
      `INSERT INTO platform.model_gateway_attempt_usage_fact
       (site_ref,evidence_ref,invocation_ref,attempt_authorization_ref,evidence_kind,
        dimensions,attempt_outcome,source_digest,occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::timestamptz)`,
      [record.siteId, record.evidenceRef, record.invocationRef,
        record.attemptAuthorizationRef, record.usageEvidence.evidenceKind,
        canonical(record.usageEvidence.dimensions), record.usageEvidence.attemptOutcome,
        record.sourceDigest, record.usageEvidence.occurredAt],
    ), "MODEL_GATEWAY_USAGE_FACT_PERSIST_FAILED");
    await this.#writeOutbox(sql, record, "model_gateway.invocation_finalized.v1");
  }

  async persistOutcomeUnknown(
    transaction: PlatformTransaction,
    record: ModelGatewayInvocationRecord,
    authority: ModelGatewayOutcomeUnknownAuthority,
  ): Promise<void> {
    if (record.state !== "outcome_unknown" || record.responseBody !== null ||
        record.usageEvidence !== null || record.evidenceRef !== null ||
        record.sourceDigest !== null || record.ownerEvidenceRef === null) {
      throw new Error("MODEL_GATEWAY_UNKNOWN_RECORD_INVALID");
    }
    const sql = resolvePlatformTransaction(transaction);
    const ownerInstanceRef = authority.kind === "owned"
      ? authority.ownerInstanceRef
      : authority.observedOwnerInstanceRef;
    const dispatchFence = authority.kind === "owned"
      ? authority.dispatchFence
      : authority.observedDispatchFence;
    const observedLeaseExpiresAt = authority.kind === "expired"
      ? authority.observedLeaseExpiresAt
      : record.dispatchLeaseExpiresAt ?? record.updatedAt;
    await one(sql.execute(
      `UPDATE platform.model_gateway_invocation
       SET state='outcome_unknown',owner_evidence_ref=$1,fence_epoch=$2,updated_at=$3::timestamptz
       WHERE site_ref=$4 AND invocation_ref=$5 AND logical_call_ref=$6
         AND request_digest=$7 AND state='dispatching' AND fence_epoch<$2
         AND dispatch_owner_ref=$8 AND dispatch_fence=$9::bigint
         AND (($10='owned' AND dispatch_lease_expires_at>clock_timestamp())
           OR ($10='expired' AND dispatch_lease_expires_at=$11::timestamptz
             AND dispatch_lease_expires_at<=clock_timestamp()))`,
      [record.ownerEvidenceRef, record.fenceEpoch.toString(), record.updatedAt,
        record.siteId, record.invocationRef, record.logicalCallRef, record.requestDigest,
        ownerInstanceRef, dispatchFence.toString(), authority.kind, observedLeaseExpiresAt],
    ), "MODEL_GATEWAY_UNKNOWN_CAS_LOST");
    await one(sql.execute(
      `UPDATE platform.model_gateway_capacity
       SET active_count=active_count-1,updated_at=now()
       WHERE singleton=TRUE AND active_count>0`,
    ), "MODEL_GATEWAY_CAPACITY_RELEASE_FAILED");
    await one(sql.execute(
      `UPDATE platform.model_gateway_dispatch_queue
       SET state='terminal',updated_at=now()
       WHERE site_ref=$1 AND invocation_ref=$2 AND state='dispatching'`,
      [record.siteId, record.invocationRef],
    ), "MODEL_GATEWAY_DISPATCH_QUEUE_TERMINAL_FAILED");
    await this.#writeOutbox(sql, record, "model_gateway.invocation_outcome_unknown.v1");
  }

  async #writeOutbox(
    sql: ReturnType<typeof resolvePlatformTransaction>,
    record: ModelGatewayInvocationRecord,
    eventKind: "model_gateway.invocation_prepared.v1" |
      "model_gateway.invocation_finalized.v1" |
      "model_gateway.invocation_outcome_unknown.v1",
  ): Promise<void> {
    const payload = canonical({
      invocationRef: record.invocationRef,
      logicalCallRef: record.logicalCallRef,
      attemptRef: record.attemptRef,
      attemptAuthorizationRef: record.attemptAuthorizationRef,
      state: record.state,
      evidenceRef: record.evidenceRef,
      ownerEvidenceRef: record.ownerEvidenceRef,
      occurredAt: record.updatedAt,
    });
    await one(sql.execute(
      `INSERT INTO platform.model_gateway_outbox
       (site_ref,event_ref,aggregate_ref,event_kind,payload,payload_digest)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [record.siteId, this.#reference(), record.invocationRef, eventKind, payload, digest(payload)],
    ), "MODEL_GATEWAY_OUTBOX_PERSIST_FAILED");
  }
}

function mapInvocation(
  row: InvocationRow,
  protector: ModelGatewayResponseProtector,
): ModelGatewayInvocationRecord {
  if (!new Set(["queued", "dispatching", "succeeded", "failed", "outcome_unknown"]).has(row.state)) {
    throw new Error("MODEL_GATEWAY_INVOCATION_ROW_INVALID");
  }
  const base = {
    siteId: text(row.siteId), invocationRef: text(row.invocationRef),
    modelAuthorizationHandle: text(row.modelAuthorizationHandle),
    executionManifestRef: text(row.executionManifestRef),
    authorizationSegmentRef: text(row.authorizationSegmentRef),
    logicalCallRef: text(row.logicalCallRef), attemptRef: text(row.attemptRef),
    producerContext: text(row.producerContext), producerGeneration: positive(row.producerGeneration),
    requestDigest: hex(row.requestDigest), gatewayModel: text(row.gatewayModel),
    maximumDimensions: dimensions(row.maximumDimensions),
    attemptAuthorizationRef: text(row.attemptAuthorizationRef), fenceEpoch: positive(row.fenceEpoch),
    state: row.state, evidenceRef: nullableText(row.evidenceRef),
    sourceDigest: row.sourceDigest === null ? null : hex(row.sourceDigest),
    ownerEvidenceRef: nullableText(row.ownerEvidenceRef),
    dispatchOwnerRef: nullableText(row.dispatchOwnerRef),
    dispatchFence: BigInt(row.dispatchFence),
    dispatchLeaseExpiresAt: row.dispatchLeaseExpiresAt === null ? null : instant(row.dispatchLeaseExpiresAt),
    createdAt: instant(row.createdAt), updatedAt: instant(row.updatedAt),
    usageEvidence: null,
  } as const;
  const responseBody = row.responseEnvelope === null
    ? null
    : protector.unseal(envelope(row.responseEnvelope), base);
  return Object.freeze({ ...base, responseBody });
}

function envelope(value: unknown): ModelGatewayResponseEnvelope {
  if (!object(value) || value.algorithm !== "A256GCM" ||
      ![value.keyRevision, value.nonce, value.ciphertext, value.authenticationTag]
        .every((item) => typeof item === "string")) {
    throw new Error("MODEL_GATEWAY_RESPONSE_ENVELOPE_INVALID");
  }
  return value as ModelGatewayResponseEnvelope;
}

async function streamState(
  sql: ReturnType<typeof resolvePlatformTransaction>,
  record: ModelGatewayInvocationRecord,
  lock: boolean,
): Promise<Readonly<{
  state: ModelGatewayInvocationRecord["state"];
  dispatchOwnerRef: string | null;
  dispatchFence: bigint;
  dispatchLeaseExpiresAt: string | null;
  lastFrameSequence: bigint;
  lastFrameDigest: string;
  frameCount: bigint;
  totalFrameBytes: bigint;
}>> {
  const rows = await sql.query<StreamStateRow>(
    `SELECT state,dispatch_owner_ref AS "dispatchOwnerRef",dispatch_fence AS "dispatchFence",
            dispatch_lease_expires_at AS "dispatchLeaseExpiresAt",
            last_frame_sequence AS "lastFrameSequence",last_frame_digest AS "lastFrameDigest",
            frame_count AS "frameCount",total_frame_bytes AS "totalFrameBytes"
       FROM platform.model_gateway_invocation
      WHERE site_ref=$1 AND invocation_ref=$2 AND request_digest=$3${lock ? " FOR UPDATE" : ""}`,
    [record.siteId, record.invocationRef, record.requestDigest],
  );
  const row = rows[0];
  if (row === undefined || rows.length !== 1 || !/^[0-9a-f]{64}$/u.test(row.lastFrameDigest)) {
    throw new Error("MODEL_GATEWAY_STREAM_STATE_INVALID");
  }
  return Object.freeze({
    state: row.state,
    dispatchOwnerRef: row.dispatchOwnerRef,
    dispatchFence: BigInt(row.dispatchFence),
    dispatchLeaseExpiresAt: row.dispatchLeaseExpiresAt === null ? null : instant(row.dispatchLeaseExpiresAt),
    lastFrameSequence: BigInt(row.lastFrameSequence),
    lastFrameDigest: row.lastFrameDigest,
    frameCount: BigInt(row.frameCount),
    totalFrameBytes: BigInt(row.totalFrameBytes),
  });
}

function createFrame(
  record: ModelGatewayInvocationRecord,
  sequence: bigint,
  previousFrameDigest: string,
  payload: ModelGatewayStreamPayload,
): ModelGatewayStreamFrame {
  const plaintext = framePlaintext(payload);
  const frameDigest = modelStreamFrameDigest({
    invocationRef: record.invocationRef,
    attemptRef: record.attemptRef,
    sequence,
    previousFrameDigest,
    payloadKind: payload.kind,
    payloadBytes: plaintext,
  });
  return Object.freeze({
    invocationRef: record.invocationRef,
    attemptRef: record.attemptRef,
    sequence,
    previousFrameDigest,
    frameDigest,
    payload,
  });
}

async function insertFrame(
  sql: ReturnType<typeof resolvePlatformTransaction>,
  record: ModelGatewayInvocationRecord,
  frame: ModelGatewayStreamFrame,
  protector: ModelGatewayResponseProtector,
  terminal = false,
): Promise<void> {
  const plaintext = framePlaintext(frame.payload);
  const frameEnvelope = protector.seal(plaintext, {
    ...record,
    purpose: "frame",
    sequence: frame.sequence,
    previousFrameDigest: frame.previousFrameDigest,
  });
  await one(sql.execute(
    `INSERT INTO platform.model_gateway_frame
     (site_ref,invocation_ref,sequence,previous_frame_digest,frame_digest,
      frame_envelope,plaintext_bytes,terminal)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
    [record.siteId, record.invocationRef, frame.sequence.toString(),
      frame.previousFrameDigest, frame.frameDigest, canonical(frameEnvelope),
      plaintext.byteLength, terminal],
  ), "MODEL_GATEWAY_FRAME_PERSIST_FAILED");
}

async function advanceFrameState(
  sql: ReturnType<typeof resolvePlatformTransaction>,
  record: ModelGatewayInvocationRecord,
  frame: ModelGatewayStreamFrame,
  authority?: ModelGatewayOwnedDispatchAuthority,
): Promise<void> {
  const bytes = framePlaintext(frame.payload).byteLength;
  const liveFence = authority === undefined
    ? ""
    : ` AND state='dispatching' AND dispatch_owner_ref=$9
       AND dispatch_fence=$10::bigint AND dispatch_lease_expires_at>clock_timestamp()`;
  await one(sql.execute(
    `UPDATE platform.model_gateway_invocation
     SET last_frame_sequence=$1,last_frame_digest=$2,frame_count=frame_count+1,
         total_frame_bytes=total_frame_bytes+$3,
         updated_at=GREATEST(updated_at,clock_timestamp())
     WHERE site_ref=$4 AND invocation_ref=$5 AND request_digest=$6
       AND last_frame_sequence=$7 AND last_frame_digest=$8
       AND frame_count<65536 AND total_frame_bytes+$3<=33554432${liveFence}`,
    [frame.sequence.toString(), frame.frameDigest, bytes, record.siteId,
      record.invocationRef, record.requestDigest, (frame.sequence - 1n).toString(),
      frame.previousFrameDigest,
      ...(authority === undefined
        ? []
        : [authority.ownerInstanceRef, authority.dispatchFence.toString()])],
  ), "MODEL_GATEWAY_FRAME_BOUNDS_OR_FENCE_LOST");
}

function mapFrame(
  row: FrameRow,
  record: ModelGatewayInvocationRecord,
  protector: ModelGatewayResponseProtector,
): ModelGatewayStreamFrame {
  const sequence = positive(row.sequence);
  const previousFrameDigest = hex(row.previousFrameDigest);
  const frameDigest = hex(row.frameDigest);
  const plaintext = protector.unseal(envelope(row.frameEnvelope), {
    ...record,
    purpose: "frame",
    sequence,
    previousFrameDigest,
  });
  const payload = parseFramePlaintext(plaintext);
  const expected = modelStreamFrameDigest({
    invocationRef: record.invocationRef,
    attemptRef: record.attemptRef,
    sequence,
    previousFrameDigest,
    payloadKind: payload.kind,
    payloadBytes: plaintext,
  });
  if (expected !== frameDigest) throw new Error("MODEL_GATEWAY_FRAME_DIGEST_INVALID");
  return Object.freeze({
    invocationRef: record.invocationRef,
    attemptRef: record.attemptRef,
    sequence,
    previousFrameDigest,
    frameDigest,
    payload,
  });
}

function framePlaintext(payload: ModelGatewayStreamPayload): Uint8Array {
  const serializable = payload.kind === "tool_call_delta"
    ? { ...payload, argumentsJsonFragment: Buffer.from(payload.argumentsJsonFragment).toString("base64url") }
    : payload.kind === "completed" || payload.kind === "failed"
      ? { ...payload, responseBody: Buffer.from(payload.responseBody).toString("base64url") }
      : payload;
  const bytes = new TextEncoder().encode(canonical(serializable));
  const maximum = payload.kind === "completed" || payload.kind === "failed"
    ? 12 * 1024 * 1024
    : 32 * 1024;
  if (bytes.byteLength < 1 || bytes.byteLength > maximum) {
    throw new Error("MODEL_GATEWAY_FRAME_PLAINTEXT_INVALID");
  }
  return bytes;
}

function modelRequest(bytes: Uint8Array): ModelGatewayRequest {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch {
    throw new Error("MODEL_GATEWAY_REQUEST_ENVELOPE_INVALID");
  }
  if (!object(value) || value.protocol !== "openai.chat.completions.v1" ||
      typeof value.model !== "string" || !Array.isArray(value.messages) ||
      typeof value.maxOutputTokens !== "number" || !Array.isArray(value.tools) ||
      !(typeof value.toolChoice === "string" || object(value.toolChoice))) {
    throw new Error("MODEL_GATEWAY_REQUEST_ENVELOPE_INVALID");
  }
  return value as unknown as ModelGatewayRequest;
}

function parseFramePlaintext(bytes: Uint8Array): ModelGatewayStreamPayload {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch {
    throw new Error("MODEL_GATEWAY_FRAME_PLAINTEXT_INVALID");
  }
  if (!object(value) || typeof value.kind !== "string") {
    throw new Error("MODEL_GATEWAY_FRAME_PLAINTEXT_INVALID");
  }
  if (value.kind === "accepted" || value.kind === "outcome_unknown") return Object.freeze({ kind: value.kind });
  if ((value.kind === "content_delta" || value.kind === "reasoning_delta") &&
      typeof value.content === "string") return Object.freeze({ kind: value.kind, content: value.content });
  if (value.kind === "tool_call_delta" && typeof value.toolIndex === "number" &&
      typeof value.argumentsJsonFragment === "string") {
    return Object.freeze({
      kind: "tool_call_delta",
      toolIndex: value.toolIndex,
      ...(typeof value.id === "string" ? { id: value.id } : {}),
      ...(typeof value.name === "string" ? { name: value.name } : {}),
      argumentsJsonFragment: Uint8Array.from(Buffer.from(value.argumentsJsonFragment, "base64url")),
    });
  }
  if ((value.kind === "completed" || value.kind === "failed") && typeof value.responseBody === "string") {
    return Object.freeze({
      kind: value.kind,
      responseBody: Uint8Array.from(Buffer.from(value.responseBody, "base64url")),
    });
  }
  throw new Error("MODEL_GATEWAY_FRAME_PLAINTEXT_INVALID");
}

function dimensions(value: unknown): readonly ModelUsageDimension[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw new Error("MODEL_GATEWAY_MAXIMUM_DIMENSIONS_CORRUPT");
  }
  const keys = new Set<string>();
  return Object.freeze(value.map((item) => {
    if (!object(item) || typeof item.dimensionKey !== "string" ||
        typeof item.sourceUnit !== "string" || typeof item.quantity !== "string" ||
        keys.has(item.dimensionKey)) {
      throw new Error("MODEL_GATEWAY_MAXIMUM_DIMENSIONS_CORRUPT");
    }
    keys.add(item.dimensionKey);
    const quantity = BigInt(item.quantity);
    if (quantity < 0n) throw new Error("MODEL_GATEWAY_MAXIMUM_DIMENSIONS_CORRUPT");
    return Object.freeze({
      dimensionKey: item.dimensionKey, sourceUnit: item.sourceUnit, quantity,
    });
  }));
}

function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: string): string {
  if (value.length < 1 || value.length > 256 || /[\0\r\n]/u.test(value)) {
    throw new Error("MODEL_GATEWAY_INVOCATION_ROW_INVALID");
  }
  return value;
}
function nullableText(value: string | null): string | null { return value === null ? null : text(value); }
function positive(value: bigint | string): bigint {
  const parsed = BigInt(value);
  if (parsed < 1n) throw new Error("MODEL_GATEWAY_INVOCATION_ROW_INVALID");
  return parsed;
}
function hex(value: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error("MODEL_GATEWAY_INVOCATION_ROW_INVALID");
  return value;
}
function instant(value: Date | string): string {
  const result = value instanceof Date ? value.toISOString() : value;
  if (!Number.isFinite(Date.parse(result))) throw new Error("MODEL_GATEWAY_INVOCATION_ROW_INVALID");
  return result;
}
function validateLeaseDuration(value: number): void {
  if (!Number.isInteger(value) || value < 1_000 || value > 600_000) {
    throw new Error("MODEL_GATEWAY_DISPATCH_LEASE_DURATION_INVALID");
  }
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
async function one(change: Promise<number>, code: string): Promise<void> {
  if (await change !== 1) throw new Error(code);
}

const SELECT_INVOCATION = `SELECT site_ref AS "siteId",invocation_ref AS "invocationRef",
  authorization_handle AS "modelAuthorizationHandle",execution_manifest_ref AS "executionManifestRef",
  authorization_segment_ref AS "authorizationSegmentRef",logical_call_ref AS "logicalCallRef",
  attempt_ref AS "attemptRef",producer_context AS "producerContext",
  producer_generation AS "producerGeneration",request_digest AS "requestDigest",
  request_envelope AS "requestEnvelope",
  gateway_model AS "gatewayModel",maximum_dimensions AS "maximumDimensions",
  attempt_authorization_ref AS "attemptAuthorizationRef",fence_epoch AS "fenceEpoch",
  state,response_envelope AS "responseEnvelope",evidence_ref AS "evidenceRef",
  source_digest AS "sourceDigest",owner_evidence_ref AS "ownerEvidenceRef",
  dispatch_owner_ref AS "dispatchOwnerRef",dispatch_fence AS "dispatchFence",
  dispatch_lease_expires_at AS "dispatchLeaseExpiresAt",
  created_at AS "createdAt",updated_at AS "updatedAt"
  FROM platform.model_gateway_invocation`;
