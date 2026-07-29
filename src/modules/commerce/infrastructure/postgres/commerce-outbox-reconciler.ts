import { createHash, randomUUID } from "node:crypto";
import type { PlatformTransactionalDatabaseClient } from
  "../../../../infrastructure/postgres/client.js";
import { commerceCanonicalJson } from "../../domain/canonical-json.js";
import { OutboxRepository, type ClaimedOutboxEvent } from
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
  assertFulfilled(transaction: PlatformTransaction, event: CommerceFulfillmentEvent): Promise<void>;
}

export class PostgresCommerceOutboxProjection implements CommerceOutboxProjection {
  async assertFulfilled(transaction: PlatformTransaction, event: CommerceFulfillmentEvent): Promise<void> {
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
      instant(row.redeemedAt) !== event.redeemedAt) {
      throw new Error("COMMERCE_OUTBOX_PROJECTION_MISMATCH");
    }
  }
}

export function createCommerceOutboxReconciliationCycle(input: Readonly<{
  database: Pick<PlatformTransactionalDatabaseClient, "internalTransaction">;
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
    throw new Error("COMMERCE_OUTBOX_MAX_ATTEMPTS_INVALID");
  }
  return async ({ signal }) => {
    signal.throwIfAborted();
    const observedAt = clock();
    await input.database.internalTransaction("commerce.outbox.reconcile", async (transaction) => {
      const events = await outbox.claim(transaction, {
        workerId: input.workerId,
        leaseToken: leaseToken(),
        owners: ["commerce"],
        limit: batchSize,
        leaseSeconds,
      });
      for (const event of events) {
        signal.throwIfAborted();
        try {
          const payload = fulfillmentEvent(event);
          await projection.assertFulfilled(transaction, payload);
          await outbox.complete(transaction, event.eventId, event.leaseToken);
        } catch {
          const terminal = event.attempt >= maxAttempts;
          await outbox.retryOrDeadLetter(transaction, {
            eventId: event.eventId,
            leaseToken: event.leaseToken,
            errorCode: "COMMERCE_OUTBOX_RECONCILIATION_FAILED",
            retryAt: terminal ? null : new Date(observedAt.getTime() + retryDelayMs(event.attempt)).toISOString(),
            maxAttempts,
          });
        }
      }
    });
  };
}

function fulfillmentEvent(event: ClaimedOutboxEvent): CommerceFulfillmentEvent {
  if (event.owner !== "commerce" || event.eventType !== "commerce.redemption.fulfilled.v1" ||
    digest(event.payload) !== event.payloadDigest || !isRecord(event.payload) ||
    !sameKeys(event.payload, [
      "version", "siteId", "redemptionId", "commandId", "fulfillmentId", "outputSetDigest", "redeemedAt",
    ]) || event.payload.version !== 1 || !text(event.payload.siteId) || !text(event.payload.redemptionId) ||
    !text(event.payload.commandId) || !text(event.payload.fulfillmentId) ||
    typeof event.payload.outputSetDigest !== "string" || !/^[a-f0-9]{64}$/u.test(event.payload.outputSetDigest) ||
    typeof event.payload.redeemedAt !== "string" || !Number.isFinite(Date.parse(event.payload.redeemedAt)) ||
    event.aggregateId !== event.payload.redemptionId) {
    throw new Error("COMMERCE_OUTBOX_EVENT_INVALID");
  }
  return Object.freeze({
    version: 1,
    siteId: event.payload.siteId,
    redemptionId: event.payload.redemptionId,
    commandId: event.payload.commandId,
    fulfillmentId: event.payload.fulfillmentId,
    outputSetDigest: event.payload.outputSetDigest,
    redeemedAt: new Date(event.payload.redeemedAt).toISOString(),
  });
}

function digest(value: Parameters<typeof commerceCanonicalJson>[0]): string {
  return createHash("sha256").update(commerceCanonicalJson(value), "utf8").digest("hex");
}

function retryDelayMs(attempt: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 6));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256;
}

function instant(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("COMMERCE_OUTBOX_TIMESTAMP_INVALID");
  return parsed.toISOString();
}
