import { describe, expect, it } from "vitest";
import type { ClaimedOutboxEvent } from "../../src/shared/outbox-inbox/outbox.js";
import {
  SiteRuntimePendingError,
} from "../../src/modules/site/application/services/site-runtime-dispatcher.js";
import {
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
    expect(calls).toEqual(["claim", "activation:activation_01", "ack:event_01:lease_01"]);
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
});

function fakeQueue(event: ClaimedOutboxEvent, calls: string[]): SiteRuntimeEventQueue {
  return {
    claim: async () => { calls.push("claim"); return [event]; },
    ack: async (eventId, leaseToken) => { calls.push(`ack:${eventId}:${leaseToken}`); },
    retry: async (input) => { calls.push(`retry:${input.eventId}:${input.leaseToken}:${input.errorCode}:` +
      `${input.retryAt}:${input.maxAttempts}`); },
    release: async () => undefined,
  };
}

function outbox(eventType: string, payload: Record<string, string>): ClaimedOutboxEvent {
  return { eventId: "event_01", owner: "site", eventType, aggregateId: "site_01", payload,
    payloadDigest: "a".repeat(64), correlationId: "correlation_01", causationId: "request_01",
    leaseToken: "lease_01", attempt: 1 };
}
