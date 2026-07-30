import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
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

  it("renews active leases, stops claiming, and releases only Commerce-owned work on shutdown", async () => {
    vi.useFakeTimers();
    try {
      const outbox = new RecordingOutbox([event()]);
      const controller = new AbortController();
      const transport: OutboxDeliveryTransport = {
        publish: async (_event, signal) => new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      };
      const runtime = createCommerceOutboxReconciliationCycle({
        database: database(), outbox, projection: new RecordingProjection(), transport,
        workerId: "worker-1", leaseToken: () => "lease-1", leaseSeconds: 3,
        leaseHeartbeatMs: 1_000,
      });

      const cycle = runtime.runOneCycle({ signal: controller.signal });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(outbox.renewed).toEqual([
        { eventId: event().eventId, leaseToken: "lease-1",
          workerId: "worker-1", owner: "commerce", leaseSeconds: 3 },
        { eventId: event().eventId, leaseToken: "lease-1",
          workerId: "worker-1", owner: "commerce", leaseSeconds: 3 },
      ]);

      await runtime.stopClaiming();
      controller.abort(new DOMException("draining", "AbortError"));
      await expect(cycle).rejects.toMatchObject({ name: "AbortError" });
      await runtime.returnLeases("WORKER_SHUTDOWN");

      expect(outbox.retried).toEqual([]);
      expect(outbox.releasedOwned).toEqual([{
        workerId: "worker-1", consumer: "commerce-worker", eventTypes: [
          "commerce.redemption.fulfilled.v1", "credit.reserve_root.v1",
          "credit.finalize_segment.v1", "credit.release_segment.v1",
          "credit.reconcile_segment.v1",
        ],
      }]);
      await runtime.runOneCycle({ signal: new AbortController().signal });
      expect(outbox.claimCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a detached AbortError because only the parent signal represents drain", async () => {
    const outbox = new RecordingOutbox([event()]);
    const runtime = createCommerceOutboxReconciliationCycle({
      database: database(), outbox, projection: new RecordingProjection(),
      transport: { publish: async () => { throw new DOMException("cancelled", "AbortError"); } },
      workerId: "worker-1", leaseToken: () => "lease-1",
    });

    await expect(runtime({ signal: new AbortController().signal })).resolves.toBeUndefined();
    expect(outbox.retried).toEqual([expect.objectContaining({
      eventId: event().eventId,
      errorCode: "OUTBOX_DELIVERY_FAILED",
    })]);
  });

  it("coalesces concurrent cycles without claiming a second batch", async () => {
    const outbox = new RecordingOutbox([event()]);
    let finish!: () => void;
    const runtime = createCommerceOutboxReconciliationCycle({
      database: database(), outbox, projection: new RecordingProjection(),
      transport: { publish: async () => {
        await new Promise<void>((resolve) => { finish = resolve; });
        return { deliveryId: "delivery-1", acknowledgedAt: "2026-07-29T01:00:01.000Z" };
      } },
      workerId: "worker-1", leaseToken: () => "lease-1",
    });

    const first = runtime.runOneCycle({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(outbox.renewed).toHaveLength(1));
    const second = runtime.runOneCycle({ signal: new AbortController().signal });
    expect(outbox.claimCount).toBe(1);
    finish();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(outbox.claimCount).toBe(1);
  });

  it("keeps renewing until the fenced completion commits", async () => {
    vi.useFakeTimers();
    try {
      const outbox = new RecordingOutbox([event()]);
      let finishComplete!: () => void;
      outbox.complete = async (_transaction, input) => {
        outbox.completeStarted.push(input);
        await new Promise<void>((resolve) => { finishComplete = resolve; });
        outbox.completed.push(input);
      };
      const runtime = createCommerceOutboxReconciliationCycle({
        database: database(), outbox, projection: new RecordingProjection(),
        transport: new RecordingTransport(() => 0), workerId: "worker-1",
        leaseToken: () => "lease-1", leaseHeartbeatMs: 100,
      });

      const cycle = runtime.runOneCycle({ signal: new AbortController().signal });
      await vi.waitFor(() => expect(outbox.completeStarted).toHaveLength(1));
      const renewalsBefore = outbox.renewed.length;
      await vi.advanceTimersByTimeAsync(100);
      expect(outbox.renewed.length).toBeGreaterThan(renewalsBefore);
      finishComplete();
      await cycle;
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a hung renewal without queueing overlapping renewals", async () => {
    vi.useFakeTimers();
    try {
      const outbox = new RecordingOutbox([event()]);
      let renewals = 0;
      outbox.renewLease = async () => {
        renewals += 1;
        return new Promise<void>(() => undefined);
      };
      const runtime = createCommerceOutboxReconciliationCycle({
        database: database(), outbox, projection: new RecordingProjection(),
        transport: new RecordingTransport(() => 0), workerId: "worker-1",
        leaseToken: () => "lease-1", leaseHeartbeatMs: 100, leaseRenewalTimeoutMs: 50,
      });

      const cycle = runtime.runOneCycle({ signal: new AbortController().signal });
      const failure = expect(cycle).rejects.toThrow("COMMERCE_OUTBOX_LEASE_RENEWAL_TIMEOUT");
      await vi.advanceTimersByTimeAsync(1_000);
      await failure;
      expect(renewals).toBe(1);
      expect(outbox.completed).toEqual([]);
      await expect(runtime.returnLeases("shutdown")).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the active transport immediately when lease renewal fails", async () => {
    vi.useFakeTimers();
    try {
      const outbox = new RecordingOutbox([event()]);
      let renewals = 0;
      outbox.renewLease = async (_transaction, input) => {
        outbox.renewed.push(input);
        if (++renewals === 2) throw new Error("OUTBOX_LEASE_LOST");
      };
      let transportAbortReason: unknown;
      const runtime = createCommerceOutboxReconciliationCycle({
        database: database(), outbox, projection: new RecordingProjection(),
        transport: { publish: async (_event, signal) => new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            transportAbortReason = signal.reason;
            reject(signal.reason);
          }, { once: true });
        }) },
        workerId: "worker-1", leaseToken: () => "lease-1", leaseSeconds: 3,
        leaseHeartbeatMs: 1_000,
      });
      const cycle = runtime.runOneCycle({ signal: new AbortController().signal });
      const cycleExpectation = expect(cycle).rejects.toThrow("OUTBOX_LEASE_LOST");

      await vi.advanceTimersByTimeAsync(1_000);
      await cycleExpectation;

      expect(transportAbortReason).toMatchObject({ message: "OUTBOX_LEASE_LOST" });
      expect(outbox.completed).toEqual([]);
      expect(outbox.retried).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps every claimed lease alive while the first delivery is still running", async () => {
    vi.useFakeTimers();
    try {
      const second = { ...event(), eventId: "00000000-0000-7000-8000-000000000503" };
      const outbox = new RecordingOutbox([event(), second]);
      let secondRenewals = 0;
      outbox.renewLease = async (_transaction, input) => {
        outbox.renewed.push(input);
        if (input.eventId === second.eventId && ++secondRenewals === 2) {
          throw new Error("OUTBOX_LEASE_LOST");
        }
      };
      let finishFirst!: () => void;
      const published: string[] = [];
      const runtime = createCommerceOutboxReconciliationCycle({
        database: database(), outbox, projection: new RecordingProjection(),
        transport: { publish: async (value) => {
          published.push(value.eventId);
          if (value.eventId === event().eventId) {
            await new Promise<void>((resolve) => { finishFirst = resolve; });
          }
          return { deliveryId: `delivery-${value.eventId}`, acknowledgedAt: "2026-07-29T01:00:01.000Z" };
        } },
        workerId: "worker-1", leaseToken: () => "lease-1", leaseSeconds: 3,
        leaseHeartbeatMs: 1_000,
      });

      const cycle = runtime.runOneCycle({ signal: new AbortController().signal });
      const cycleExpectation = expect(cycle).rejects.toThrow("OUTBOX_LEASE_LOST");
      await vi.advanceTimersByTimeAsync(1_000);
      finishFirst();
      await cycleExpectation;

      expect(outbox.renewed.some((renewal) => renewal.eventId === second.eventId)).toBe(true);
      expect(published).toEqual([event().eventId]);
      expect(outbox.completed.map((completion) => completion.eventId)).toEqual([event().eventId]);
      expect(outbox.retried).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not invoke the transport when ownership is lost during projection", async () => {
    vi.useFakeTimers();
    try {
      const outbox = new RecordingOutbox([event()]);
      let renewals = 0;
      outbox.renewLease = async (_transaction, input) => {
        outbox.renewed.push(input);
        if (++renewals === 2) throw new Error("OUTBOX_LEASE_LOST");
      };
      let finishProjection!: () => void;
      const published: string[] = [];
      const runtime = createCommerceOutboxReconciliationCycle({
        database: database(), outbox,
        projection: { assertDeliverable: async () => new Promise<void>((resolve) => {
          finishProjection = resolve;
        }) },
        transport: { publish: async (value) => {
          published.push(value.eventId);
          return { deliveryId: "delivery-1", acknowledgedAt: "2026-07-29T01:00:01.000Z" };
        } },
        workerId: "worker-1", leaseToken: () => "lease-1", leaseSeconds: 3,
        leaseHeartbeatMs: 1_000,
      });

      const cycle = runtime.runOneCycle({ signal: new AbortController().signal });
      const cycleExpectation = expect(cycle).rejects.toThrow("OUTBOX_LEASE_LOST");
      await vi.advanceTimersByTimeAsync(1_000);
      finishProjection();
      await cycleExpectation;

      expect(published).toEqual([]);
      expect(outbox.completed).toEqual([]);
      expect(outbox.retried).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("registers Commerce claiming and lease return in the production worker lifecycle", async () => {
    const source = await readFile(new URL("../../src/process/commerce-worker.ts", import.meta.url), "utf8");
    expect(source).toContain("stopClaiming: commerce.stopClaiming");
    expect(source).toContain("returnLeases: commerce.returnLeases");
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

  it("classifies a reset 200 acknowledgement stream as retryable outcome unknown", async () => {
    const transport = new HmacHttpOutboxDeliveryTransport({
      endpoint: "https://consumer.internal/events",
      keyId: "delivery-key-1",
      secretBase64: Buffer.alloc(32, 7).toString("base64"),
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
          controller.error(new Error("ack stream reset"));
        },
      }), { status: 200 }),
    });

    await expect(transport.publish(event(), new AbortController().signal))
      .rejects.toMatchObject({
        code: "OUTBOX_DELIVERY_ACK_OUTCOME_UNKNOWN",
        retryable: true,
      });
  });

  it("classifies a timed-out 200 acknowledgement stream as retryable outcome unknown", async () => {
    const transport = new HmacHttpOutboxDeliveryTransport({
      endpoint: "https://consumer.internal/events",
      keyId: "delivery-key-1",
      secretBase64: Buffer.alloc(32, 7).toString("base64"),
      timeoutMs: 100,
      fetch: async (_input, init) => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
          init?.signal?.addEventListener("abort", () => {
            controller.error(init.signal?.reason ?? new Error("acknowledgement timeout"));
          }, { once: true });
        },
      }), { status: 200 }),
    });

    await expect(transport.publish(event(), new AbortController().signal))
      .rejects.toMatchObject({
        code: "OUTBOX_DELIVERY_ACK_OUTCOME_UNKNOWN",
        retryable: true,
      });
  });
});

