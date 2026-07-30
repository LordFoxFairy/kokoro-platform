import { describe, expect, it } from "vitest";
import type {
  IdentityNamespaceAllocationEffect,
  IdentityVerificationDeliveryEffect,
} from "../../src/modules/identity/application/services/identity-outbox-consumer.js";
import {
  createPostgresIdentityEffectEventQueue,
  PostgresIdentityOutboxOutcomeRepository,
  type IdentityOutboxOutcomeRepository,
} from "../../src/modules/identity/infrastructure/postgres/identity-outbox-consumer.js";
import type { OutboxRepository } from "../../src/shared/outbox-inbox/outbox.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
  type PlatformSqlTransaction,
  type PlatformTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";

describe("Postgres Identity outbox outcome authority", () => {
  it("validates the verification owner projection before any external delivery", async () => {
    const sql = new RecordingSql();
    sql.queryRows = [{
      eventId: "event-verification-01",
      transactionRef: "transaction-01",
      deliveryState: "queued",
      verificationState: "pending",
      deliveryCredentialRevision: 0,
      verificationCredentialRevision: 0,
      credentialLive: true,
    }];
    await withTransaction(sql, (transaction) =>
      new PostgresIdentityOutboxOutcomeRepository().prepareVerification(
        transaction,
        verificationEffect(),
      ));
    expect(sql.statements[0]).toMatch(/identity_verification_delivery[\s\S]+identity_verification_transaction/u);
    expect(sql.statements[0]).toContain("FOR UPDATE OF delivery");
    expect(sql.statements[0]).not.toContain("FOR UPDATE OF verification");
    expect(sql.statements[1]).toContain("state='dispatching'");

    sql.queryRows = [{
      eventId: "event-verification-01",
      transactionRef: "other-transaction",
      deliveryState: "queued",
      verificationState: "pending",
      deliveryCredentialRevision: 0,
      verificationCredentialRevision: 0,
      credentialLive: true,
    }];
    await expect(withTransaction(sql, (transaction) =>
      new PostgresIdentityOutboxOutcomeRepository().prepareVerification(
        transaction,
        verificationEffect(),
      ))).rejects.toThrow("IDENTITY_VERIFICATION_DELIVERY_NOT_DELIVERABLE");
  });

  it("CASes the complete delivery outcome before the shared outbox acknowledgement", async () => {
    const calls: string[] = [];
    const queue = createPostgresIdentityEffectEventQueue(
      database(calls),
      { workerId: "identity-worker-01" },
      outcomeRepository(calls),
      outbox(calls),
    );

    await queue.completeVerification(verificationEffect(), {
      deliveryId: "provider-delivery-01",
      acknowledgedAt: "2026-07-30T12:00:01.000Z",
    });

    expect(calls).toEqual([
      "begin:identity.outbox.consume",
      "delivery-outcome:event-verification-01:provider-delivery-01",
      "outbox-complete:event-verification-01:lease-01:provider-delivery-01",
      "commit:identity.outbox.consume",
    ]);
  });

  it("atomically consumes an older credential revision as superseded without delivery", async () => {
    const sql = new RecordingSql();
    sql.queryRows = [{
      eventId: "event-verification-01", transactionRef: "transaction-01",
      deliveryState: "queued", verificationState: "pending",
      deliveryCredentialRevision: 0, verificationCredentialRevision: 1, credentialLive: true,
    }];
    const disposition = await withTransaction(sql, (transaction) =>
      new PostgresIdentityOutboxOutcomeRepository().prepareVerification(
        transaction,
        verificationEffect(),
      ));
    expect(disposition).toBe("superseded");
    expect(sql.statements[1]).toContain("state='superseded'");

    const calls: string[] = [];
    const outcomes = outcomeRepository(calls);
    outcomes.prepareVerification = async (_transaction, effect) => {
      calls.push(`supersede-outcome:${effect.eventId}`);
      return "superseded";
    };
    const queue = createPostgresIdentityEffectEventQueue(
      database(calls),
      { workerId: "identity-worker-01", now: () => "2026-07-30T12:00:00.000Z" },
      outcomes,
      outbox(calls),
    );
    await expect(queue.prepareVerification(verificationEffect())).resolves.toBe("superseded");
    expect(calls).toEqual([
      "begin:identity.outbox.consume",
      "supersede-outcome:event-verification-01",
      "outbox-complete:event-verification-01:lease-01:event-verification-01",
      "commit:identity.outbox.consume",
    ]);
  });

  it("applies the local namespace owner and completes its outbox event in one transaction", async () => {
    const calls: string[] = [];
    const queue = createPostgresIdentityEffectEventQueue(
      database(calls),
      { workerId: "identity-worker-01" },
      outcomeRepository(calls),
      outbox(calls),
    );

    await queue.applyNamespace(namespaceEffect());

    expect(calls).toEqual([
      "begin:identity.outbox.consume",
      "namespace-outcome:event-namespace-01:namespace-intent-01",
      "outbox-complete:event-namespace-01:lease-02:identity-namespace:event-namespace-01",
      "commit:identity.outbox.consume",
    ]);
  });

  it("records retry/dead-letter owner state and shared outbox state atomically", async () => {
    const calls: string[] = [];
    const queue = createPostgresIdentityEffectEventQueue(
      database(calls),
      { workerId: "identity-worker-01" },
      outcomeRepository(calls),
      outbox(calls),
    );
    await queue.fail(verificationEffect(), {
      errorCode: "IDENTITY_DELIVERY_TIMEOUT",
      retryAt: "2026-07-30T12:00:02.000Z",
      maxAttempts: 8,
      permanent: false,
    });
    expect(calls).toEqual([
      "begin:identity.outbox.consume",
      "failure-outcome:event-verification-01:IDENTITY_DELIVERY_TIMEOUT:false",
      "outbox-retry:event-verification-01:IDENTITY_DELIVERY_TIMEOUT:2026-07-30T12:00:02.000Z",
      "commit:identity.outbox.consume",
    ]);
  });

  it("uses the shared lease repository for exact claims, renewal, and shutdown release", async () => {
    const calls: string[] = [];
    const queue = createPostgresIdentityEffectEventQueue(
      database(calls),
      { workerId: "identity-worker-01", claimLimit: 7, leaseSeconds: 45 },
      outcomeRepository(calls),
      outbox(calls),
    );
    await queue.claim();
    await queue.renew("event-verification-01", "lease-01");
    await queue.releaseOwned("shutdown");

    expect(calls).toContain(
      "outbox-claim:identity-worker:identity.verification.delivery.requested,identity.namespace.allocation.requested:7:45",
    );
    expect(calls).toContain(
      "outbox-renew:event-verification-01:lease-01:identity-worker-01:identity:45",
    );
    expect(calls).toContain("outbox-release-owned:identity-worker-01:identity-worker");
  });

  it("requires the complete namespace graph to match before activating admission", async () => {
    const sql = new RecordingSql();
    sql.queryRows = [{
      eventId: "event-namespace-01", intentRef: "namespace-intent-01", siteRef: "site-01",
      subjectRef: "subject-01", workspaceRef: "workspace-01", projectRef: "project-01",
      executionSpaceRef: "execution-space-01",
      executionNamespace: "opaque-namespace-000000000000000001",
      intentState: "pending", executionSpaceState: "allocation_pending",
    }];
    sql.executeResults = [1, 1];
    await withTransaction(sql, (transaction) =>
      new PostgresIdentityOutboxOutcomeRepository().applyNamespace(
        transaction,
        namespaceEffect(),
        "2026-07-30T12:00:01.000Z",
      ));

    expect(sql.statements[0]).toMatch(
      /identity_namespace_allocation_intent[\s\S]+identity_personal_bootstrap[\s\S]+identity_execution_space/u,
    );
    expect(sql.statements[1]).toContain("UPDATE platform.identity_execution_space");
    expect(sql.statements[2]).toContain("UPDATE platform.identity_namespace_allocation_intent");
  });
});

