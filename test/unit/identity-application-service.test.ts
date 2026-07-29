import { describe, expect, it } from "vitest";
import { issuePlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";
import {
  IdentityApplicationService,
  type IdentityCommandReceiptPort,
  type IdentityOutboxPort,
} from "../../src/modules/identity/application/services/identity-application-service.js";
import { IdentitySessionAuthorizationMutation } from "../../src/modules/identity/application/services/identity-session-authorization-mutation.js";
import { SubjectAuthorizationMutation } from "../../src/modules/identity/application/services/subject-authorization-mutation.js";
import type { IdentityRepository } from "../../src/modules/identity/application/contracts/identity-repository.js";
import type { CommandReceipt } from "../../src/shared/outbox-inbox/receipt.js";

const transaction = issuePlatformTransaction({
  async query() { return []; }, async execute() { return 0; },
}).transaction;
const workload = {
  siteRef: "site-1", siteReleaseRef: "release-1", workloadIdentityId: "workload-1",
  environment: "production", region: "us-east-1",
} as const;
const context = { correlationId: "correlation-1" } as never;
const commandId = "1".repeat(32);

describe("Identity launch application service", () => {
  it("freezes legal evidence and queues only a sealed verification envelope", async () => {
    let created: Parameters<IdentityRepository["createVerification"]>[1] | undefined;
    let outboxPayload: unknown;
    const repository = {
      async createVerification(_transaction: unknown, input: NonNullable<typeof created>) { created = input; return "created" as const; },
      async recordVerificationDelivery() {},
    } as unknown as IdentityRepository;
    const receipts = pendingReceipts();
    const references = [
      "account-1", "subject-1", "transaction-1", "delivery-1",
      "018f1111-1111-7111-8111-111111111111",
    ];
    const service = createService({
      repository,
      receipts,
      references,
      outbox: { async enqueue(_transaction, event) { outboxPayload = event.payload; } },
    });

    const result = await service.beginRegistration({
      workload: workload as never, context, commandId, idempotencyKey: "i".repeat(16),
      email: "Person@Example.com", password: "correct horse battery staple",
      legalAcceptanceRefs: ["terms-v1", "privacy-v1"],
    });

    expect(result.transaction).toEqual({
      transactionRef: "transaction-1",
      expiresAt: "2026-07-29T00:15:00.000Z",
      deliveryState: "queued",
    });
    expect(created?.emailNormalized).toBe("person@example.com");
    expect(created?.legalAcceptances.map((item) => item.termRef)).toEqual(["privacy-v1", "terms-v1"]);
    expect(created?.acceptedAt).toBe("2026-07-29T00:00:00.000Z");
    const serialized = JSON.stringify(outboxPayload);
    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain("correct horse battery staple");
    expect(serialized).not.toContain("verification-secret");
  });

  it("delivers a credential pair once and never replays it on an exact retry", async () => {
    const receipts = pendingReceipts();
    let recoveryBound = 0;
    const repository = {
      async bindReceiptRecoveryCapability() { recoveryBound += 1; },
      async findAccountPassword() {
        return {
          accountRef: "account-1", subjectRef: "subject-1", passwordHash: "$argon2id$stored",
          pepperVersion: 1, credentialEpoch: "1",
        };
      },
      async createIdentitySession(_transaction: unknown, input: Parameters<IdentityRepository["createIdentitySession"]>[1]) {
        return {
          siteRef: input.siteRef, subjectRef: input.subjectRef, identitySessionRef: input.sessionRef,
          state: "active" as const, identitySessionEpoch: "1", credentialEpoch: "1",
          expiresAt: input.sessionExpiresAt, updatedAt: input.authenticatedAt, retainUntil: input.retainUntil,
        };
      },
    } as unknown as IdentityRepository;
    const service = createService({
      repository,
      receipts,
      references: ["session-1", "family-1"],
    });
    const input = {
      workload: workload as never, context, commandId, idempotencyKey: "i".repeat(16),
      email: "person@example.com", password: "correct horse battery staple",
      receiptRecoveryCapability: "r".repeat(43),
    };

    const first = await service.createIdentitySession(input);
    const retry = await service.createIdentitySession(input);

    expect(first).toMatchObject({
      commandId,
      credentials: { sessionRef: "session-1", sessionCredential: "session-credential", refreshCredential: "refresh-credential" },
    });
    expect(retry).toEqual({
      kind: "delivery_unavailable", commandId, receiptRef: `command:${commandId}`,
      requestDigest: "a".repeat(64),
    });
    expect(recoveryBound).toBe(1);
  });

  it("activates the pending owner graph and full personal bootstrap without creating a session", async () => {
    let activation: Parameters<IdentityRepository["activateVerification"]>[1] | undefined;
    let sessionCreated = false;
    const repository = {
      async bindReceiptRecoveryCapability() {},
      async loadVerificationForUpdate() {
        return {
          transactionRef: "verification-1", accountRef: "account-pending", subjectRef: "subject-pending",
          emailNormalized: "person@example.com", passwordHash: "$argon2id$stored", pepperVersion: 1,
          secretDigest: "b".repeat(64), state: "pending" as const, attemptCount: 0, maxAttempts: 8,
          resendCount: 0, expiresAt: "2026-07-29T00:15:00.000Z", lastDeliveryAt: null,
        };
      },
      async activateVerification(_transaction: unknown, input: NonNullable<typeof activation>) {
        activation = input;
        return {
          siteRef: input.siteRef, subjectRef: "subject-pending", state: "active" as const,
          subjectGeneration: "1", restrictionEpoch: "1", updatedAt: input.now,
          retainUntil: "2026-07-29T00:05:00.000Z",
        };
      },
      async createIdentitySession() { sessionCreated = true; throw new Error("must not create session"); },
    } as unknown as IdentityRepository;
    const service = createService({
      repository, receipts: pendingReceipts(),
      references: [
        "workspace-1", "billing-account-1", "project-1", "execution-space-1",
        "n".repeat(32), "018f1111-1111-7111-8111-111111111111",
        "018f2222-2222-7222-8222-222222222222",
      ],
    });

    const result = await service.completeEmailVerification({
      workload: workload as never, context, commandId, idempotencyKey: "i".repeat(16),
      transactionRef: "verification-1", transactionSecret: "verification-secret",
      receiptRecoveryCapability: "r".repeat(43),
    });

    expect(result).toEqual({
      accountRef: "account-pending",
      receipt: {
        commandId, committedAt: "2026-07-29T00:00:00.000Z", receiptRef: `command:${commandId}`,
        requestDigest: "a".repeat(64), state: "committed",
      },
    });
    expect(activation).toMatchObject({
      accountRef: "account-pending", subjectRef: "subject-pending",
      workspaceRef: "workspace-1", billingAccountRef: "billing-account-1", projectRef: "project-1",
      executionSpaceRef: "execution-space-1", executionNamespace: "n".repeat(32),
      namespaceIntentRef: "018f1111-1111-7111-8111-111111111111",
      namespaceEventId: "018f2222-2222-7222-8222-222222222222",
    });
    expect(sessionCreated).toBe(false);
  });

  it("uses the prior command capability once to supersede an undelivered login", async () => {
    const priorCommandId = "2".repeat(32);
    let superseded: Parameters<IdentityRepository["consumeIdentitySessionDeliveryRecovery"]>[1] | undefined;
    const receipts = commandReceipts({
      [priorCommandId]: { state: "succeeded", result: {
        sessionRef: "prior-session", sessionExpiresAt: "2026-07-29T12:00:00.000Z",
        refreshExpiresAt: "2026-08-28T00:00:00.000Z", committedAt: "2026-07-29T00:00:00.000Z",
      } },
    });
    const repository = {
      async consumeIdentitySessionDeliveryRecovery(_transaction: unknown, input: NonNullable<typeof superseded>) {
        superseded = input;
        return {
          accountRef: "account-1", subjectRef: "subject-1",
          revoked: {
            siteRef: input.siteRef, subjectRef: "subject-1", identitySessionRef: "prior-session",
            state: "revoked" as const, identitySessionEpoch: "2", credentialEpoch: "2",
            expiresAt: "2026-07-29T12:00:00.000Z", updatedAt: input.now, retainUntil: input.retainUntil,
          },
        };
      },
      async createIdentitySession(_transaction: unknown, input: Parameters<IdentityRepository["createIdentitySession"]>[1]) {
        return {
          siteRef: input.siteRef, subjectRef: input.subjectRef, identitySessionRef: input.sessionRef,
          state: "active" as const, identitySessionEpoch: "1", credentialEpoch: "1",
          expiresAt: input.sessionExpiresAt, updatedAt: input.authenticatedAt, retainUntil: input.retainUntil,
        };
      },
    } as unknown as IdentityRepository;
    const service = createService({ repository, receipts, references: ["session-2", "family-2"] });

    const recovered = await service.createIdentitySession({
      workload: workload as never, context, commandId, idempotencyKey: "j".repeat(16),
      recoveryAction: "supersede_session_delivery", priorCommandId,
      receiptRecoveryCapability: "r".repeat(43),
    } as never);

    expect(recovered).toMatchObject({
      commandId,
      credentials: { sessionRef: "session-2", sessionCredential: "session-credential", refreshCredential: "refresh-credential" },
    });
    expect(superseded).toMatchObject({ priorCommandId, newCommandId: commandId, purpose: "createIdentitySession" });
  });
});

function createService(input: Readonly<{
  repository: IdentityRepository;
  receipts: IdentityCommandReceiptPort;
  references: string[];
  outbox?: IdentityOutboxPort;
}>) {
  const sessionPort = {
    async reserveIdentitySessionMutation() { return { siteRef: "site-1", streamSequence: 1n, aggregateSequence: 1n }; },
    async publishIdentitySessionCurrent() {},
  };
  const subjectPort = {
    async reserveSubjectMutation() { return { siteRef: "site-1", streamSequence: 1n, aggregateSequence: 1n }; },
    async publishSubjectCurrent() {},
  };
  return new IdentityApplicationService({
    unitOfWork: { async execute(_fence, work) { return work(transaction); } },
    repository: input.repository,
    receipts: input.receipts,
    outbox: (input.outbox ?? { async enqueue() {} }) as never,
    passwordHasher: {
      async hash() { return { passwordHash: "$argon2id$stored", pepperVersion: 1 }; },
      async verify(_password, stored) { return stored.passwordHash === "$argon2id$stored"; },
    },
    dummyPasswordHash: { passwordHash: "$argon2id$dummy", pepperVersion: 1 },
    verificationCredentials: {
      issue() { return { credential: "verification-secret", digest: "b".repeat(64) }; },
      digest() { return "b".repeat(64); },
    },
    sessionCredentials: {
      issue() { return { credential: "session-credential", digest: "c".repeat(64) }; }, digest() { return "c".repeat(64); },
    },
    refreshCredentials: {
      issue() { return { credential: "refresh-credential", digest: "d".repeat(64) }; }, digest() { return "d".repeat(64); },
    },
    auditDigest: () => "a".repeat(64),
    deliverySealer: {
      seal() { return { algorithm: "A256GCM", keyRevision: "key-1", nonce: "nonce", ciphertext: "sealed", authenticationTag: "tag" }; },
    },
    sessionAuthorization: new IdentitySessionAuthorizationMutation(sessionPort),
    subjectAuthorization: new SubjectAuthorizationMutation(subjectPort),
    clock: () => new Date("2026-07-29T00:00:00.000Z"),
    reference: () => {
      const value = input.references.shift();
      if (value === undefined) throw new Error("reference exhausted");
      return value;
    },
  });
}

function pendingReceipts() {
  let receipt: CommandReceipt = {
    commandId, environment: "production", region: "us-east-1", callerIdentity: "workload-1",
    operation: "", idempotencyKey: "", requestDigest: "a".repeat(64), state: "pending",
    result: null, resultDigest: null,
  };
  return {
    async begin() { return receipt; },
    async recordOutcome(_transaction: unknown, _identity: unknown, outcome: { state: CommandReceipt["state"]; result: CommandReceipt["result"]; resultDigest: string }) {
      receipt = { ...receipt, state: outcome.state, result: outcome.result, resultDigest: outcome.resultDigest };
      return receipt;
    },
  };
}

function commandReceipts(seed: Readonly<Record<string, Readonly<{ state: CommandReceipt["state"]; result: CommandReceipt["result"] }>>>) {
  const receipts = new Map<string, CommandReceipt>();
  for (const [seedCommandId, value] of Object.entries(seed)) {
    receipts.set(seedCommandId, {
      commandId: seedCommandId, environment: "production", region: "us-east-1", callerIdentity: "workload-1",
      operation: "createIdentitySession", idempotencyKey: "prior", requestDigest: "a".repeat(64),
      state: value.state, result: value.result, resultDigest: "a".repeat(64),
    });
  }
  return {
    async begin(_transaction: unknown, identity: CommandReceipt) {
      const existing = receipts.get(identity.commandId);
      if (existing !== undefined) return existing;
      const created = { ...identity, state: "pending" as const, result: null, resultDigest: null };
      receipts.set(identity.commandId, created);
      return created;
    },
    async recordOutcome(_transaction: unknown, identity: CommandReceipt, outcome: { state: CommandReceipt["state"]; result: CommandReceipt["result"]; resultDigest: string }) {
      const next = { ...identity, ...outcome };
      receipts.set(identity.commandId, next);
      return next;
    },
  };
}
