import { describe, expect, it, vi } from "vitest";
import type { ClaimedOutboxEvent } from "../../src/shared/outbox-inbox/outbox.js";
import {
  SiteRuntimePendingError,
} from "../../src/modules/site/application/services/site-runtime-dispatcher.js";
import {
  createPostgresSiteRuntimeEventQueue,
  SITE_EFFECT_EVENT_TYPES,
  SiteOutboxConsumer,
  type SiteRuntimeEventQueue,
} from "../../src/modules/site/infrastructure/postgres/site-outbox-consumer.js";

describe("SiteOutboxConsumer", () => {
  it("acks an activation only after the runtime dispatcher closes the saga", async () => {
    const calls: string[] = [];
    const event = outbox("site.activation.begin.v1", { attemptRef: "activation_01", state: "preparing" });
    const queue = fakeQueue(event, calls);
    const consumer = new SiteOutboxConsumer(queue, {
      runActivation: async (attemptRef) => { calls.push(`activation:${attemptRef}`); },
      runTrafficStop: async () => { throw new Error("unexpected"); },
    }, { now: () => "2026-07-30T10:00:00.000Z" });
    await consumer.runOneCycle({ signal: new AbortController().signal });
    expect(calls).toEqual([
      "claim", "renew:event_01:lease_01", "activation:activation_01", "ack:event_01:lease_01",
    ]);
  });

  it("retries pending provider convergence with bounded exponential backoff", async () => {
    const calls: string[] = [];
    const event = { ...outbox("site.traffic-stop.request.v1",
      { attemptRef: "traffic_stop_01", state: "requested" }), attempt: 3 };
    const queue = fakeQueue(event, calls);
    const consumer = new SiteOutboxConsumer(queue, {
      runActivation: async () => { throw new Error("unexpected"); },
      runTrafficStop: async () => { throw new SiteRuntimePendingError("SITE_TRAFFIC_STOP_SERVING"); },
    }, { now: () => "2026-07-30T10:00:00.000Z", baseRetryMs: 1_000 });
    await consumer.runOneCycle({ signal: new AbortController().signal });
    expect(calls).toContain("retry:event_01:lease_01:SITE_TRAFFIC_STOP_SERVING:2026-07-30T10:00:04.000Z:12");
  });

  it("dead-letters a malformed effect event instead of retrying poison forever", async () => {
    const calls: string[] = [];
    const queue = fakeQueue(outbox("site.activation.begin.v1", { state: "preparing" }), calls);
    const consumer = new SiteOutboxConsumer(queue, {
      runActivation: async () => { throw new Error("unexpected"); },
      runTrafficStop: async () => { throw new Error("unexpected"); },
    });
    await consumer.runOneCycle({ signal: new AbortController().signal });
    expect(calls).toContain("retry:event_01:lease_01:SITE_OUTBOX_PAYLOAD_INVALID:null:12");
  });

  it("dead-letters an unknown Site event instead of silently acknowledging it", async () => {
    const calls: string[] = [];
    const queue = fakeQueue(outbox("site.register.v1", {
      attemptRef: "site_01", state: "registered",
    }), calls);
    const consumer = new SiteOutboxConsumer(queue, {
      runActivation: async () => { throw new Error("unexpected"); },
      runTrafficStop: async () => { throw new Error("unexpected"); },
    });
    await consumer.runOneCycle({ signal: new AbortController().signal });
    expect(calls).toContain("retry:event_01:lease_01:SITE_OUTBOX_EVENT_UNSUPPORTED:null:12");
    expect(calls).not.toContain("ack:event_01:lease_01");
  });

  it("claims only the two Site provider-effect event types", async () => {
    let claimInput: unknown;
    const transaction = Object.freeze({});
    const queue = createPostgresSiteRuntimeEventQueue({
      internalTransaction: async (_operation: string, work: (value: unknown) => Promise<unknown>) =>
        work(transaction),
    } as never, { workerId: "site-worker-01" }, {
      claim: async (_current: unknown, input: unknown) => { claimInput = input; return []; },
    } as never);
    await queue.claim();
    expect(claimInput).toMatchObject({
      consumer: "site-worker",
      eventTypes: SITE_EFFECT_EVENT_TYPES,
    });
    expect(SITE_EFFECT_EVENT_TYPES).toEqual([
      "site.activation.begin.v1",
      "site.traffic-stop.request.v1",
    ]);
  });

  it("does not spend retry budget on abort and returns the claimed lease", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const consumer = new SiteOutboxConsumer(fakeQueue(outbox("site.activation.begin.v1", {
      attemptRef: "activation_01", state: "preparing",
    }), calls), {
      runActivation: async (_attemptRef, signal) => new Promise((_resolve, reject) => {
        calls.push("activation-started");
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
      runTrafficStop: async () => { throw new Error("unexpected"); },
    });
    const cycle = consumer.runOneCycle({ signal: controller.signal });
    await vi.waitFor(() => expect(calls).toContain("activation-started"));

    controller.abort(new DOMException("draining", "AbortError"));
    await expect(cycle).rejects.toMatchObject({ name: "AbortError" });
    expect(calls.some((call) => call.startsWith("retry:"))).toBe(false);
    expect(calls.some((call) => call.startsWith("ack:"))).toBe(false);

    await consumer.returnLeases("shutdown");
    expect(calls).toContain("release-owned:shutdown");
  });

  it("retries a detached AbortError because only the parent signal represents drain", async () => {
    const calls: string[] = [];
    const consumer = new SiteOutboxConsumer(fakeQueue(outbox("site.activation.begin.v1", {
      attemptRef: "activation_01", state: "preparing",
    }), calls), {
      runActivation: async () => { throw new DOMException("cancelled", "AbortError"); },
      runTrafficStop: async () => { throw new Error("unexpected"); },
    });

    await expect(consumer.runOneCycle({ signal: new AbortController().signal }))
      .resolves.toBeUndefined();
    expect(calls.some((call) => call.startsWith(
      "retry:event_01:lease_01:SITE_RUNTIME_UNEXPECTED:",
    ))).toBe(true);
  });

  it("coalesces concurrent cycles without claiming a second batch", async () => {
    const calls: string[] = [];
    let finish!: () => void;
    const consumer = new SiteOutboxConsumer(fakeQueue(outbox("site.activation.begin.v1", {
      attemptRef: "activation_01", state: "preparing",
    }), calls), {
      runActivation: async () => new Promise<void>((resolve) => { finish = resolve; }),
      runTrafficStop: async () => { throw new Error("unexpected"); },
    });

    const first = consumer.runOneCycle({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(calls).toContain("renew:event_01:lease_01"));
    const second = consumer.runOneCycle({ signal: new AbortController().signal });
    expect(calls.filter((call) => call === "claim")).toHaveLength(1);
    finish();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(calls.filter((call) => call === "claim")).toHaveLength(1);
  });

  it("keeps renewing until the fenced acknowledgement commits", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      let finishAck!: () => void;
      const queue = fakeQueue(outbox("site.activation.begin.v1", {
        attemptRef: "activation_01", state: "preparing",
      }), calls);
      queue.ack = async (eventId, leaseToken) => {
        calls.push(`ack-start:${eventId}:${leaseToken}`);
        await new Promise<void>((resolve) => { finishAck = resolve; });
        calls.push(`ack-end:${eventId}:${leaseToken}`);
      };
      const consumer = new SiteOutboxConsumer(queue, {
        runActivation: async () => undefined,
        runTrafficStop: async () => { throw new Error("unexpected"); },
      }, { leaseHeartbeatMs: 100 });

      const cycle = consumer.runOneCycle({ signal: new AbortController().signal });
      await vi.waitFor(() => expect(calls).toContain("ack-start:event_01:lease_01"));
      const renewalsBefore = calls.filter((call) => call.startsWith("renew:")).length;
      await vi.advanceTimersByTimeAsync(100);
      expect(calls.filter((call) => call.startsWith("renew:")).length)
        .toBeGreaterThan(renewalsBefore);
      finishAck();
      await cycle;
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a hung renewal without queueing overlapping renewals", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const queue = fakeQueue(outbox("site.activation.begin.v1", {
        attemptRef: "activation_01", state: "preparing",
      }), calls);
      let renewals = 0;
      queue.renew = async () => {
        renewals += 1;
        return new Promise<void>(() => undefined);
      };
      const consumer = new SiteOutboxConsumer(queue, {
        runActivation: async () => { calls.push("unexpected-dispatch"); },
        runTrafficStop: async () => { throw new Error("unexpected"); },
      }, { leaseHeartbeatMs: 100, leaseRenewalTimeoutMs: 50 });

      const cycle = consumer.runOneCycle({ signal: new AbortController().signal });
      const failure = expect(cycle).rejects.toThrow("SITE_OUTBOX_LEASE_RENEWAL_TIMEOUT");
      await vi.advanceTimersByTimeAsync(1_000);
      await failure;
      expect(renewals).toBe(1);
      expect(calls).not.toContain("unexpected-dispatch");
      await expect(consumer.returnLeases("shutdown")).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews a slow provider effect lease and never acks after renewal failure", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      let providerAbortReason: unknown;
      const queue = fakeQueue(outbox("site.activation.begin.v1", {
        attemptRef: "activation_01", state: "preparing",
      }), calls);
      let renewals = 0;
      queue.renew = async (eventId, leaseToken) => {
        calls.push(`renew:${eventId}:${leaseToken}`);
        if (++renewals === 2) throw new Error("OUTBOX_LEASE_LOST");
      };
      const consumer = new SiteOutboxConsumer(queue, {
        runActivation: async (_attemptRef, signal) => new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            providerAbortReason = signal.reason;
            reject(signal.reason);
          }, { once: true });
        }),
        runTrafficStop: async () => { throw new Error("unexpected"); },
      }, { leaseHeartbeatMs: 1_000 });
      const cycle = consumer.runOneCycle({ signal: new AbortController().signal });
      const cycleExpectation = expect(cycle).rejects.toThrow("OUTBOX_LEASE_LOST");
      await vi.advanceTimersByTimeAsync(1_000);
      await cycleExpectation;

      expect(calls).toContain("renew:event_01:lease_01");
      expect(providerAbortReason).toMatchObject({ message: "OUTBOX_LEASE_LOST" });
      expect(calls.some((call) => call.startsWith("ack:"))).toBe(false);
      expect(calls.some((call) => call.startsWith("retry:"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps every claimed lease alive while the first provider effect is still running", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const first = outbox("site.activation.begin.v1", {
        attemptRef: "activation_01", state: "preparing",
      });
      const second = { ...outbox("site.activation.begin.v1", {
        attemptRef: "activation_02", state: "preparing",
      }), eventId: "event_02", leaseToken: "lease_02" };
      const queue = fakeQueue([first, second], calls);
      let secondRenewals = 0;
      queue.renew = async (eventId, leaseToken) => {
        calls.push(`renew:${eventId}:${leaseToken}`);
        if (eventId === second.eventId && ++secondRenewals === 2) {
          throw new Error("OUTBOX_LEASE_LOST");
        }
      };
      let finishFirst!: () => void;
      const consumer = new SiteOutboxConsumer(queue, {
        runActivation: async (attemptRef) => {
          calls.push(`activation:${attemptRef}`);
          if (attemptRef === "activation_01") {
            await new Promise<void>((resolve) => { finishFirst = resolve; });
          }
        },
        runTrafficStop: async () => { throw new Error("unexpected"); },
      }, { leaseHeartbeatMs: 1_000 });

      const cycle = consumer.runOneCycle({ signal: new AbortController().signal });
      const cycleExpectation = expect(cycle).rejects.toThrow("OUTBOX_LEASE_LOST");
      await vi.advanceTimersByTimeAsync(1_000);
      finishFirst();
      await cycleExpectation;

      expect(calls).toContain("renew:event_02:lease_02");
      expect(calls).not.toContain("activation:activation_02");
      expect(calls).not.toContain("retry:event_02:lease_02:OUTBOX_LEASE_LOST:null:12");
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases Site leases with the exact worker, consumer, and event-type fence", async () => {
    let released: unknown;
    const transaction = Object.freeze({});
    const queue = createPostgresSiteRuntimeEventQueue({
      internalTransaction: async (_operation: string, work: (value: unknown) => Promise<unknown>) =>
        work(transaction),
    } as never, { workerId: "site-worker-01" }, {
      claim: async () => [],
      releaseOwnedLeases: async (_current: unknown, input: unknown) => {
        released = input;
        return 0;
      },
    } as never);

    await queue.releaseOwned("shutdown");

    expect(released).toEqual({
      workerId: "site-worker-01",
      consumer: "site-worker",
      eventTypes: SITE_EFFECT_EVENT_TYPES,
    });
  });
});

function fakeQueue(event: ClaimedOutboxEvent | readonly ClaimedOutboxEvent[], calls: string[]): SiteRuntimeEventQueue {
  return {
    claim: async () => { calls.push("claim"); return Array.isArray(event) ? event : [event]; },
    renew: async (eventId, leaseToken) => { calls.push(`renew:${eventId}:${leaseToken}`); },
    ack: async (eventId, leaseToken) => { calls.push(`ack:${eventId}:${leaseToken}`); },
    retry: async (input) => { calls.push(`retry:${input.eventId}:${input.leaseToken}:${input.errorCode}:` +
      `${input.retryAt}:${input.maxAttempts}`); },
    releaseOwned: async (reason) => {
      calls.push(`release-owned:${reason}`);
    },
  };
}

function outbox(eventType: string, payload: Record<string, string>): ClaimedOutboxEvent {
  return { eventId: "event_01", owner: "site", eventType, aggregateId: "site_01", payload,
    payloadDigest: "a".repeat(64), correlationId: "correlation_01", causationId: "request_01",
    leaseToken: "lease_01", attempt: 1 };
}