class RecordingSql implements PlatformSqlTransaction {
  statements: string[] = [];
  queryRows: readonly Record<string, unknown>[] = [];
  executeResults: number[] = [];
  async query<Row extends Record<string, unknown>>(statement: string): Promise<readonly Row[]> {
    this.statements.push(statement);
    return this.queryRows as readonly Row[];
  }
  async execute(statement: string): Promise<number> {
    this.statements.push(statement);
    return this.executeResults.shift() ?? 1;
  }
}

async function withTransaction<Result>(
  sql: PlatformSqlTransaction,
  work: (transaction: PlatformTransaction) => Promise<Result>,
): Promise<Result> {
  const lease = issuePlatformTransaction(sql);
  try { return await work(lease.transaction); } finally { revokePlatformTransaction(lease); }
}

function database(calls: string[]) {
  return {
    internalTransaction: async <Result>(operation: "identity.outbox.consume", work: (
      transaction: PlatformTransaction,
    ) => Promise<Result>) => {
      calls.push(`begin:${operation}`);
      const result = await withTransaction({ query: async () => [], execute: async () => 1 }, work);
      calls.push(`commit:${operation}`);
      return result;
    },
  };
}

function outcomeRepository(calls: string[]): IdentityOutboxOutcomeRepository {
  return {
    prepareVerification: async (_transaction, effect) => {
      calls.push(`prepare-outcome:${effect.eventId}`);
      return "dispatch" as const;
    },
    recordVerificationDelivered: async (_transaction, effect, ack) => {
      calls.push(`delivery-outcome:${effect.eventId}:${ack.deliveryId}`);
    },
    applyNamespace: async (_transaction, effect) => {
      calls.push(`namespace-outcome:${effect.eventId}:${effect.payload.namespaceIntentRef}`);
    },
    recordFailure: async (_transaction, effect, failure) => {
      calls.push(`failure-outcome:${effect.eventId}:${failure.errorCode}:${failure.permanent}`);
    },
  };
}

