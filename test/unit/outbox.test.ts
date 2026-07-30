import { describe, expect, it } from "vitest";
import { OutboxRepository, type OutboxEvent } from "../../src/shared/outbox-inbox/outbox.js";
import { issuePlatformTransaction, revokePlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";

describe("outbox retry bounds", () => {
  it("claims only the explicitly allowlisted effect event types", async () => {
    const queries: Array<{ statement: string; values: readonly unknown[] }> = [];
    const lease = issuePlatformTransaction({
      execute: async () => 0,
      query: async <Row extends Record<string, unknown>>(statement: string, values = []) => {
        queries.push({ statement, values });
        return [] as Row[];
      },
    });
    try {
      await new OutboxRepository().claim(lease.transaction, {
        workerId: "asset-worker-01",
        leaseToken: "lease-01",
        consumer: "asset-worker",
        eventTypes: [
          "asset.upload.completion.requested", "asset.scan.requested",
          "asset.blob.promotion.requested", "asset.object.cleanup.requested",
        ],
        limit: 10,
        leaseSeconds: 30,
        deployment: { environment: "production", region: "us-east-1" },
      });
      expect(queries[0]?.statement).toContain("event_type = ANY($6::text[])");
      expect(queries[0]?.statement).toContain("payload->>'environment'=$7");
      expect(queries[0]?.statement).toContain("payload->>'region'=$8");
      expect(queries[0]?.values).toEqual([
        10, "asset-worker-01", "lease-01", 30, ["asset"],
        ["asset.upload.completion.requested", "asset.scan.requested",
          "asset.blob.promotion.requested", "asset.object.cleanup.requested"],
        "production", "us-east-1",
      ]);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects invalid retry input before touching persistence", async () => {
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => { throw new Error("SQL_MUST_NOT_RUN"); } });
    try {
      await expect(new OutboxRepository().retryOrDeadLetter(lease.transaction, { eventId: "event", leaseToken: "lease", errorCode: "", retryAt: "invalid", maxAttempts: 0 })).rejects.toThrow("OUTBOX_RETRY_INPUT_INVALID");
    } finally { revokePlatformTransaction(lease); }
  });

  it("rejects an unregistered producer owner before touching persistence", async () => {
    const lease = issuePlatformTransaction({
      query: async () => { throw new Error("SQL_MUST_NOT_RUN"); },
      execute: async () => { throw new Error("SQL_MUST_NOT_RUN"); },
    });
    try {
      await expect(new OutboxRepository().enqueue(lease.transaction, {
        ...event(), owner: "orphan-owner" as never,
      })).rejects.toThrow("OUTBOX_OWNER_UNREGISTERED");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects an unregistered producer event type before touching persistence", async () => {
    const lease = issuePlatformTransaction({
      query: async () => { throw new Error("SQL_MUST_NOT_RUN"); },
      execute: async () => { throw new Error("SQL_MUST_NOT_RUN"); },
    });
    try {
      await expect(new OutboxRepository().enqueue(lease.transaction, {
        ...event(), owner: "asset", eventType: "asset.version.ready",
      })).rejects.toThrow("OUTBOX_EVENT_ROUTE_UNREGISTERED");
      await expect(new OutboxRepository().enqueue(lease.transaction, {
        ...event(), owner: "site", eventType: "site.register.v1",
      })).rejects.toThrow("OUTBOX_EVENT_ROUTE_UNREGISTERED");
      await expect(new OutboxRepository().enqueue(lease.transaction, {
        ...event(), owner: "identity", eventType: "identity.totp.enrollment_started",
      })).rejects.toThrow("OUTBOX_EVENT_ROUTE_UNREGISTERED");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects an unregistered consumer before touching persistence", async () => {
    const lease = issuePlatformTransaction({
      query: async () => { throw new Error("SQL_MUST_NOT_RUN"); },
      execute: async () => { throw new Error("SQL_MUST_NOT_RUN"); },
    });
    try {
      await expect(new OutboxRepository().claim(lease.transaction, {
        workerId: "orphan-worker-01", leaseToken: "lease-01",
        consumer: "orphan-worker" as never, eventTypes: [] as never, limit: 10, leaseSeconds: 30,
      })).rejects.toThrow("OUTBOX_CONSUMER_UNREGISTERED");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects a partial consumer event-type allowlist before touching persistence", async () => {
    const lease = issuePlatformTransaction({
      query: async () => { throw new Error("SQL_MUST_NOT_RUN"); },
      execute: async () => { throw new Error("SQL_MUST_NOT_RUN"); },
    });
    try {
      await expect(new OutboxRepository().claim(lease.transaction, {
        workerId: "asset-worker-01", leaseToken: "lease-01", consumer: "asset-worker",
        eventTypes: ["asset.scan.requested"], limit: 10, leaseSeconds: 30,
      })).rejects.toThrow("OUTBOX_EVENT_TYPE_ALLOWLIST_INVALID");
    } finally {
      revokePlatformTransaction(lease);
    }
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

  it("renews only the exact active lease token", async () => {
    const executions: Array<{ statement: string; values: readonly unknown[] }> = [];
    const lease = issuePlatformTransaction({ query: async () => [], execute: async (statement, values = []) => {
      executions.push({ statement, values });
      return 1;
    } });
    try {
      await new OutboxRepository().renewLease(lease.transaction, {
        eventId: "event-01", leaseToken: "lease-01", workerId: "worker-a",
        owner: "identity", leaseSeconds: 30,
      });
      expect(executions[0]?.statement).toContain(
        "state='leased' AND lease_token=$2 AND lease_owner=$3 AND owner=$4",
      );
      expect(executions[0]?.statement).toContain("lease_expires_at=now()+make_interval");
      expect(executions[0]?.values).toEqual([
        "event-01", "lease-01", "worker-a", "identity", 30,
      ]);
    } finally { revokePlatformTransaction(lease); }
  });

  it("returns every owned lease for a bounded owner set during worker shutdown", async () => {
    const statements: unknown[] = [];
    const lease = issuePlatformTransaction({
      query: async () => [],
      execute: async (statement, values) => {
        statements.push({ statement, values });
        return 2;
      },
    });
    try {
      await expect(new OutboxRepository().releaseOwnedLeases(lease.transaction, {
        workerId: "admin-worker-01",
        consumer: "admin-worker",
        eventTypes: ["admin.approval.execution.requested"],
      })).resolves.toBe(2);
      expect(statements[0]).toMatchObject({
        statement: expect.stringContaining(
          "lease_owner=$1 AND owner=ANY($2::text[]) AND event_type=ANY($3::text[])",
        ),
        values: ["admin-worker-01", ["admin-execution"], ["admin.approval.execution.requested"]],
      });
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("never returns another worker instance's leases", async () => {
    const executions: Array<{ statement: string; values: readonly unknown[] }> = [];
    const lease = issuePlatformTransaction({
      query: async () => [],
      execute: async (statement, values = []) => {
        executions.push({ statement, values });
        return 1;
      },
    });
    try {
      const repository = new OutboxRepository();
      await repository.releaseOwnedLeases(lease.transaction, {
        workerId: "worker-a", consumer: "identity-worker",
        eventTypes: [
          "identity.verification.delivery.requested", "identity.namespace.allocation.requested",
        ],
      });
      await repository.releaseOwnedLeases(lease.transaction, {
        workerId: "worker-b", consumer: "identity-worker",
        eventTypes: [
          "identity.verification.delivery.requested", "identity.namespace.allocation.requested",
        ],
      });
      expect(executions).toEqual([
        expect.objectContaining({ values: ["worker-a", ["identity"], [
          "identity.verification.delivery.requested", "identity.namespace.allocation.requested",
        ]] }),
        expect.objectContaining({ values: ["worker-b", ["identity"], [
          "identity.verification.delivery.requested", "identity.namespace.allocation.requested",
        ]] }),
      ]);
      expect(executions[0]?.statement).toContain(
        "lease_owner=$1 AND owner=ANY($2::text[]) AND event_type=ANY($3::text[])",
      );
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it.each([
    ["missing", undefined],
    ["out of order", [
      "identity.namespace.allocation.requested",
      "identity.verification.delivery.requested",
    ]],
    ["extra", [
      "identity.verification.delivery.requested",
      "identity.namespace.allocation.requested",
      "admin.approval.execution.requested",
    ]],
  ])("fails closed for a %s shutdown event-type allowlist", async (_case, eventTypes) => {
    const lease = issuePlatformTransaction({
      query: async () => [],
      execute: async () => { throw new Error("SQL_MUST_NOT_RUN"); },
    });
    try {
      await expect(new OutboxRepository().releaseOwnedLeases(lease.transaction, {
        workerId: "identity-worker-01",
        consumer: "identity-worker",
        eventTypes: eventTypes as never,
      })).rejects.toThrow("OUTBOX_EVENT_TYPE_ALLOWLIST_INVALID");
    } finally {
      revokePlatformTransaction(lease);
    }
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
