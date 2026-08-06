import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  IdentityOutboxConsumer,
  type IdentityEffectEventQueue,
  type IdentityVerificationDeliveryPort,
} from "../../src/modules/identity/application/services/identity-outbox-consumer.js";
import { createIdentityAuditDigester } from
  "../../src/modules/identity/infrastructure/crypto/identity-audit-digester.js";
import { HmacIdentityVerificationDeliveryAdapter } from
  "../../src/modules/identity/infrastructure/http/hmac-identity-verification-delivery.js";
import type { ClaimedOutboxEvent, OutboxDeliveryAcknowledgement } from
  "../../src/shared/outbox-inbox/outbox.js";

const auditDigest = createIdentityAuditDigester(new Uint8Array(32).fill(9));

describe("IdentityOutboxConsumer", () => {
  it("claims from its bound queue and atomically completes both Identity effect outcomes", async () => {
    const calls: string[] = [];
    const queue = recordingQueue([verificationEvent(), namespaceEvent()], calls);
    const delivery: IdentityVerificationDeliveryPort = {
      publish: vi.fn(async (effect) => {
        calls.push(`publish:${effect.eventId}:${effect.payload.sealedEnvelope.keyRevision}`);
        return acknowledgement();
      }),
    };
    const consumer = new IdentityOutboxConsumer(queue, delivery, { auditDigest });

    await consumer.runOneCycle({ signal: new AbortController().signal });

    expect(calls[0]).toBe("claim");
    expect(calls).toContain("prepare-verification:event-verification-01");
    expect(calls).toContain("publish:event-verification-01:delivery-key-1");
    expect(calls).toContain("complete-verification:event-verification-01:provider-delivery-01");
    expect(calls).toContain("apply-namespace:event-namespace-01:namespace-intent-01");
    expect(calls.some((call) => call.startsWith("fail:"))).toBe(false);
  });

  it("dead-letters a tampered payload without invoking either effect", async () => {
    const calls: string[] = [];
    const tampered = { ...verificationEvent(), payloadDigest: "f".repeat(64) };
    const delivery: IdentityVerificationDeliveryPort = {
      publish: vi.fn(async () => acknowledgement()),
    };
    const consumer = new IdentityOutboxConsumer(recordingQueue([tampered], calls), delivery, {
      auditDigest,
    });

    await consumer.runOneCycle({ signal: new AbortController().signal });

    expect(delivery.publish).not.toHaveBeenCalled();
    expect(calls).toContain(
      "fail:event-verification-01:IDENTITY_OUTBOX_EVENT_INVALID:null:true",
    );
  });

  it("consumes a superseded credential revision without invoking the provider", async () => {
    const calls: string[] = [];
    const queue = recordingQueue([verificationEvent()], calls);
    queue.prepareVerification = async (effect) => {
      calls.push(`prepare-superseded:${effect.eventId}`);
      return "superseded";
    };
    const delivery: IdentityVerificationDeliveryPort = {
      publish: vi.fn(async () => acknowledgement()),
    };
    const consumer = new IdentityOutboxConsumer(queue, delivery, { auditDigest });

    await consumer.runOneCycle({ signal: new AbortController().signal });

    expect(calls).toContain("prepare-superseded:event-verification-01");
    expect(delivery.publish).not.toHaveBeenCalled();
    expect(calls.some((call) => call.startsWith("fail:"))).toBe(false);
  });

  it("retries a provider timeout but permanently rejects an authenticated bad request", async () => {
    const retryCalls: string[] = [];
    const retrying = new IdentityOutboxConsumer(recordingQueue([verificationEvent(3)], retryCalls), {
      publish: async () => { throw Object.assign(new Error("IDENTITY_DELIVERY_TIMEOUT"), {
        retryable: true,
      }); },
    }, {
      auditDigest,
      now: () => "2026-07-30T12:00:00.000Z",
      baseRetryMs: 1_000,
      maxAttempts: 8,
    });
    await retrying.runOneCycle({ signal: new AbortController().signal });
    expect(retryCalls).toContain(
      "fail:event-verification-01:IDENTITY_DELIVERY_TIMEOUT:2026-07-30T12:00:04.000Z:false",
    );

    const permanentCalls: string[] = [];
    const permanent = new IdentityOutboxConsumer(
      recordingQueue([verificationEvent()], permanentCalls),
      { publish: async () => { throw Object.assign(new Error("IDENTITY_DELIVERY_HTTP_400"), {
        retryable: false,
      }); } },
      { auditDigest },
    );
    await permanent.runOneCycle({ signal: new AbortController().signal });
    expect(permanentCalls).toContain(
      "fail:event-verification-01:IDENTITY_DELIVERY_HTTP_400:null:true",
    );
  });

  it("leaves an acknowledged effect leased when atomic outcome persistence is ambiguous", async () => {
    const calls: string[] = [];
    const queue = recordingQueue([verificationEvent()], calls);
    const ambiguity = new Error("database connection lost after commit");
    queue.completeVerification = vi.fn(async () => {
      calls.push("complete-ambiguous");
      throw ambiguity;
    });
    const consumer = new IdentityOutboxConsumer(queue, {
      publish: async () => acknowledgement(),
    }, { auditDigest });

    const failure = await consumer.runOneCycle({ signal: new AbortController().signal })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe("IDENTITY_OUTBOX_BATCH_FAILED");
    expect((failure as AggregateError).errors).toEqual([ambiguity]);

    expect(calls).toContain("complete-ambiguous");
    expect(calls.some((call) => call.startsWith("fail:"))).toBe(false);
  });

  it("stops new claims and returns all owned leases during shutdown", async () => {
    const calls: string[] = [];
    let finish: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    const consumer = new IdentityOutboxConsumer(recordingQueue([verificationEvent()], calls), {
      publish: async (_effect, signal) => {
        calls.push("publish-started");
        await Promise.race([
          blocked,
          new Promise<never>((_resolve, reject) => signal.addEventListener(
            "abort", () => reject(signal.reason), { once: true },
          )),
        ]);
        return acknowledgement();
      },
    }, { auditDigest });
    const controller = new AbortController();
    const cycle = consumer.runOneCycle({ signal: controller.signal });
    await vi.waitFor(() => expect(calls).toContain("publish-started"));

    await consumer.stopClaiming();
    controller.abort(new Error("PLATFORM_WORKER_DRAINING"));
    await expect(cycle).rejects.toThrow("PLATFORM_WORKER_DRAINING");
    await consumer.returnLeases("shutdown");
    finish?.();
    await consumer.runOneCycle({ signal: new AbortController().signal });

    expect(calls).toContain("release-owned:shutdown");
    expect(calls.filter((call) => call === "claim")).toHaveLength(1);
  });

  it("uses eventId as the stable provider idempotency key and never leaks response secrets", async () => {
    const secret = Buffer.alloc(32, 7);
    const headers: Headers[] = [];
    const bodies: string[] = [];
    const adapter = new HmacIdentityVerificationDeliveryAdapter({
      endpoint: "https://identity-delivery.internal/v1/events",
      keyId: "identity-key-1",
      secretBase64: secret.toString("base64"),
      fetch: async (_url, init) => {
        headers.push(new Headers(init?.headers));
        bodies.push(String(init?.body));
        const response = {
          eventId: "event-verification-01",
          deliveryId: "provider-delivery-01",
          acknowledgedAt: "2026-07-30T12:00:01.000Z",
        };
        const acknowledgementMac = createHmac("sha256", secret).update(JSON.stringify({
          acknowledgedAt: response.acknowledgedAt,
          deliveryId: response.deliveryId,
          eventId: response.eventId,
          payloadDigest: verificationEvent().payloadDigest,
        })).digest("base64url");
        return new Response(JSON.stringify({ ...response, acknowledgementMac }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const effect = verificationEffect();

    await adapter.publish(effect, new AbortController().signal);
    await adapter.publish(effect, new AbortController().signal);

    expect(headers.map((value) => value.get("x-kokoro-idempotency-key")))
      .toEqual([effect.eventId, effect.eventId]);
    expect(bodies[0]).toBe(bodies[1]);

    const failing = new HmacIdentityVerificationDeliveryAdapter({
      endpoint: "https://identity-delivery.internal/v1/events",
      keyId: "identity-key-1",
      secretBase64: secret.toString("base64"),
      fetch: async () => new Response("verification-secret-must-not-leak", { status: 400 }),
    });
    await expect(failing.publish(effect, new AbortController().signal)).rejects.toMatchObject({
      message: "IDENTITY_DELIVERY_HTTP_400",
      retryable: false,
    });
    await expect(failing.publish(effect, new AbortController().signal)).rejects.not.toThrow(
      /verification-secret-must-not-leak/u,
    );
  });

  it("retries an outcome-unknown delivery when a successful response stream resets", async () => {
    const adapter = new HmacIdentityVerificationDeliveryAdapter({
      endpoint: "https://identity-delivery.internal/v1/events",
      keyId: "identity-key-1",
      secretBase64: Buffer.alloc(32, 7).toString("base64"),
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"eventId":"event-verification-01"'));
          controller.error(new Error("peer reset after applying event"));
        },
      }), { status: 200 }),
    });

    await expect(adapter.publish(verificationEffect(), new AbortController().signal))
      .rejects.toMatchObject({
        message: "IDENTITY_DELIVERY_ACK_OUTCOME_UNKNOWN",
        retryable: true,
      });
  });
});

function recordingQueue(events: readonly ClaimedOutboxEvent[], calls: string[]) {
  const queue: IdentityEffectEventQueue = {
    claim: async () => {
      calls.push("claim");
      return events;
    },
    renew: async (eventId) => { calls.push(`renew:${eventId}`); },
    prepareVerification: async (effect) => {
      calls.push(`prepare-verification:${effect.eventId}`);
      return "dispatch" as const;
    },
    completeVerification: async (effect, ack) => {
      calls.push(`complete-verification:${effect.eventId}:${ack.deliveryId}`);
    },
    applyNamespace: async (effect) => {
      calls.push(`apply-namespace:${effect.eventId}:${effect.payload.namespaceIntentRef}`);
    },
    fail: async (event, failure) => {
      calls.push(`fail:${event.eventId}:${failure.errorCode}:${failure.retryAt}:${failure.permanent}`);
    },
    releaseOwned: async (reason) => { calls.push(`release-owned:${reason}`); },
  };
  return queue;
}

function verificationEffect() {
  const value = verificationEvent();
  return {
    eventId: value.eventId,
    aggregateId: value.aggregateId,
    payloadDigest: value.payloadDigest,
    correlationId: value.correlationId,
    causationId: value.causationId,
    leaseToken: value.leaseToken,
    attempt: value.attempt,
    payload: value.payload as {
      kind: "sealed_identity_verification_v1";
      credentialRevision: number;
      sealedEnvelope: {
        algorithm: "A256GCM"; keyRevision: string; nonce: string;
        ciphertext: string; authenticationTag: string;
      };
    },
  } as const;
}

function verificationEvent(attempt = 1): ClaimedOutboxEvent {
  const payload = {
    kind: "sealed_identity_verification_v1",
    credentialRevision: 0,
    sealedEnvelope: {
      algorithm: "A256GCM", keyRevision: "delivery-key-1",
      nonce: Buffer.alloc(12, 1).toString("base64url"),
      ciphertext: Buffer.from("encrypted-verification-envelope").toString("base64url"),
      authenticationTag: Buffer.alloc(16, 2).toString("base64url"),
    },
  } as const;
  return {
    eventId: "event-verification-01", owner: "identity",
    eventType: "identity.verification.delivery.requested",
    aggregateId: "transaction-01", payload, payloadDigest: auditDigest(payload),
    correlationId: "correlation-01", causationId: "command-01",
    leaseToken: "lease-01", attempt,
  };
}

function namespaceEvent(attempt = 1): ClaimedOutboxEvent {
  const payload = {
    kind: "identity_namespace_allocation_v1", siteRef: "site-01",
    subjectRef: "subject-01", workspaceRef: "workspace-01", projectRef: "project-01",
    executionSpaceRef: "execution-space-01",
    executionNamespace: "opaque-namespace-000000000000000001",
    namespaceIntentRef: "namespace-intent-01",
  } as const;
  return {
    eventId: "event-namespace-01", owner: "identity",
    eventType: "identity.namespace.allocation.requested",
    aggregateId: payload.executionSpaceRef, payload, payloadDigest: auditDigest(payload),
    correlationId: "correlation-01", causationId: "command-01",
    leaseToken: "lease-02", attempt,
  };
}

function acknowledgement(): OutboxDeliveryAcknowledgement {
  return {
    deliveryId: "provider-delivery-01",
    acknowledgedAt: "2026-07-30T12:00:01.000Z",
  };
}