class RecordingOutbox implements Pick<OutboxRepository,
  "claim" | "complete" | "retryOrDeadLetter" | "renewLease" | "releaseOwnedLeases"> {
  claimInput: Parameters<OutboxRepository["claim"]>[1] | null = null;
  claimCount = 0;
  completed: Array<Parameters<OutboxRepository["complete"]>[1]> = [];
  completeStarted: Array<Parameters<OutboxRepository["complete"]>[1]> = [];
  retried: Array<Parameters<OutboxRepository["retryOrDeadLetter"]>[1]> = [];
  renewed: Array<Parameters<OutboxRepository["renewLease"]>[1]> = [];
  releasedOwned: Array<Parameters<OutboxRepository["releaseOwnedLeases"]>[1]> = [];

  constructor(private readonly events: readonly ClaimedOutboxEvent[]) {}

  async claim(
    _transaction: Parameters<OutboxRepository["claim"]>[0],
    input: Parameters<OutboxRepository["claim"]>[1],
  ) {
    this.claimCount += 1;
    this.claimInput = input;
    return this.events;
  }

  async renewLease(
    _transaction: Parameters<OutboxRepository["renewLease"]>[0],
    input: Parameters<OutboxRepository["renewLease"]>[1],
  ) {
    this.renewed.push(input);
  }

  async releaseOwnedLeases(
    _transaction: Parameters<OutboxRepository["releaseOwnedLeases"]>[0],
    input: Parameters<OutboxRepository["releaseOwnedLeases"]>[1],
  ) {
    this.releasedOwned.push(input);
    return this.events.length;
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
