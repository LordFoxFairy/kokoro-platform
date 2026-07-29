import { describe, expect, it } from "vitest";
import { OutboxRepository, type OutboxEvent } from "../../src/shared/outbox-inbox/outbox.js";
import { issuePlatformTransaction, revokePlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";

describe("outbox retry bounds", () => {
  it("rejects invalid retry input before touching persistence", async () => {
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => { throw new Error("SQL_MUST_NOT_RUN"); } });
    try {
      await expect(new OutboxRepository().retryOrDeadLetter(lease.transaction, { eventId: "event", leaseToken: "lease", errorCode: "", retryAt: "invalid", maxAttempts: 0 })).rejects.toThrow("OUTBOX_RETRY_INPUT_INVALID");
    } finally { revokePlatformTransaction(lease); }
  });

  it("rejects an event-id replay when any immutable envelope field differs", async () => {
    const candidate = event();
    const lease = issuePlatformTransaction({
      execute: async () => 0,
      query: async <Row extends Record<string, unknown>>(statement: string) => {
        if (statement.includes("INSERT INTO")) return [];
        return [{
          eventId: candidate.eventId,
          owner: candidate.owner,
          eventType: "commerce.redemption.reversed.v1",
          aggregateId: candidate.aggregateId,
          payload: candidate.payload,
          payloadDigest: candidate.payloadDigest,
          correlationId: candidate.correlationId,
          causationId: candidate.causationId,
        }] as unknown as Row[];
      },
    });
    try {
      await expect(new OutboxRepository().enqueue(lease.transaction, candidate))
        .rejects.toThrow("OUTBOX_EVENT_ENVELOPE_CONFLICT");
    } finally { revokePlatformTransaction(lease); }
  });

  it("persists the consumer acknowledgement atomically with delivered state", async () => {
    const executions: Array<{ statement: string; values: readonly unknown[] }> = [];
    const lease = issuePlatformTransaction({ query: async () => [], execute: async (statement, values = []) => {
      executions.push({ statement, values });
      return 1;
    } });
    try {
      await new OutboxRepository().complete(lease.transaction, {
        eventId: event().eventId,
        leaseToken: "lease-1",
        deliveryId: "delivery-1",
        acknowledgedAt: "2026-07-29T01:00:01.000Z",
      });
      expect(executions[0]?.statement).toContain("consumer_delivery_id");
      expect(executions[0]?.values).toEqual([
        event().eventId, "lease-1", "delivery-1", "2026-07-29T01:00:01.000Z",
      ]);
    } finally { revokePlatformTransaction(lease); }
  });

  it("returns a leased event to pending without consuming another attempt", async () => {
    let statement = "";
    const lease = issuePlatformTransaction({ query: async () => [], execute: async (value) => {
      statement = value; return 1;
    } });
    try {
      await new OutboxRepository().release(lease.transaction, {
        eventId: "event", leaseToken: "lease", errorCode: "SITE_SHUTDOWN",
      });
      expect(statement).toContain("state='pending'");
      expect(statement).not.toContain("attempt=attempt+1");
      expect(statement).toContain("lease_token=NULL");
    } finally { revokePlatformTransaction(lease); }
  });
});

function event(): OutboxEvent {
  return {
    eventId: "00000000-0000-7000-8000-000000000501",
    owner: "commerce",
    eventType: "commerce.redemption.fulfilled.v1",
    aggregateId: "00000000-0000-7000-8000-000000000301",
    payload: { version: 1, value: "same-payload" },
    payloadDigest: "a".repeat(64),
    correlationId: "command-1",
    causationId: null,
  };
}
