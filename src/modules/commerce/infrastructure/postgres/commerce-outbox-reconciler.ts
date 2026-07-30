import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { PlatformTransactionalDatabaseClient } from
  "../../../../infrastructure/postgres/client.js";
import { commerceCanonicalJson } from "../../domain/canonical-json.js";
import { OutboxRepository, type ClaimedOutboxEvent, type OutboxDeliveryAcknowledgement } from
  "../../../../shared/outbox-inbox/outbox.js";
import { resolvePlatformTransaction, type PlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";

type CommerceFulfillmentEvent = Readonly<{
  version: 1;
  siteId: string;
  redemptionId: string;
  commandId: string;
  fulfillmentId: string;
  outputSetDigest: string;
  redeemedAt: string;
}>;

export interface CommerceOutboxProjection {
  assertDeliverable(transaction: PlatformTransaction, event: ClaimedOutboxEvent): Promise<void>;
}

export interface OutboxDeliveryTransport {
  publish(event: ClaimedOutboxEvent, signal: AbortSignal): Promise<OutboxDeliveryAcknowledgement>;
}

export class PostgresCommerceOutboxProjection implements CommerceOutboxProjection {
  async assertDeliverable(transaction: PlatformTransaction, event: ClaimedOutboxEvent): Promise<void> {
    if (event.owner === "commerce") {
      const payload = fulfillmentEvent(event);
      await bindSite(transaction, payload.siteId);
      return this.#assertCommerce(transaction, payload);
    }
    if (event.owner === "credit") {
      const payload = creditEvent(event);
      await bindSite(transaction, payload.siteId);
      return this.#assertCredit(transaction, payload);
    }
    throw new Error("OUTBOX_OWNER_UNSUPPORTED");
  }

  async #assertCommerce(transaction: PlatformTransaction, event: CommerceFulfillmentEvent): Promise<void> {
    const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown> & {
      outputSetDigest: string;
      redeemedAt: Date | string;
    }>(
      `SELECT fulfillment.output_set_digest AS "outputSetDigest",redemption.redeemed_at AS "redeemedAt"
       FROM platform.commerce_redemption redemption
       JOIN platform.commerce_fulfillment_transaction fulfillment
         ON fulfillment.fulfillment_id=redemption.fulfillment_ref AND fulfillment.site_ref=redemption.site_ref
       WHERE redemption.redemption_id=$1::uuid AND redemption.site_ref=$2 AND redemption.command_id=$3
         AND redemption.fulfillment_ref=$4::uuid AND redemption.state='fulfilled'
         AND fulfillment.status='succeeded'`,
      [event.redemptionId, event.siteId, event.commandId, event.fulfillmentId],
    );
    const row = rows[0];
    if (row === undefined || rows.length !== 1 || row.outputSetDigest !== event.outputSetDigest ||
      instant(row.redeemedAt) !== event.redeemedAt) throw new Error("COMMERCE_OUTBOX_PROJECTION_MISMATCH");
  }

  async #assertCredit(
    transaction: PlatformTransaction,
    event: ReturnType<typeof creditEvent>,
  ): Promise<void> {
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
      commerceCanonicalJson(row.result as Parameters<typeof commerceCanonicalJson>[0]) !==
        commerceCanonicalJson(event.result)) throw new Error("CREDIT_OUTBOX_PROJECTION_MISMATCH");
  }
}

export class HmacHttpOutboxDeliveryTransport implements OutboxDeliveryTransport {
  readonly #endpoint: URL;
  readonly #keyId: string;
  readonly #secret: Buffer;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(input: Readonly<{ endpoint: string; keyId: string; secretBase64: string; timeoutMs?: number; fetch?: typeof fetch }>) {
    this.#endpoint = new URL(input.endpoint);
    if (this.#endpoint.protocol !== "https:") throw new Error("OUTBOX_DELIVERY_HTTPS_REQUIRED");
    if (!bounded(input.keyId, 128)) throw new Error("OUTBOX_DELIVERY_KEY_ID_INVALID");
    this.#secret = Buffer.from(input.secretBase64, "base64");
    if (this.#secret.byteLength < 32) throw new Error("OUTBOX_DELIVERY_SECRET_INVALID");
    this.#keyId = input.keyId;
    this.#fetch = input.fetch ?? fetch;
    this.#timeoutMs = input.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 100 || this.#timeoutMs > 60_000) {
      throw new Error("OUTBOX_DELIVERY_TIMEOUT_INVALID");
    }
  }

