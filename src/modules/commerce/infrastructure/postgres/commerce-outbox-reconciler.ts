import { createHash, randomUUID } from "node:crypto";
import type { PlatformTransactionalDatabaseClient } from
  "../../../../infrastructure/postgres/client.js";
import { commerceCanonicalJson } from "../../domain/canonical-json.js";
import { OutboxRepository, type ClaimedOutboxEvent } from
  "../../../../shared/outbox-inbox/outbox.js";
import {
  HmacHttpOutboxDeliveryTransport as SharedHmacHttpOutboxDeliveryTransport,
  type OutboxDeliveryTransport,
} from "../../../../shared/outbox-inbox/hmac-http-delivery.js";
import { resolvePlatformTransaction, type PlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import { SingleFlightLeaseHeartbeat } from
  "../../../../shared/outbox-inbox/lease-heartbeat.js";

type CommerceFulfillmentEvent = Readonly<{
  version: 1;
  siteId: string;
  redemptionId: string;
  commandId: string;
  fulfillmentId: string;
  outputSetDigest: string;
  redeemedAt: string;
}>;

export const COMMERCE_OUTBOX_EVENT_TYPES = Object.freeze([
  "commerce.redemption.fulfilled.v1",
  "credit.reserve_root.v1",
  "credit.finalize_segment.v1",
  "credit.release_segment.v1",
  "credit.reconcile_segment.v1",
] as const);

export interface CommerceOutboxProjection {
  assertDeliverable(transaction: PlatformTransaction, event: ClaimedOutboxEvent): Promise<void>;
}

export type { OutboxDeliveryTransport };

export class HmacHttpOutboxDeliveryTransport extends SharedHmacHttpOutboxDeliveryTransport {
  constructor(
    input: ConstructorParameters<typeof SharedHmacHttpOutboxDeliveryTransport>[0],
  ) {
    super({ ...input, canonicalJson: commerceCanonicalJson });
  }
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

export interface CommerceOutboxReconciliationRuntime {
  (context: Readonly<{ signal: AbortSignal }>): Promise<void>;
  runOneCycle(context: Readonly<{ signal: AbortSignal }>): Promise<void>;
  stopClaiming(): Promise<void>;
  returnLeases(reason: "shutdown" | "shutdown-deadline" | "stop-claim-failed" | "WORKER_SHUTDOWN"): Promise<void>;
}

type ActiveCommerceLease = Readonly<{
  heartbeat: SingleFlightLeaseHeartbeat;
}>;

export function createCommerceOutboxReconciliationCycle(input: Readonly<{
  database: Pick<PlatformTransactionalDatabaseClient, "internalTransaction">;
  transport: OutboxDeliveryTransport;
  outbox?: Pick<OutboxRepository,
    "claim" | "complete" | "retryOrDeadLetter" | "renewLease" | "releaseOwnedLeases">;
  projection?: CommerceOutboxProjection;
  workerId: string;
  batchSize?: number;
  leaseSeconds?: number;
  maxAttempts?: number;
  leaseHeartbeatMs?: number;
  leaseRenewalTimeoutMs?: number;
  clock?: () => Date;
  leaseToken?: () => string;
}>): CommerceOutboxReconciliationRuntime {
  const outbox = input.outbox ?? new OutboxRepository();
  const projection = input.projection ?? new PostgresCommerceOutboxProjection();
  const batchSize = input.batchSize ?? 25;
  const leaseSeconds = input.leaseSeconds ?? 30;
  const maxAttempts = input.maxAttempts ?? 10;
  const leaseHeartbeatMs = input.leaseHeartbeatMs ?? Math.max(1, Math.floor((leaseSeconds * 1_000) / 3));
  const leaseRenewalTimeoutMs = input.leaseRenewalTimeoutMs ?? Math.min(leaseHeartbeatMs, 5_000);
  const clock = input.clock ?? (() => new Date());
  const leaseToken = input.leaseToken ?? randomUUID;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new Error("OUTBOX_MAX_ATTEMPTS_INVALID");
  }
  if (!Number.isInteger(leaseHeartbeatMs) || leaseHeartbeatMs < 1 || leaseHeartbeatMs > 100_000) {
    throw new Error("OUTBOX_LEASE_HEARTBEAT_INVALID");
  }
  if (!Number.isInteger(leaseRenewalTimeoutMs) || leaseRenewalTimeoutMs < 1 || leaseRenewalTimeoutMs > 100_000) {
    throw new Error("OUTBOX_LEASE_RENEWAL_TIMEOUT_INVALID");
  }
  const active = new Map<string, ActiveCommerceLease>();
  let claiming = true;
  let cyclePromise: Promise<void> | undefined;
  const stopActiveHeartbeats = async (): Promise<void> => {
    await Promise.all([...active.values()].map(({ heartbeat }) => heartbeat.stop()));
  };
  const runClaimedBatch = async ({ signal }: Readonly<{ signal: AbortSignal }>): Promise<void> => {
    if (!claiming) return;
    signal.throwIfAborted();
    const events = await input.database.internalTransaction("commerce.outbox.reconcile", (transaction) =>
      outbox.claim(transaction, {
        workerId: input.workerId, leaseToken: leaseToken(), consumer: "commerce-worker",
        eventTypes: COMMERCE_OUTBOX_EVENT_TYPES,
        limit: batchSize, leaseSeconds,
      }));
    for (const event of events) {
      const heartbeat = new SingleFlightLeaseHeartbeat(
        () => input.database.internalTransaction("commerce.outbox.reconcile", (transaction) =>
          outbox.renewLease(transaction, {
            eventId: event.eventId, leaseToken: event.leaseToken, workerId: input.workerId,
            owner: event.owner, leaseSeconds,
          })),
        {
          intervalMs: leaseHeartbeatMs,
          renewalTimeoutMs: leaseRenewalTimeoutMs,
          timeoutCode: "COMMERCE_OUTBOX_LEASE_RENEWAL_TIMEOUT",
        },
      );
      active.set(event.eventId, { heartbeat });
      heartbeat.start();
    }
    const leaseFailures: unknown[] = [];
    try {
      for (const event of events) {
        const current = active.get(event.eventId);
        if (current === undefined) continue;
        signal.throwIfAborted();
        try {
          await current.heartbeat.assertOwned();
          await input.database.internalTransaction("commerce.outbox.reconcile", (transaction) =>
            projection.assertDeliverable(transaction, event));
          await current.heartbeat.assertOwned();
          const acknowledgement = await input.transport.publish(
            event,
            AbortSignal.any([signal, current.heartbeat.signal]),
          );
          await current.heartbeat.assertOwned();
          signal.throwIfAborted();
          await input.database.internalTransaction("commerce.outbox.reconcile", async (transaction) => {
            await outbox.renewLease(transaction, {
              eventId: event.eventId, leaseToken: event.leaseToken, workerId: input.workerId,
              owner: event.owner, leaseSeconds,
            });
            await outbox.complete(transaction, {
              eventId: event.eventId, leaseToken: event.leaseToken, ...acknowledgement,
            });
          });
        } catch (error) {
          // A process drain is not a failed delivery attempt. Leave the claimed row untouched so
          // shutdown can return it without consuming retry budget or manufacturing dead-letter evidence.
          if (signal.aborted) throw error;
          if (current.heartbeat.lost) {
            leaseFailures.push(current.heartbeat.failure);
            continue;
          }
          if (isLeaseLost(error)) {
            leaseFailures.push(error);
            continue;
          }
          const terminal = event.attempt >= maxAttempts;
          await current.heartbeat.assertOwned();
          await input.database.internalTransaction("commerce.outbox.reconcile", async (transaction) => {
            await outbox.renewLease(transaction, {
              eventId: event.eventId, leaseToken: event.leaseToken, workerId: input.workerId,
              owner: event.owner, leaseSeconds,
            });
            await outbox.retryOrDeadLetter(transaction, {
              eventId: event.eventId, leaseToken: event.leaseToken, errorCode: "OUTBOX_DELIVERY_FAILED",
              retryAt: terminal ? null : new Date(clock().getTime() + retryDelayMs(event.attempt)).toISOString(),
              maxAttempts,
            });
          });
        } finally {
          await current.heartbeat.stop();
          active.delete(event.eventId);
        }
      }
    } catch (error) {
      await stopActiveHeartbeats();
      active.clear();
      throw error;
    }
    if (leaseFailures.length === 1) throw leaseFailures[0];
    if (leaseFailures.length > 1) {
      throw new AggregateError(leaseFailures, "COMMERCE_OUTBOX_LEASE_RENEWAL_FAILED");
    }
  };
  const runOneCycle = (context: Readonly<{ signal: AbortSignal }>): Promise<void> => {
    if (cyclePromise !== undefined) return cyclePromise;
    const cycle = runClaimedBatch(context).finally(() => {
      if (cyclePromise === cycle) cyclePromise = undefined;
    });
    cyclePromise = cycle;
    return cycle;
  };
  const runtime = Object.assign(
    (context: Readonly<{ signal: AbortSignal }>) => runOneCycle(context),
    {
      runOneCycle,
      stopClaiming: async () => { claiming = false; },
      returnLeases: async (_reason: "shutdown" | "shutdown-deadline" | "stop-claim-failed" | "WORKER_SHUTDOWN") => {
        await stopActiveHeartbeats();
        await input.database.internalTransaction("commerce.outbox.reconcile", (transaction) =>
          outbox.releaseOwnedLeases(transaction, {
            workerId: input.workerId,
            consumer: "commerce-worker",
            eventTypes: COMMERCE_OUTBOX_EVENT_TYPES,
          }));
        active.clear();
      },
    },
  );
  return runtime;
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
function retryDelayMs(attempt: number): number { return Math.min(60_000, 1_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 6)); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"); }
function text(value: unknown): value is string { return typeof value === "string" && value.length >= 1 && value.length <= 256; }
function isLeaseLost(error: unknown): boolean {
  return error instanceof Error && error.message === "OUTBOX_LEASE_LOST";
}
function instant(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("COMMERCE_OUTBOX_TIMESTAMP_INVALID");
  return parsed.toISOString();
}
async function bindSite(transaction: PlatformTransaction, siteId: string): Promise<void> {
  const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown> & { siteId: string }>(
    `SELECT set_config('app.site_id',$1,true) AS "siteId"`, [siteId],
  );
  if (rows[0]?.siteId !== siteId) throw new Error("OUTBOX_SITE_BINDING_FAILED");
}
