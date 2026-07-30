import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCommerceOutboxReconciliationCycle, HmacHttpOutboxDeliveryTransport, type CommerceOutboxProjection, type OutboxDeliveryTransport } from
  "../../src/modules/commerce/infrastructure/postgres/commerce-outbox-reconciler.js";
import { commerceCanonicalJson } from "../../src/modules/commerce/domain/canonical-json.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import type { PlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";
import type { ClaimedOutboxEvent, OutboxRepository } from "../../src/shared/outbox-inbox/outbox.js";

describe("Commerce outbox reconciler", () => {
  it("claims Commerce and Credit events, publishes outside transactions, and completes only after consumer ack", async () => {
    const databaseValue = database();
    const outbox = new RecordingOutbox([event(), creditEvent()]);
    const projection = new RecordingProjection();
    const transport = new RecordingTransport(() => databaseValue.activeTransactions);
    const cycle = createCommerceOutboxReconciliationCycle({
      database: databaseValue, outbox, projection, transport, workerId: "worker-1", leaseToken: () => "lease-1",
    });

    await cycle({ signal: new AbortController().signal });

    expect(outbox.claimInput).toMatchObject({ consumer: "commerce-worker", workerId: "worker-1",
      leaseToken: "lease-1", eventTypes: [
        "commerce.redemption.fulfilled.v1", "credit.reserve_root.v1",
        "credit.finalize_segment.v1", "credit.release_segment.v1",
        "credit.reconcile_segment.v1",
      ] });
    expect(projection.events).toHaveLength(2);
    expect(transport.events).toHaveLength(2);
    expect(outbox.completed).toEqual([
      { eventId: "00000000-0000-7000-8000-000000000501", leaseToken: "lease-1", deliveryId: "delivery-1", acknowledgedAt: "2026-07-29T01:00:01.000Z" },
      { eventId: "00000000-0000-7000-8000-000000000502", leaseToken: "lease-1", deliveryId: "delivery-2", acknowledgedAt: "2026-07-29T01:00:01.000Z" },
    ]);
    expect(outbox.retried).toEqual([]);
  });

  it("records bounded retry evidence instead of poisoning the whole worker cycle", async () => {
    const outbox = new RecordingOutbox([event()]);
    const projection: CommerceOutboxProjection = { assertDeliverable: async () => {
      throw new Error("projection unavailable");
    } };
    const cycle = createCommerceOutboxReconciliationCycle({
      database: database(), outbox, projection, transport: new RecordingTransport(() => 0), workerId: "worker-1", leaseToken: () => "lease-1",
      clock: () => new Date("2026-07-29T01:00:00.000Z"), maxAttempts: 3,
    });

    await cycle({ signal: new AbortController().signal });

    expect(outbox.completed).toEqual([]);
    expect(outbox.retried).toEqual([{
      eventId: "00000000-0000-7000-8000-000000000501", leaseToken: "lease-1",
      errorCode: "OUTBOX_DELIVERY_FAILED", retryAt: "2026-07-29T01:00:01.000Z", maxAttempts: 3,
    }]);
  });

  it("returns a claimed lease unchanged when process drain cancels delivery", async () => {
    const outbox = new RecordingOutbox([event()]);
    const controller = new AbortController();
    const transport: OutboxDeliveryTransport = {
      publish: async (_event, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        controller.abort(new Error("PLATFORM_WORKER_DRAINING"));
      }),
    };
    const cycle = createCommerceOutboxReconciliationCycle({
      database: database(), outbox, projection: new RecordingProjection(), transport,
      workerId: "worker-1", leaseToken: () => "lease-1",
    });

    await expect(cycle({ signal: controller.signal })).rejects.toThrow("PLATFORM_WORKER_DRAINING");

    expect(outbox.completed).toEqual([]);
    expect(outbox.retried).toEqual([]);
  });

  it("still records a delivery timeout when the process itself is not draining", async () => {
    const outbox = new RecordingOutbox([event()]);
    const cycle = createCommerceOutboxReconciliationCycle({
      database: database(), outbox, projection: new RecordingProjection(),
      transport: { publish: async () => { throw new DOMException("timed out", "TimeoutError"); } },
      workerId: "worker-1", leaseToken: () => "lease-1", maxAttempts: 3,
      clock: () => new Date("2026-07-29T01:00:00.000Z"),
    });

    await cycle({ signal: new AbortController().signal });

    expect(outbox.retried).toEqual([expect.objectContaining({
      eventId: "00000000-0000-7000-8000-000000000501",
      errorCode: "OUTBOX_DELIVERY_FAILED",
    })]);
  });

  it("accepts only a consumer-authenticated HTTP acknowledgement", async () => {
    const secret = Buffer.alloc(32, 7); const value = event();
    const transport = new HmacHttpOutboxDeliveryTransport({
      endpoint: "https://consumer.internal/events", keyId: "delivery-key-1", secretBase64: secret.toString("base64"),
      fetch: async (_input, init) => {
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("x-kokoro-delivery-signature")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        const acknowledgement = { eventId: value.eventId, deliveryId: "consumer-delivery-1", acknowledgedAt: "2026-07-29T01:00:01.000Z" };
        return new Response(JSON.stringify({ ...acknowledgement, acknowledgementMac: createHmac("sha256", secret)
          .update(commerceCanonicalJson({ ...acknowledgement, payloadDigest: value.payloadDigest })).digest("base64url") }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      },
    });
    await expect(transport.publish(value, new AbortController().signal)).resolves.toEqual({
      deliveryId: "consumer-delivery-1", acknowledgedAt: "2026-07-29T01:00:01.000Z",
    });
  });
});

class RecordingOutbox implements Pick<OutboxRepository, "claim" | "complete" | "retryOrDeadLetter"> {
  claimInput: Parameters<OutboxRepository["claim"]>[1] | null = null;
  completed: Array<Parameters<OutboxRepository["complete"]>[1]> = [];
  retried: Array<Parameters<OutboxRepository["retryOrDeadLetter"]>[1]> = [];

  constructor(private readonly events: readonly ClaimedOutboxEvent[]) {}

  async claim(
    _transaction: Parameters<OutboxRepository["claim"]>[0],
    input: Parameters<OutboxRepository["claim"]>[1],
  ) {
    this.claimInput = input;
    return this.events;
  }

  async complete(
    _transaction: Parameters<OutboxRepository["complete"]>[0],
    input: Parameters<OutboxRepository["complete"]>[1],
  ) {
    this.completed.push(input);
  }

  async retryOrDeadLetter(
    _transaction: Parameters<OutboxRepository["retryOrDeadLetter"]>[0],
    input: Parameters<OutboxRepository["retryOrDeadLetter"]>[1],
  ) {
    this.retried.push(input);
  }
}

class RecordingProjection implements CommerceOutboxProjection {
  events: unknown[] = [];
  async assertDeliverable(_transaction: PlatformTransaction, eventValue: Parameters<CommerceOutboxProjection["assertDeliverable"]>[1]) {
    this.events.push(eventValue);
  }
}

class RecordingTransport implements OutboxDeliveryTransport {
  events: ClaimedOutboxEvent[] = [];
  constructor(private readonly activeTransactions: () => number) {}
  async publish(eventValue: ClaimedOutboxEvent) {
    expect(this.activeTransactions()).toBe(0);
    this.events.push(eventValue);
    return {
      deliveryId: `delivery-${this.events.length}`,
      acknowledgedAt: "2026-07-29T01:00:01.000Z",
    };
  }
}

function database() {
  let activeTransactions = 0;
  return {
    get activeTransactions() { return activeTransactions; },
    async internalTransaction<Result>(
      operation: "commerce.outbox.reconcile",
      work: (transaction: PlatformTransaction) => Promise<Result>,
    ): Promise<Result> {
      expect(operation).toBe("commerce.outbox.reconcile");
      activeTransactions += 1;
      const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
      try {
        return await work(lease.transaction);
      } finally {
        revokePlatformTransaction(lease);
        activeTransactions -= 1;
      }
    },
  };
}

function creditEvent(): ClaimedOutboxEvent {
  const payload = {
    operationKind: "reserve_run_budget", siteId: "site-1", result: {
      authorizationSegmentRef: "00000000-0000-7000-8000-000000000401",
    },
  } as const;
  return {
    eventId: "00000000-0000-7000-8000-000000000502", owner: "credit",
    eventType: "credit.reserve_run_budget.v1", aggregateId: payload.result.authorizationSegmentRef,
    payload, payloadDigest: createHash("sha256").update(commerceCanonicalJson(payload)).digest("hex"),
    correlationId: "credit-command-1", causationId: null, leaseToken: "lease-1", attempt: 1,
  };
}

function event(): ClaimedOutboxEvent {
  const payload = {
    version: 1, siteId: "site-1", redemptionId: "00000000-0000-7000-8000-000000000301",
    commandId: "00000000-0000-7000-8000-000000000201",
    fulfillmentId: "00000000-0000-7000-8000-000000000302",
    outputSetDigest: "a".repeat(64), redeemedAt: "2026-07-29T01:00:00.000Z",
  } as const;
  return {
    eventId: "00000000-0000-7000-8000-000000000501", owner: "commerce",
    eventType: "commerce.redemption.fulfilled.v1", aggregateId: payload.redemptionId,
    payload, payloadDigest: createHash("sha256").update(commerceCanonicalJson(payload)).digest("hex"),
    correlationId: payload.commandId, causationId: null, leaseToken: "lease-1", attempt: 1,
  };
}