  async publish(event: ClaimedOutboxEvent, signal: AbortSignal): Promise<OutboxDeliveryAcknowledgement> {
    const body = commerceCanonicalJson({
      eventId: event.eventId, owner: event.owner, eventType: event.eventType,
      aggregateId: event.aggregateId, payload: event.payload, payloadDigest: event.payloadDigest,
      correlationId: event.correlationId, causationId: event.causationId,
    });
    const response = await this.#fetch(this.#endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-kokoro-delivery-key-id": this.#keyId,
        "x-kokoro-delivery-signature": mac(this.#secret, body),
      },
      body,
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]),
    });
    if (!response.ok) throw new Error(`OUTBOX_DELIVERY_HTTP_${response.status}`);
    const value: unknown = await boundedJson(response, 16 * 1024);
    if (!isRecord(value) || value.eventId !== event.eventId || !bounded(value.deliveryId, 128) ||
      typeof value.acknowledgedAt !== "string" || !Number.isFinite(Date.parse(value.acknowledgedAt)) ||
      typeof value.acknowledgementMac !== "string") throw new Error("OUTBOX_DELIVERY_ACK_INVALID");
    const acknowledgedAt = new Date(value.acknowledgedAt).toISOString();
    const expected = mac(this.#secret, commerceCanonicalJson({
      eventId: event.eventId, deliveryId: value.deliveryId,
      acknowledgedAt, payloadDigest: event.payloadDigest,
    }));
    if (!safeEqual(value.acknowledgementMac, expected)) throw new Error("OUTBOX_DELIVERY_ACK_SIGNATURE_INVALID");
    return Object.freeze({ deliveryId: value.deliveryId, acknowledgedAt });
  }
}

export function createCommerceOutboxReconciliationCycle(input: Readonly<{
  database: Pick<PlatformTransactionalDatabaseClient, "internalTransaction">;
  transport: OutboxDeliveryTransport;
  outbox?: Pick<OutboxRepository, "claim" | "complete" | "retryOrDeadLetter">;
  projection?: CommerceOutboxProjection;
  workerId: string;
  batchSize?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
  clock?: () => Date;
  leaseToken?: () => string;
}>): (context: Readonly<{ signal: AbortSignal }>) => Promise<void> {
  const outbox = input.outbox ?? new OutboxRepository();
  const projection = input.projection ?? new PostgresCommerceOutboxProjection();
  const batchSize = input.batchSize ?? 25;
  const leaseSeconds = input.leaseSeconds ?? 30;
  const maxAttempts = input.maxAttempts ?? 10;
  const clock = input.clock ?? (() => new Date());
  const leaseToken = input.leaseToken ?? randomUUID;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new Error("OUTBOX_MAX_ATTEMPTS_INVALID");
  }
  return async ({ signal }) => {
    signal.throwIfAborted();
    const events = await input.database.internalTransaction("commerce.outbox.reconcile", (transaction) =>
      outbox.claim(transaction, {
        workerId: input.workerId, leaseToken: leaseToken(), consumer: "commerce-worker",
        limit: batchSize, leaseSeconds,
      }));
    for (const event of events) {
      signal.throwIfAborted();
      try {
        await input.database.internalTransaction("commerce.outbox.reconcile", (transaction) =>
          projection.assertDeliverable(transaction, event));
        const acknowledgement = await input.transport.publish(event, signal);
        await input.database.internalTransaction("commerce.outbox.reconcile", (transaction) =>
          outbox.complete(transaction, { eventId: event.eventId, leaseToken: event.leaseToken, ...acknowledgement }));
      } catch (error) {
        // A process drain is not a failed delivery attempt. Leave the claimed row untouched so
        // its existing lease can expire and a replacement worker can reconcile the same effect
        // without consuming retry budget or manufacturing dead-letter evidence.
        if (signal.aborted) throw error;
        const terminal = event.attempt >= maxAttempts;
        await input.database.internalTransaction("commerce.outbox.reconcile", (transaction) =>
          outbox.retryOrDeadLetter(transaction, {
            eventId: event.eventId, leaseToken: event.leaseToken, errorCode: "OUTBOX_DELIVERY_FAILED",
            retryAt: terminal ? null : new Date(clock().getTime() + retryDelayMs(event.attempt)).toISOString(),
            maxAttempts,
          }));
      }
    }
  };
}

