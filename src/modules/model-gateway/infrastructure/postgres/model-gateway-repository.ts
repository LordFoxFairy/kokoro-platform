import { createHash, randomUUID } from "node:crypto";
import type {
  ModelGatewayInvocationRecord,
  ModelGatewayRepository,
  ModelUsageDimension,
} from "../../application/model-gateway-service.js";
import type {
  ModelGatewayResponseEnvelope,
  ModelGatewayResponseProtector,
} from "../crypto/response-protector.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";

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
  gatewayModel: string;
  maximumDimensions: unknown;
  attemptAuthorizationRef: string;
  fenceEpoch: bigint | string;
  state: ModelGatewayInvocationRecord["state"];
  responseEnvelope: unknown;
  evidenceRef: string | null;
  sourceDigest: string | null;
  ownerEvidenceRef: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export class PostgresModelGatewayRepository implements ModelGatewayRepository {
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

  async persistPrepared(
    transaction: PlatformTransaction,
    record: ModelGatewayInvocationRecord,
  ): Promise<void> {
    if (record.state !== "dispatching" || record.responseBody !== null ||
        record.usageEvidence !== null || record.evidenceRef !== null ||
        record.ownerEvidenceRef !== null) {
      throw new Error("MODEL_GATEWAY_PREPARED_RECORD_INVALID");
    }
    const sql = resolvePlatformTransaction(transaction);
    await one(sql.execute(
      `INSERT INTO platform.model_gateway_invocation
       (site_ref,invocation_ref,authorization_handle,execution_manifest_ref,
        authorization_segment_ref,logical_call_ref,attempt_ref,producer_context,
        producer_generation,request_digest,gateway_model,maximum_dimensions,
        attempt_authorization_ref,fence_epoch,state,response_envelope,evidence_ref,
        source_digest,owner_evidence_ref,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,'dispatching',
         NULL,NULL,NULL,NULL,$15::timestamptz,$16::timestamptz)`,
      [record.siteId, record.invocationRef, record.modelAuthorizationHandle,
        record.executionManifestRef, record.authorizationSegmentRef, record.logicalCallRef,
        record.attemptRef, record.producerContext, record.producerGeneration.toString(),
        record.requestDigest, record.gatewayModel, canonical(record.maximumDimensions),
        record.attemptAuthorizationRef, record.fenceEpoch.toString(), record.createdAt,
        record.updatedAt],
    ), "MODEL_GATEWAY_PREPARE_PERSIST_FAILED");
    await this.#writeOutbox(sql, record, "model_gateway.invocation_prepared.v1");
  }

  async persistTerminal(
    transaction: PlatformTransaction,
    record: ModelGatewayInvocationRecord,
  ): Promise<void> {
    if (!(["succeeded", "failed"] as const).includes(record.state as "succeeded" | "failed") ||
        record.responseBody === null || record.usageEvidence === null || record.evidenceRef === null ||
        record.sourceDigest === null || record.ownerEvidenceRef !== null || record.fenceEpoch < 2n) {
      throw new Error("MODEL_GATEWAY_TERMINAL_RECORD_INVALID");
    }
    const sql = resolvePlatformTransaction(transaction);
    const envelope = this.dependencies.responseProtector.seal(record.responseBody, record);
    await one(sql.execute(
      `UPDATE platform.model_gateway_invocation
       SET state=$1,response_envelope=$2::jsonb,evidence_ref=$3,source_digest=$4,owner_evidence_ref=NULL,
           fence_epoch=$5,updated_at=$6::timestamptz
       WHERE site_ref=$7 AND invocation_ref=$8 AND logical_call_ref=$9
         AND request_digest=$10 AND state IN ('dispatching','outcome_unknown')
         AND fence_epoch=($5::bigint-1)`,
      [record.state, canonical(envelope), record.evidenceRef, record.sourceDigest,
        record.fenceEpoch.toString(), record.updatedAt, record.siteId, record.invocationRef,
        record.logicalCallRef, record.requestDigest],
    ), "MODEL_GATEWAY_TERMINAL_CAS_LOST");
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
  ): Promise<void> {
    if (record.state !== "outcome_unknown" || record.responseBody !== null ||
        record.usageEvidence !== null || record.evidenceRef !== null ||
        record.sourceDigest !== null || record.ownerEvidenceRef === null) {
      throw new Error("MODEL_GATEWAY_UNKNOWN_RECORD_INVALID");
    }
    const sql = resolvePlatformTransaction(transaction);
    await one(sql.execute(
      `UPDATE platform.model_gateway_invocation
       SET state='outcome_unknown',owner_evidence_ref=$1,fence_epoch=$2,updated_at=$3::timestamptz
       WHERE site_ref=$4 AND invocation_ref=$5 AND logical_call_ref=$6
         AND request_digest=$7 AND state='dispatching' AND fence_epoch<$2`,
      [record.ownerEvidenceRef, record.fenceEpoch.toString(), record.updatedAt,
        record.siteId, record.invocationRef, record.logicalCallRef, record.requestDigest],
    ), "MODEL_GATEWAY_UNKNOWN_CAS_LOST");
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
  if (!new Set(["dispatching", "succeeded", "failed", "outcome_unknown"]).has(row.state)) {
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
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
async function one(change: Promise<number>, code: string): Promise<void> {
  if (await change !== 1) throw new Error(code);
}

const SELECT_INVOCATION = `SELECT site_ref AS "siteId",invocation_ref AS "invocationRef",
  authorization_handle AS "modelAuthorizationHandle",execution_manifest_ref AS "executionManifestRef",
  authorization_segment_ref AS "authorizationSegmentRef",logical_call_ref AS "logicalCallRef",
  attempt_ref AS "attemptRef",producer_context AS "producerContext",
  producer_generation AS "producerGeneration",request_digest AS "requestDigest",
  gateway_model AS "gatewayModel",maximum_dimensions AS "maximumDimensions",
  attempt_authorization_ref AS "attemptAuthorizationRef",fence_epoch AS "fenceEpoch",
  state,response_envelope AS "responseEnvelope",evidence_ref AS "evidenceRef",
  source_digest AS "sourceDigest",owner_evidence_ref AS "ownerEvidenceRef",
  created_at AS "createdAt",updated_at AS "updatedAt"
  FROM platform.model_gateway_invocation`;
