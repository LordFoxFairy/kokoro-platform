import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCommerceOutboxReconciliationCycle, type CommerceOutboxProjection } from
  "../../src/modules/commerce/infrastructure/postgres/commerce-outbox-reconciler.js";
import { commerceCanonicalJson } from "../../src/modules/commerce/domain/canonical-json.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import type { PlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";
import type { ClaimedOutboxEvent, OutboxRepository } from "../../src/shared/outbox-inbox/outbox.js";

describe("Commerce outbox reconciler", () => {
  it("claims only Commerce events, verifies their durable projection, and completes the lease", async () => {
    const outbox = new RecordingOutbox([event()]);
    const projection = new RecordingProjection();
    const cycle = createCommerceOutboxReconciliationCycle({
      database: database(), outbox, projection, workerId: "worker-1", leaseToken: () => "lease-1",
    });

    await cycle({ signal: new AbortController().signal });

    expect(outbox.claimInput).toMatchObject({ owners: ["commerce"], workerId: "worker-1", leaseToken: "lease-1" });
    expect(projection.events).toHaveLength(1);
    expect(outbox.completed).toEqual([{ eventId: "00000000-0000-7000-8000-000000000501", leaseToken: "lease-1" }]);
    expect(outbox.retried).toEqual([]);
  });

  it("records bounded retry evidence instead of poisoning the whole worker cycle", async () => {
    const outbox = new RecordingOutbox([event()]);
    const projection: CommerceOutboxProjection = { assertFulfilled: async () => {
      throw new Error("projection unavailable");
    } };
    const cycle = createCommerceOutboxReconciliationCycle({
      database: database(), outbox, projection, workerId: "worker-1", leaseToken: () => "lease-1",
      clock: () => new Date("2026-07-29T01:00:00.000Z"), maxAttempts: 3,
    });

    await cycle({ signal: new AbortController().signal });

    expect(outbox.completed).toEqual([]);
    expect(outbox.retried).toEqual([{
      eventId: "00000000-0000-7000-8000-000000000501", leaseToken: "lease-1",
      errorCode: "COMMERCE_OUTBOX_RECONCILIATION_FAILED", retryAt: "2026-07-29T01:00:01.000Z", maxAttempts: 3,
    }]);
  });
});

class RecordingOutbox implements Pick<OutboxRepository, "claim" | "complete" | "retryOrDeadLetter"> {
  claimInput: Parameters<OutboxRepository["claim"]>[1] | null = null;
  completed: Array<{ eventId: string; leaseToken: string }> = [];
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
    eventId: string,
    leaseToken: string,
  ) {
    this.completed.push({ eventId, leaseToken });
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
  async assertFulfilled(_transaction: PlatformTransaction, eventValue: Parameters<CommerceOutboxProjection["assertFulfilled"]>[1]) {
    this.events.push(eventValue);
  }
}

function database() {
  return {
    async internalTransaction<Result>(
      operation: "commerce.outbox.reconcile",
      work: (transaction: PlatformTransaction) => Promise<Result>,
    ): Promise<Result> {
      expect(operation).toBe("commerce.outbox.reconcile");
      const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
      try {
        return await work(lease.transaction);
      } finally {
        revokePlatformTransaction(lease);
      }
    },
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