function fulfillmentEvent(event: ClaimedOutboxEvent): CommerceFulfillmentEvent {
  if (event.owner !== "commerce" || event.eventType !== "commerce.redemption.fulfilled.v1" ||
    digest(event.payload) !== event.payloadDigest || !isRecord(event.payload) ||
    !sameKeys(event.payload, ["version", "siteId", "redemptionId", "commandId", "fulfillmentId", "outputSetDigest", "redeemedAt"]) ||
    event.payload.version !== 1 || !text(event.payload.siteId) || !text(event.payload.redemptionId) ||
    !text(event.payload.commandId) || !text(event.payload.fulfillmentId) ||
    typeof event.payload.outputSetDigest !== "string" || !/^[a-f0-9]{64}$/u.test(event.payload.outputSetDigest) ||
    typeof event.payload.redeemedAt !== "string" || !Number.isFinite(Date.parse(event.payload.redeemedAt)) ||
    event.aggregateId !== event.payload.redemptionId) throw new Error("COMMERCE_OUTBOX_EVENT_INVALID");
  return Object.freeze({
    version: 1, siteId: event.payload.siteId, redemptionId: event.payload.redemptionId,
    commandId: event.payload.commandId, fulfillmentId: event.payload.fulfillmentId,
    outputSetDigest: event.payload.outputSetDigest, redeemedAt: new Date(event.payload.redeemedAt).toISOString(),
  });
}

function creditEvent(event: ClaimedOutboxEvent) {
  if (event.owner !== "credit" || !/^credit\.(reserve_root|finalize_segment|release_segment|reconcile_segment)\.v1$/u.test(event.eventType) ||
    digest(event.payload) !== event.payloadDigest || !isRecord(event.payload) ||
    !sameKeys(event.payload, ["operationKind", "siteId", "result"]) || !text(event.payload.siteId) ||
    !text(event.payload.operationKind) || !isRecord(event.payload.result)) throw new Error("CREDIT_OUTBOX_EVENT_INVALID");
  const authorizationSegmentRef = event.payload.result.authorizationSegmentRef;
  if (!text(authorizationSegmentRef) || event.aggregateId !== authorizationSegmentRef ||
    event.eventType !== `credit.${event.payload.operationKind}.v1`) throw new Error("CREDIT_OUTBOX_EVENT_INVALID");
  return Object.freeze({
    eventId: event.eventId, siteId: event.payload.siteId, operationKind: event.payload.operationKind,
    authorizationSegmentRef, result: event.payload.result,
  });
}

function digest(value: Parameters<typeof commerceCanonicalJson>[0]): string {
  return createHash("sha256").update(commerceCanonicalJson(value), "utf8").digest("hex");
}
function mac(secret: Buffer, value: string): string { return createHmac("sha256", secret).update(value).digest("base64url"); }
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function retryDelayMs(attempt: number): number { return Math.min(60_000, 1_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 6)); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"); }
function text(value: unknown): value is string { return typeof value === "string" && value.length >= 1 && value.length <= 256; }
function bounded(value: unknown, maximum: number): value is string { return typeof value === "string" && value.length >= 1 && value.length <= maximum; }
function instant(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("COMMERCE_OUTBOX_TIMESTAMP_INVALID");
  return parsed.toISOString();
}
async function boundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/u.test(declared) || Number(declared) > maximumBytes)) {
    throw new Error("OUTBOX_DELIVERY_ACK_TOO_LARGE");
  }
  if (response.body === null) throw new Error("OUTBOX_DELIVERY_ACK_INVALID");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximumBytes) throw new Error("OUTBOX_DELIVERY_ACK_TOO_LARGE");
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}
async function bindSite(transaction: PlatformTransaction, siteId: string): Promise<void> {
  const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown> & { siteId: string }>(
    `SELECT set_config('app.site_id',$1,true) AS "siteId"`, [siteId],
  );
  if (rows[0]?.siteId !== siteId) throw new Error("OUTBOX_SITE_BINDING_FAILED");
}