function outbox(calls: string[]): Pick<OutboxRepository,
  "claim" | "renewLease" | "complete" | "retryOrDeadLetter" | "releaseOwnedLeases"> {
  return {
    claim: async (_transaction, input) => {
      calls.push(`outbox-claim:${input.consumer}:${input.eventTypes.join(",")}:${input.limit}:${input.leaseSeconds}`);
      return [];
    },
    renewLease: async (_transaction, input) => {
      calls.push(
        `outbox-renew:${input.eventId}:${input.leaseToken}:${input.workerId}:${input.owner}:${input.leaseSeconds}`,
      );
    },
    complete: async (_transaction, input) => {
      calls.push(`outbox-complete:${input.eventId}:${input.leaseToken}:${input.deliveryId}`);
    },
    retryOrDeadLetter: async (_transaction, input) => {
      calls.push(`outbox-retry:${input.eventId}:${input.errorCode}:${input.retryAt}`);
    },
    releaseOwnedLeases: async (_transaction, input) => {
      calls.push(`outbox-release-owned:${input.workerId}:${input.consumer}`);
      return 1;
    },
  };
}

function verificationEffect(): IdentityVerificationDeliveryEffect {
  return {
    eventId: "event-verification-01", aggregateId: "transaction-01",
    payloadDigest: "a".repeat(64), correlationId: "correlation-01", causationId: "command-01",
    leaseToken: "lease-01", attempt: 1,
    payload: {
      kind: "sealed_identity_verification_v1",
      credentialRevision: 0,
      sealedEnvelope: {
        algorithm: "A256GCM", keyRevision: "delivery-key-1",
        nonce: Buffer.alloc(12, 1).toString("base64url"), ciphertext: "ciphertext",
        authenticationTag: Buffer.alloc(16, 2).toString("base64url"),
      },
    },
  };
}

function namespaceEffect(): IdentityNamespaceAllocationEffect {
  return {
    eventId: "event-namespace-01", aggregateId: "execution-space-01",
    payloadDigest: "b".repeat(64), correlationId: "correlation-01", causationId: "command-01",
    leaseToken: "lease-02", attempt: 1,
    payload: {
      kind: "identity_namespace_allocation_v1", siteRef: "site-01", subjectRef: "subject-01",
      workspaceRef: "workspace-01", projectRef: "project-01",
      executionSpaceRef: "execution-space-01",
      executionNamespace: "opaque-namespace-000000000000000001",
      namespaceIntentRef: "namespace-intent-01",
    },
  };
}
