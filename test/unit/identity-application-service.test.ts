import { describe, expect, it } from "vitest";
import { issuePlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";
import {
  IdentityApplicationService,
  type IdentityCommandReceiptPort,
  type IdentityOutboxPort,
} from "../../src/modules/identity/application/services/identity-application-service.js";
import { IdentitySessionAuthorizationMutation } from "../../src/modules/identity/application/services/identity-session-authorization-mutation.js";
import { PersonalBootstrapAuthorizationMutation } from "../../src/modules/identity/application/services/personal-bootstrap-authorization-mutation.js";
import type { IdentityRepository } from "../../src/modules/identity/application/contracts/identity-repository.js";
import type { CommandReceipt } from "../../src/shared/outbox-inbox/receipt.js";
import type {
  IdentityAuditDigesterPort,
  IdentityTotpVerifierPort,
} from "../../src/modules/identity/application/contracts/identity-security-ports.js";

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
    let delivery: Parameters<IdentityRepository["recordVerificationDelivery"]>[1] | undefined;
    let outboxPayload: unknown;
    const repository = {
      async createVerification(_transaction: unknown, input: NonNullable<typeof created>) { created = input; return "created" as const; },
      async recordVerificationDelivery(_transaction: unknown, input: NonNullable<typeof delivery>) {
        delivery = input;
      },
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
    expect(delivery?.credentialRevision).toBe(0);
    expect(outboxPayload).toMatchObject({ credentialRevision: 0 });
    const serialized = JSON.stringify(outboxPayload);
    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain("correct horse battery staple");
    expect(serialized).not.toContain("verification-secret");
  });

  it("fences resend delivery to the rotated credential revision", async () => {
    let rotation: Parameters<IdentityRepository["rotateVerificationSecret"]>[1] | undefined;
    let delivery: Parameters<IdentityRepository["recordVerificationDelivery"]>[1] | undefined;
    let outboxPayload: unknown;
    const repository = {
      async findPendingVerificationByEmail() {
        return {
          transactionRef: "verification-1", accountRef: "account-1", subjectRef: "subject-1",
          emailNormalized: "person@example.com", passwordHash: "$argon2id$stored", pepperVersion: 1,
          secretDigest: "b".repeat(64), state: "pending" as const, attemptCount: 0, maxAttempts: 8,
          resendCount: 2, expiresAt: "2026-07-28T23:00:00.000Z",
          lastDeliveryAt: "2026-07-28T23:00:00.000Z",
        };
      },
      async rotateVerificationSecret(_transaction: unknown, input: NonNullable<typeof rotation>) {
        rotation = input;
      },
      async recordVerificationDelivery(_transaction: unknown, input: NonNullable<typeof delivery>) {
        delivery = input;
      },
    } as unknown as IdentityRepository;
    const service = createService({
      repository,
      receipts: pendingReceipts(),
      references: ["018f1111-1111-7111-8111-111111111111", "delivery-3"],
      outbox: { async enqueue(_transaction, event) { outboxPayload = event.payload; } },
    });

    await service.resendEmailVerification({
      workload: workload as never, context, commandId, idempotencyKey: "r".repeat(16),
      email: "person@example.com",
    });

    expect(rotation?.expectedResendCount).toBe(2);
    expect(delivery?.credentialRevision).toBe(3);
    expect(outboxPayload).toMatchObject({ credentialRevision: 3 });
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
      async beginIdentityAuthentication() { return { kind: "password_only" as const }; },
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
      references: ["auth-1", "session-1", "family-1"],
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

  it("returns a replayable pre-auth receipt without creating a session when MFA is active", async () => {
    const receipts = pendingReceipts();
    let challengeCount = 0;
    let sessionCreated = false;
    const repository = {
      async bindReceiptRecoveryCapability() {},
      async findAccountPassword() {
        return {
          accountRef: "account-1", subjectRef: "subject-1", passwordHash: "$argon2id$stored",
          pepperVersion: 1, credentialEpoch: "7",
        };
      },
      async beginIdentityAuthentication() {
        challengeCount += 1;
        return {
          kind: "pending" as const, transactionRef: "mfa-transaction-1",
          challengeKind: "totp" as const, expiresAt: "2026-07-29T00:05:00.000Z",
        };
      },
      async createIdentitySession() { sessionCreated = true; throw new Error("must not create session"); },
    } as unknown as IdentityRepository;
    const service = createService({ repository, receipts, references: ["mfa-transaction-1"] });
    const input = {
      workload: workload as never, context, commandId, idempotencyKey: "mfa-login-key-01",
      email: "person@example.com", password: "correct horse battery staple",
      receiptRecoveryCapability: "r".repeat(43),
    };

    const first = await service.createIdentitySession(input);
    const retry = await service.createIdentitySession(input);

    expect(first).toEqual(retry);
    expect(first).toMatchObject({
      pending: { transactionRef: "mfa-transaction-1", challengeKind: "totp" },
      receipt: { state: "committed" },
    });
    expect(challengeCount).toBe(1);
    expect(sessionCreated).toBe(false);
  });

  it("records a wrong password only after the known account and credential epoch are rechecked", async () => {
    let failures = 0;
    let began = false;
    const repository = {
      async bindReceiptRecoveryCapability() {},
      async findAccountPassword() {
        return {
          accountRef: "account-1", subjectRef: "subject-1", passwordHash: "$argon2id$stored",
          pepperVersion: 1, credentialEpoch: "7",
        };
      },
      async recordIdentityPasswordFailure() { failures += 1; },
      async beginIdentityAuthentication() { began = true; return { kind: "password_only" as const }; },
    } as unknown as IdentityRepository;
    const service = createService({
      repository, receipts: pendingReceipts(), references: [], passwordValid: false,
    });

    await expect(service.createIdentitySession({
      workload: workload as never, context, commandId, idempotencyKey: "wrong-password-key",
      email: "person@example.com", password: "incorrect password value",
      receiptRecoveryCapability: "r".repeat(43),
    })).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect(failures).toBe(1);
    expect(began).toBe(false);
  });

  it("rejects a correct password while the account authentication budget is locked", async () => {
    let sessionCreated = false;
    const repository = {
      async bindReceiptRecoveryCapability() {},
      async findAccountPassword() {
        return {
          accountRef: "account-1", subjectRef: "subject-1", passwordHash: "$argon2id$stored",
          pepperVersion: 1, credentialEpoch: "7",
        };
      },
      async beginIdentityAuthentication() { return { kind: "locked" as const }; },
      async createIdentitySession() { sessionCreated = true; throw new Error("must not create session"); },
    } as unknown as IdentityRepository;
    const service = createService({ repository, receipts: pendingReceipts(), references: ["auth-locked"] });

    await expect(service.createIdentitySession({
      workload: workload as never, context, commandId, idempotencyKey: "locked-password-key",
      email: "person@example.com", password: "correct horse battery staple",
      receiptRecoveryCapability: "r".repeat(43),
    })).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect(sessionCreated).toBe(false);
  });

  it("consumes a valid TOTP challenge before issuing a password plus TOTP session", async () => {
    let proof: Parameters<IdentityRepository["consumeIdentityAuthentication"]>[1]["proof"] | undefined;
    let methods: readonly string[] | undefined;
    const repository = {
      async bindReceiptRecoveryCapability() {},
      async loadIdentityAuthenticationMaterial() {
        return {
          accountRef: "account-1", subjectRef: "subject-1", transactionRef: "mfa-transaction-1",
          challengeKind: "totp" as const, expiresAt: "2026-07-29T00:05:00.000Z",
          recoverySetRef: null,
          authenticator: {
            authenticatorRef: "totp-1", lastAcceptedTimeStep: 10,
            envelope: { algorithm: "A256GCM" as const, keyRevision: "key-1", nonce: "nonce", ciphertext: "sealed", authenticationTag: "tag" },
          },
          recoveryCodeDigests: [],
        };
      },
      async consumeIdentityAuthentication(_transaction: unknown, input: Parameters<IdentityRepository["consumeIdentityAuthentication"]>[1]) {
        proof = input.proof;
        return { kind: "accepted" as const, accountRef: "account-1", subjectRef: "subject-1", authenticationMethod: "totp" as const };
      },
      async createIdentitySession(_transaction: unknown, input: Parameters<IdentityRepository["createIdentitySession"]>[1]) {
        methods = input.authenticationMethods;
        return {
          siteRef: input.siteRef, subjectRef: input.subjectRef, identitySessionRef: input.sessionRef,
          state: "active" as const, identitySessionEpoch: "1", credentialEpoch: "1",
          expiresAt: input.sessionExpiresAt, updatedAt: input.authenticatedAt, retainUntil: input.retainUntil,
        };
      },
    } as unknown as IdentityRepository;
    const service = createService({
      repository, receipts: pendingReceipts(), references: ["session-mfa-1", "family-mfa-1"],
      totpVerifier: { async verify() { return { valid: true, timeStep: 11 }; } },
    });

    const result = await service.completeSessionMfa({
      workload: workload as never, context, commandId, idempotencyKey: "mfa-complete-key",
      transactionRef: "mfa-transaction-1", code: "123456",
      receiptRecoveryCapability: "r".repeat(43),
    });

    expect(proof).toEqual({ kind: "totp", timeStep: 11 });
    expect(methods).toEqual(["password", "totp"]);
    expect(result).toMatchObject({ credentials: { sessionRef: "session-mfa-1" } });
  });

  it("matches a recovery code in constant-shape input and marks the session method exactly", async () => {
    let proof: Parameters<IdentityRepository["consumeIdentityAuthentication"]>[1]["proof"] | undefined;
    let methods: readonly string[] | undefined;
    let recoveryDigestInput: Parameters<IdentityAuditDigesterPort>[0] | undefined;
    const repository = {
      async bindReceiptRecoveryCapability() {},
      async loadIdentityAuthenticationMaterial() {
        return {
          accountRef: "account-1", subjectRef: "subject-1", transactionRef: "mfa-transaction-1",
          challengeKind: "totp" as const, expiresAt: "2026-07-29T00:05:00.000Z",
          recoverySetRef: "recovery-set-1", authenticator: null, recoveryCodeDigests: ["a".repeat(64)],
        };
      },
      async consumeIdentityAuthentication(_transaction: unknown, input: Parameters<IdentityRepository["consumeIdentityAuthentication"]>[1]) {
        proof = input.proof;
        return { kind: "accepted" as const, accountRef: "account-1", subjectRef: "subject-1", authenticationMethod: "recovery_code" as const };
      },
      async createIdentitySession(_transaction: unknown, input: Parameters<IdentityRepository["createIdentitySession"]>[1]) {
        methods = input.authenticationMethods;
        return {
          siteRef: input.siteRef, subjectRef: input.subjectRef, identitySessionRef: input.sessionRef,
          state: "active" as const, identitySessionEpoch: "1", credentialEpoch: "1",
          expiresAt: input.sessionExpiresAt, updatedAt: input.authenticatedAt, retainUntil: input.retainUntil,
        };
      },
    } as unknown as IdentityRepository;
    const service = createService({
      repository, receipts: pendingReceipts(), references: ["session-recovery-1", "family-recovery-1"],
      auditDigest(value) {
        if (typeof value === "object" && value !== null && !Array.isArray(value) &&
            value.purpose === "identity_recovery_code") recoveryDigestInput = value;
        return "a".repeat(64);
      },
    });

    await service.completeSessionMfa({
      workload: workload as never, context, commandId, idempotencyKey: "recovery-code-key",
      transactionRef: "mfa-transaction-1", code: "recovery-code-value",
      receiptRecoveryCapability: "r".repeat(43),
    });

    expect(proof).toEqual({ kind: "recovery_code", codeDigest: "a".repeat(64) });
    expect(recoveryDigestInput).toEqual({
      purpose: "identity_recovery_code", siteRef: "site-1", accountRef: "account-1",
      recoverySetRef: "recovery-set-1", code: "recovery-code-value",
    });
    expect(methods).toEqual(["password", "recovery_code"]);
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
          subject: {
            siteRef: input.siteRef, subjectRef: "subject-pending", state: "active" as const,
            subjectGeneration: "1", restrictionEpoch: "1", updatedAt: input.now,
            retainUntil: "2026-07-29T00:05:00.000Z",
          },
          membership: {
            siteRef: input.siteRef, subjectRef: "subject-pending", projectRef: input.projectRef,
            state: "active" as const, membershipEpoch: "1", authorizationEpoch: "1",
            updatedAt: input.now, retainUntil: "2026-07-29T00:05:00.000Z",
          },
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
          authenticationMethods: ["password"] as const,
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

  it("rotates a refresh credential and publishes the exact session epoch", async () => {
    let rotation: Parameters<IdentityRepository["rotateIdentityRefreshCredential"]>[1] | undefined;
    const repository = {
      async bindReceiptRecoveryCapability() {},
      async loadIdentityRefreshCredential() {
        return {
          accountRef: "account-1", subjectRef: "subject-1", sessionRef: "session-1", familyRef: "family-1",
          generation: 1, currentGeneration: 1, credentialState: "active" as const,
          familyState: "active" as const, sessionState: "active" as const,
          credentialExpiresAt: "2026-08-28T00:00:00.000Z",
          absoluteExpiresAt: "2026-08-28T00:00:00.000Z",
        };
      },
      async rotateIdentityRefreshCredential(_transaction: unknown, input: NonNullable<typeof rotation>) {
        rotation = input;
        return {
          siteRef: input.siteRef, subjectRef: input.subjectRef, identitySessionRef: input.sessionRef,
          state: "active" as const, identitySessionEpoch: "1", credentialEpoch: "2",
          expiresAt: input.sessionExpiresAt, updatedAt: input.now, retainUntil: input.retainUntil,
        };
      },
    } as unknown as IdentityRepository;
    const service = createService({ repository, receipts: pendingReceipts(), references: [] });

    const result = await service.refreshIdentitySession({
      workload: workload as never, context, commandId, idempotencyKey: "k".repeat(16),
      opaqueCredential: "r".repeat(43), receiptRecoveryCapability: "c".repeat(43),
    });

    expect(result).toMatchObject({
      commandId,
      credentials: { sessionRef: "session-1", sessionCredential: "session-credential", refreshCredential: "refresh-credential" },
    });
    expect(rotation).toMatchObject({ expectedGeneration: 1, newGeneration: 2, sessionRef: "session-1" });
  });

  it("revokes the whole refresh family when an old generation is replayed", async () => {
    let revoked = false;
    const repository = {
      async bindReceiptRecoveryCapability() {},
      async loadIdentityRefreshCredential() {
        return {
          accountRef: "account-1", subjectRef: "subject-1", sessionRef: "session-1", familyRef: "family-1",
          generation: 1, currentGeneration: 2, credentialState: "consumed" as const,
          familyState: "active" as const, sessionState: "active" as const,
          credentialExpiresAt: "2026-08-28T00:00:00.000Z",
          absoluteExpiresAt: "2026-08-28T00:00:00.000Z",
        };
      },
      async revokeIdentityRefreshFamilyForReplay() {
        revoked = true;
        return {
          siteRef: "site-1", subjectRef: "subject-1", identitySessionRef: "session-1",
          state: "revoked" as const, identitySessionEpoch: "2", credentialEpoch: "3",
          expiresAt: "2026-07-29T12:00:00.000Z", updatedAt: "2026-07-29T00:00:00.000Z",
          retainUntil: "2026-07-29T12:05:00.000Z",
        };
      },
    } as unknown as IdentityRepository;
    const service = createService({ repository, receipts: pendingReceipts(), references: [] });

    await expect(service.refreshIdentitySession({
      workload: workload as never, context, commandId, idempotencyKey: "l".repeat(16),
      opaqueCredential: "r".repeat(43), receiptRecoveryCapability: "c".repeat(43),
    })).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect(revoked).toBe(true);
  });

  it("rejects an expired refresh credential before attempting rotation", async () => {
    let rotated = false;
    const repository = {
      async bindReceiptRecoveryCapability() {},
      async loadIdentityRefreshCredential() {
        return {
          accountRef: "account-1", subjectRef: "subject-1", sessionRef: "session-1", familyRef: "family-1",
          generation: 1, currentGeneration: 1, credentialState: "active" as const,
          familyState: "active" as const, sessionState: "active" as const,
          credentialExpiresAt: "2026-07-28T23:59:59.000Z",
          absoluteExpiresAt: "2026-08-28T00:00:00.000Z",
        };
      },
      async rotateIdentityRefreshCredential() { rotated = true; throw new Error("unexpected rotation"); },
    } as unknown as IdentityRepository;
    const service = createService({ repository, receipts: pendingReceipts(), references: [] });

    await expect(service.refreshIdentitySession({
      workload: workload as never, context, commandId, idempotencyKey: "n".repeat(16),
      opaqueCredential: "r".repeat(43), receiptRecoveryCapability: "c".repeat(43),
    })).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect(rotated).toBe(false);
  });

  it("transfers refresh delivery recovery to the superseding command", async () => {
    const priorCommandId = "3".repeat(32);
    let recovery: Parameters<IdentityRepository["supersedeIdentityRefreshDelivery"]>[1] | undefined;
    const repository = {
      async supersedeIdentityRefreshDelivery(_transaction: unknown, input: NonNullable<typeof recovery>) {
        recovery = input;
        return {
          sessionRef: "session-1", refreshExpiresAt: "2026-08-28T00:00:00.000Z",
          current: {
            siteRef: input.siteRef, subjectRef: "subject-1", identitySessionRef: "session-1",
            state: "active" as const, identitySessionEpoch: "1", credentialEpoch: "3",
            expiresAt: input.sessionExpiresAt, updatedAt: input.now, retainUntil: input.retainUntil,
          },
        };
      },
    } as unknown as IdentityRepository;
    const service = createService({ repository, receipts: pendingReceipts(), references: [] });

    const result = await service.refreshIdentitySession({
      workload: workload as never, context, commandId, idempotencyKey: "m".repeat(16),
      recoveryAction: "supersede_refresh_delivery", priorCommandId,
      receiptRecoveryCapability: "c".repeat(43),
    });

    expect(result).toMatchObject({ credentials: { sessionRef: "session-1" } });
    expect(recovery).toMatchObject({ priorCommandId, newCommandId: commandId, purpose: "refreshIdentitySession" });
  });
});

function createService(input: Readonly<{
  repository: IdentityRepository;
  receipts: IdentityCommandReceiptPort;
  references: string[];
  outbox?: IdentityOutboxPort;
  totpVerifier?: IdentityTotpVerifierPort;
  auditDigest?: IdentityAuditDigesterPort;
  passwordValid?: boolean;
}>) {
  const sessionPort = {
    async reserveIdentitySessionMutation() { return { siteRef: "site-1", streamSequence: 1n, aggregateSequence: 1n }; },
    async publishIdentitySessionCurrent() {},
  };
  const personalBootstrapPort = {
    async reserveOwnerMutations() { return [
      { siteRef: "site-1", streamSequence: 1n, aggregateSequence: 1n },
      { siteRef: "site-1", streamSequence: 2n, aggregateSequence: 2n },
    ]; },
    async publishSubjectCurrent() {},
    async publishProjectMembershipCurrent() {},
  };
  return new IdentityApplicationService({
    unitOfWork: { async execute(_fence, work) { return work(transaction); } },
    repository: input.repository,
    receipts: input.receipts,
    outbox: (input.outbox ?? { async enqueue() {} }) as never,
    passwordHasher: {
      async hash() { return { passwordHash: "$argon2id$stored", pepperVersion: 1 }; },
      async verify(_password, stored) {
        return input.passwordValid ?? stored.passwordHash === "$argon2id$stored";
      },
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
    auditDigest: input.auditDigest ?? (() => "a".repeat(64)),
    totpSecretProtector: {
      seal() { return { algorithm: "A256GCM", keyRevision: "key-1", nonce: "nonce", ciphertext: "sealed", authenticationTag: "tag" }; },
      unseal() { return "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"; },
    },
    totpVerifier: input.totpVerifier ?? { async verify() { return { valid: false }; } },
    dummyTotpSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
    deliverySealer: {
      seal() { return { algorithm: "A256GCM", keyRevision: "key-1", nonce: "nonce", ciphertext: "sealed", authenticationTag: "tag" }; },
    },
    sessionAuthorization: new IdentitySessionAuthorizationMutation(sessionPort),
    personalBootstrapAuthorization: new PersonalBootstrapAuthorizationMutation(personalBootstrapPort),
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
