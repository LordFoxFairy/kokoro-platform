import { describe, expect, it } from "vitest";
import { issuePlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";
import type { CommandReceipt, JsonValue } from "../../src/shared/outbox-inbox/receipt.js";
import type { IdentitySecurityManagementRepository } from "../../src/modules/identity/application/contracts/identity-security-management-repository.js";
import { IdentitySecurityAtomicRejection } from "../../src/modules/identity/application/contracts/identity-security-management-repository.js";
import type { IdentityRepository } from "../../src/modules/identity/application/contracts/identity-repository.js";
import { IdentitySecurityManagementService } from "../../src/modules/identity/application/services/identity-security-management-service.js";
import { createIdentityAuditDigester } from "../../src/modules/identity/infrastructure/crypto/identity-audit-digester.js";
import type { ProductWorkloadIdentity } from "../../src/modules/authorization/domain/session-access-grant.js";

const transaction = issuePlatformTransaction({
  async query() {
    return [];
  },
  async execute() {
    return 0;
  },
}).transaction;
const workload = {
  siteRef: "site-1",
  siteReleaseRef: "release-1",
  workloadIdentityId: "workload-1",
  environment: "production",
  region: "us-east-1",
  certificateSha256: "c".repeat(64),
  siteProjectBindingRef: "binding-1",
  deploymentRef: "deployment-1",
  webArtifactDigest: "a".repeat(64),
  sessionContractRevision: "v1",
  audience: "platform-public",
  allowedOperations: ["beginTotpEnrollment", "confirmTotpEnrollment"],
  bindingEpoch: "1",
  siteSecurityEpoch: "1",
  policyEpoch: "1",
  csrfSha256: "d".repeat(64),
} as const satisfies ProductWorkloadIdentity;
const session = {
  identitySessionRef: "session-1",
  subjectRef: "subject-1",
  siteRef: "site-1",
  subjectGeneration: "3",
  identitySessionEpoch: "4",
  restrictionEpoch: "2",
  credentialEpoch: "5",
  authenticationMethods: ["password"],
  authenticatedAt: "2026-07-29T00:00:00.000Z",
  expiresAt: "2026-07-29T12:00:00.000Z",
} as const;
const context = { correlationId: "correlation-1" } as never;
const commandId = "1".repeat(32);
const auditDigest = createIdentityAuditDigester(new Uint8Array(32).fill(7));

describe("Identity security management application service", () => {
  it("delivers a TOTP seed once while retaining only its bound envelope and safe receipt state", async () => {
    let enrollment:
      | Parameters<IdentitySecurityManagementRepository["beginTotpEnrollment"]>[1]
      | undefined;
    let receiptResult: JsonValue | null = null;
    let eventPayload: JsonValue | undefined;
    const receipts = pendingReceipts((result) => {
      receiptResult = result;
    });
    const repository = {
      async loadSecurityOwnerMaterial() {
        return ownerMaterial();
      },
      async beginTotpEnrollment(_transaction: unknown, input: NonNullable<typeof enrollment>) {
        enrollment = input;
        return true;
      },
      async consumeReauthenticationProof() {
        throw new Error("proof consumption must stay inside the enrollment mutation");
      },
      async appendSecurityEvent() {},
    } as unknown as IdentitySecurityManagementRepository;
    const service = createService({
      repository,
      receipts,
      references: [
        "enrollment-transaction-1",
        "authenticator-1",
        "018f1111-1111-7111-8111-111111111111",
        "discarded-retry-transaction",
        "discarded-retry-authenticator",
      ],
      outbox: {
        async enqueue(_transaction, event) {
          eventPayload = event.payload;
        },
      },
    });

    const first = await service.beginTotpEnrollment({
      workload,
      context,
      session: session as never,
      commandId,
      idempotencyKey: "enroll-1",
      receiptRecoveryCapability: "r".repeat(43),
      reauthenticationProof: "reauth-proof",
      ceremonyAction: "begin",
    });
    const retry = await service.beginTotpEnrollment({
      workload,
      context,
      session: session as never,
      commandId,
      idempotencyKey: "enroll-1",
      receiptRecoveryCapability: "r".repeat(43),
      reauthenticationProof: "reauth-proof",
      ceremonyAction: "begin",
    });

    expect(first).toMatchObject({
      commandId,
      transaction: {
        transactionRef: "enrollment-transaction-1",
        manualEntrySecret: "JBSWY3DPEHPK3PXP",
        otpauthUri: "otpauth://totp/Acme%20AI:test",
      },
    });
    expect(retry).toMatchObject({ kind: "delivery_unavailable", commandId });
    expect(enrollment).toMatchObject({
      accountRef: "account-1",
      expectedAccountSecurityEpoch: "7",
      transactionRef: "enrollment-transaction-1",
      authenticatorRef: "authenticator-1",
      envelope: { algorithm: "A256GCM", keyRevision: "key-1", ciphertext: "sealed" },
      proof: {
        proofDigest: "e".repeat(64),
        target: { operationId: "beginTotpEnrollment", resourceKind: "identity_account" },
      },
    });
    expect(JSON.stringify(receiptResult)).not.toContain("JBSWY3DPEHPK3PXP");
    expect(JSON.stringify(receiptResult)).not.toContain("otpauth://");
    expect(JSON.stringify(eventPayload)).not.toContain("JBSWY3DPEHPK3PXP");
  });

  it("does not persist receipt recovery when the enrollment authority mutation is rejected", async () => {
    const recoveryBindings: unknown[] = [];
    const service = createService({
      repository: {
        async loadSecurityOwnerMaterial() {
          return ownerMaterial();
        },
        async beginTotpEnrollment() {
          return false;
        },
      } as unknown as IdentitySecurityManagementRepository,
      receiptRecovery: {
        async bindReceiptRecoveryCapability(_transaction, input) {
          recoveryBindings.push(input);
        },
      },
      receipts: pendingReceipts(),
      references: ["rejected-enrollment", "rejected-authenticator"],
    });

    await expect(service.beginTotpEnrollment({
      workload,
      context,
      session: session as never,
      commandId,
      idempotencyKey: "rejected-enrollment",
      receiptRecoveryCapability: "r".repeat(43),
      reauthenticationProof: "reauth-proof",
      ceremonyAction: "begin",
    })).rejects.toMatchObject({ code: "AUTH_TRANSACTION_INVALID" });

    expect(recoveryBindings).toEqual([]);
  });

  it("binds receipt recovery only after the enrollment authority mutation succeeds", async () => {
    const callOrder: string[] = [];
    const service = createService({
      repository: {
        async loadSecurityOwnerMaterial() {
          return ownerMaterial();
        },
        async beginTotpEnrollment() {
          callOrder.push("enrollment");
          return true;
        },
        async appendSecurityEvent() {},
      } as unknown as IdentitySecurityManagementRepository,
      receiptRecovery: {
        async bindReceiptRecoveryCapability() {
          callOrder.push("recovery");
        },
      },
      receipts: pendingReceipts(),
      references: [
        "accepted-enrollment",
        "accepted-authenticator",
        "018f1212-1212-7212-8212-121212121212",
      ],
    });

    await service.beginTotpEnrollment({
      workload,
      context,
      session: session as never,
      commandId,
      idempotencyKey: "accepted-enrollment",
      receiptRecoveryCapability: "r".repeat(43),
      reauthenticationProof: "reauth-proof",
      ceremonyAction: "begin",
    });

    expect(callOrder).toEqual(["enrollment", "recovery"]);
  });

  it("takes the TOTP issuer only from the exact active SiteRelease and isolates two Site brands", async () => {
    const issuedLabels: string[] = [];
    const siteA = createService({
      repository: beginRepository(ownerMaterial("Acme AI")),
      receipts: pendingReceipts(),
      references: ["enrollment-a", "authenticator-a", "018faaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa"],
      issuedLabels,
    });
    const siteB = createService({
      repository: beginRepository(ownerMaterial("Lumen Studio")),
      receipts: pendingReceipts(),
      references: ["enrollment-b", "authenticator-b", "018fbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb"],
      issuedLabels,
    });

    await siteA.beginTotpEnrollment({
      workload,
      context,
      session: session as never,
      commandId,
      idempotencyKey: "site-a",
      receiptRecoveryCapability: "r".repeat(43),
      reauthenticationProof: "reauth-proof",
      ceremonyAction: "begin",
    });
    await siteB.beginTotpEnrollment({
      workload: { ...workload, siteRef: "site-2", siteReleaseRef: "release-2" } as never,
      context,
      session: { ...session, siteRef: "site-2" } as never,
      commandId: "2".repeat(32),
      idempotencyKey: "site-b",
      receiptRecoveryCapability: "s".repeat(43),
      reauthenticationProof: "reauth-proof",
      ceremonyAction: "begin",
    });

    expect(issuedLabels).toEqual(["Acme AI", "Lumen Studio"]);
  });

  it("fails closed when the release is unknown or its identity issuer label is empty", async () => {
    const missingRelease = createService({
      repository: {
        async loadSecurityOwnerMaterial() {
          return null;
        },
      } as never,
      receipts: pendingReceipts(),
      references: [],
    });
    const emptyLabel = createService({
      repository: beginRepository(ownerMaterial("")),
      receipts: pendingReceipts(),
      references: ["unused-enrollment", "unused-authenticator"],
    });
    const input = {
      workload,
      context,
      session: session as never,
      commandId,
      idempotencyKey: "unknown-release",
      receiptRecoveryCapability: "r".repeat(43),
      reauthenticationProof: "reauth-proof",
      ceremonyAction: "begin" as const,
    };

    await expect(missingRelease.beginTotpEnrollment(input)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
    await expect(emptyLabel.beginTotpEnrollment(input)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
  });

  it("atomically confirms one TOTP timestep and returns ten recovery codes only on the fresh claim", async () => {
    let confirmation:
      | Parameters<IdentitySecurityManagementRepository["confirmTotpEnrollment"]>[1]
      | undefined;
    let receiptResult: JsonValue | null = null;
    const codes = Array.from({ length: 10 }, (_, index) => `recovery-code-${index}`);
    const repository = {
      async loadTotpEnrollmentMaterial() {
        return {
          accountRef: "account-1",
          subjectRef: "subject-1",
          sessionRef: "session-1",
          transactionRef: "enrollment-transaction-1",
          expiresAt: "2026-07-29T00:10:00.000Z",
          authenticatorRef: "authenticator-1",
          accountSecurityEpoch: "7",
          envelope: {
            algorithm: "A256GCM" as const,
            keyRevision: "key-1",
            nonce: "nonce",
            ciphertext: "sealed",
            authenticationTag: "tag",
          },
          lastAcceptedTimeStep: null,
        };
      },
      async confirmTotpEnrollment(_transaction: unknown, input: NonNullable<typeof confirmation>) {
        confirmation = input;
        return { accountRef: "account-1", accountSecurityEpoch: "8" };
      },
      async appendSecurityEvent() {},
    } as unknown as IdentitySecurityManagementRepository;
    const receipts = pendingReceipts((result) => {
      receiptResult = result;
    });
    const service = createService({
      repository,
      receipts,
      references: ["recovery-set-1", "018f2222-2222-7222-8222-222222222222"],
      recoveryCodes: codes,
      totpVerifier: {
        async verify() {
          return { valid: true as const, timeStep: 123 };
        },
      },
    });

    const result = await service.confirmTotpEnrollment({
      workload,
      context,
      session: session as never,
      commandId,
      idempotencyKey: "confirm-1",
      receiptRecoveryCapability: "r".repeat(43),
      transactionRef: "enrollment-transaction-1",
      code: "123456",
    });

    expect(result).toEqual({
      commandId,
      requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      recoveryCodes: codes,
      generatedAt: "2026-07-29T00:00:00.000Z",
    });
    expect(confirmation?.timeStep).toBe(123);
    expect(confirmation?.recoveryCodeDigests).toHaveLength(10);
    expect(new Set(confirmation?.recoveryCodeDigests.map((item) => item.codeDigest)).size).toBe(10);
    expect(JSON.stringify(receiptResult)).not.toContain("recovery-code-");
    expect(receiptResult).toMatchObject({ kind: "recovery_code_set", setRef: "recovery-set-1" });
  });

  it("passes an invalid confirmation as a failed ceremony without activating the factor", async () => {
    let timeStep: number | null | undefined;
    const repository = {
      async loadTotpEnrollmentMaterial() {
        return null;
      },
      async confirmTotpEnrollment(
        _transaction: unknown,
        input: Parameters<IdentitySecurityManagementRepository["confirmTotpEnrollment"]>[1],
      ) {
        timeStep = input.timeStep;
        return null;
      },
    } as unknown as IdentitySecurityManagementRepository;
    const service = createService({
      repository,
      receipts: pendingReceipts(),
      references: ["unused-set"],
      recoveryCodes: Array.from({ length: 10 }, (_, index) => `unused-${index}`),
    });

    await expect(
      service.confirmTotpEnrollment({
        workload,
        context,
        session: session as never,
        commandId,
        idempotencyKey: "confirm-invalid",
        receiptRecoveryCapability: "r".repeat(43),
        transactionRef: "missing-transaction",
        code: "000000",
      }),
    ).rejects.toMatchObject({ code: "AUTH_TRANSACTION_INVALID" });
    expect(timeStep).toBeNull();
  });

  it("issues a short-lived one-time proof bound to the exact sensitive target", async () => {
    let issued:
      | Parameters<IdentitySecurityManagementRepository["issueReauthenticationProof"]>[1]
      | undefined;
    let receiptResult: JsonValue | null = null;
    const repository = {
      async loadReauthenticationMaterial() {
        return ownerMaterial();
      },
      async issueReauthenticationProof(_transaction: unknown, input: NonNullable<typeof issued>) {
        issued = input;
        return true;
      },
      async appendSecurityEvent() {},
    } as unknown as IdentitySecurityManagementRepository;
    const service = createService({
      repository,
      receipts: pendingReceipts((result) => {
        receiptResult = result;
      }),
      references: ["discarded-challenge-ref", "018f3333-3333-7333-8333-333333333333"],
    });

    const result = await service.reauthenticateIdentitySession({
      workload,
      context,
      session: session as never,
      commandId,
      idempotencyKey: "reauth-1",
      receiptRecoveryCapability: "r".repeat(43),
      stage: "password",
      password: "correct horse battery staple",
      target: {
        audience: "platform-public",
        operationId: "disableTotp",
        resource: { kind: "identity_account" },
      },
    });

    expect(result).toMatchObject({
      commandId,
      proof: {
        operationId: "disableTotp",
        resourceKind: "identity_account",
        reauthenticationProof: "reauth-proof",
        sessionRef: "session-1",
        sessionEpoch: "4",
        userSecurityEpoch: "7",
      },
    });
    expect(issued).toMatchObject({
      accountRef: "account-1",
      expectedAccountSecurityEpoch: "7",
      passwordCredentialEpoch: "2",
      proofDigest: "e".repeat(64),
      target: {
        audience: "platform-public",
        operationId: "disableTotp",
        resourceKind: "identity_account",
      },
    });
    expect(Date.parse(issued?.expiresAt ?? "")).toBe(Date.parse(issued?.now ?? "") + 5 * 60_000);
    expect(JSON.stringify(receiptResult)).not.toContain("reauth-proof");
  });

  it("disables TOTP only when fresh possession and the exact proof are consumed atomically", async () => {
    let mutation: Parameters<IdentitySecurityManagementRepository["disableTotp"]>[1] | undefined;
    const material = activeTotpMaterial();
    const repository = {
      async loadActiveTotpMaterial() {
        return material;
      },
      async disableTotp(_transaction: unknown, input: NonNullable<typeof mutation>) {
        mutation = input;
        return { accountRef: "account-1", accountSecurityEpoch: "8" };
      },
      async appendSecurityEvent() {},
    } as unknown as IdentitySecurityManagementRepository;
    const service = createService({
      repository,
      receipts: pendingReceipts(),
      references: ["018f4444-4444-7444-8444-444444444444"],
      totpVerifier: {
        async verify() {
          return { valid: true as const, timeStep: 101 };
        },
      },
    });

    const result = await service.disableTotp({
      workload,
      context,
      session: session as never,
      commandId,
      idempotencyKey: "disable-1",
      code: "123456",
      reauthenticationProof: "reauth-proof",
    });

    expect(result.receipt).toMatchObject({ commandId, state: "committed" });
    expect(mutation).toMatchObject({
      binding: {
        siteProjectBindingRef: "binding-1",
        workloadIdentityId: "workload-1",
        bindingEpoch: "1",
      },
      accountRef: "account-1",
      authenticatorRef: "authenticator-1",
      timeStep: 101,
      proof: {
        proofDigest: "e".repeat(64),
        target: { operationId: "disableTotp", resourceKind: "identity_account" },
      },
    });
  });

  it("returns the same public rejection for invalid TOTP and invalid reauthentication proof", async () => {
    const invoke = async (totpValid: boolean) => {
      const repository = {
        async loadActiveTotpMaterial() {
          return activeTotpMaterial();
        },
        async disableTotp() {
          return null;
        },
        async appendSecurityEvent() {},
      } as unknown as IdentitySecurityManagementRepository;
      const service = createService({
        repository,
        receipts: pendingReceipts(),
        references: [],
        totpVerifier: {
          async verify() {
            return totpValid
              ? { valid: true as const, timeStep: 101 }
              : { valid: false as const };
          },
        },
      });
      return service.disableTotp({
        workload,
        context,
        session: session as never,
        commandId,
        idempotencyKey: totpValid ? "invalid-proof" : "invalid-totp",
        code: "123456",
        reauthenticationProof: "reauth-proof",
      });
    };

    await expect(invoke(false)).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    await expect(invoke(true)).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("maps an atomic proof conflict to the same authentication rejection", async () => {
    const repository = {
      async loadActiveTotpMaterial() {
        return activeTotpMaterial();
      },
      async disableTotp() {
        throw new IdentitySecurityAtomicRejection();
      },
      async appendSecurityEvent() {},
    } as unknown as IdentitySecurityManagementRepository;
    const service = createService({
      repository,
      receipts: pendingReceipts(),
      references: [],
      totpVerifier: {
        async verify() {
          return { valid: true as const, timeStep: 101 };
        },
      },
    });

    await expect(service.disableTotp({
      workload,
      context,
      session: session as never,
      commandId,
      idempotencyKey: "atomic-proof-conflict",
      code: "123456",
      reauthenticationProof: "reauth-proof",
    })).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("allows exactly one concurrent proof consumer to mutate TOTP state", async () => {
    let consumed = false;
    let mutations = 0;
    const repository = {
      async loadActiveTotpMaterial() {
        return activeTotpMaterial();
      },
      async disableTotp() {
        await Promise.resolve();
        if (consumed) throw new IdentitySecurityAtomicRejection();
        consumed = true;
        mutations += 1;
        return { accountRef: "account-1", accountSecurityEpoch: "8" };
      },
      async appendSecurityEvent() {},
    } as unknown as IdentitySecurityManagementRepository;
    const service = createService({
      repository,
      receipts: pendingReceipts(),
      references: ["018f4444-4444-7444-8444-444444444444"],
      totpVerifier: {
        async verify() {
          return { valid: true as const, timeStep: 101 };
        },
      },
    });
    const request = {
      workload,
      context,
      session: session as never,
      commandId,
      idempotencyKey: "concurrent-proof-consume",
      code: "123456",
      reauthenticationProof: "reauth-proof",
    };

    const outcomes = await Promise.allSettled([
      service.disableTotp(request),
      service.disableTotp(request),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: { code: "AUTHENTICATION_FAILED" } });
    expect(mutations).toBe(1);
  });

  it("delivers regenerated recovery codes once and binds the replacement to its proof", async () => {
    let mutation:
      | Parameters<IdentitySecurityManagementRepository["regenerateRecoveryCodes"]>[1]
      | undefined;
    const codes = Array.from({ length: 10 }, (_, index) => `replacement-code-${index}`);
    const repository = {
      async loadActiveTotpMaterial() {
        return {
          ...ownerMaterial(),
          authenticator: {
            authenticatorRef: "authenticator-1",
            envelope: {
              algorithm: "A256GCM" as const,
              keyRevision: "key-1",
              nonce: "nonce",
              ciphertext: "sealed",
              authenticationTag: "tag",
            },
            lastAcceptedTimeStep: 100,
          },
        };
      },
      async regenerateRecoveryCodes(_transaction: unknown, input: NonNullable<typeof mutation>) {
        mutation = input;
        return { accountRef: "account-1", accountSecurityEpoch: "8" };
      },
      async appendSecurityEvent() {},
    } as unknown as IdentitySecurityManagementRepository;
    const service = createService({
      repository,
      receipts: pendingReceipts(),
      recoveryCodes: codes,
      references: [
        "replacement-set-1",
        "018f5555-5555-7555-8555-555555555555",
        "discarded-retry-set",
      ],
    });
    const request = {
      workload,
      context,
      session: session as never,
      commandId,
      idempotencyKey: "regenerate-1",
      receiptRecoveryCapability: "r".repeat(43),
      reauthenticationProof: "reauth-proof",
      recoveryAction: "regenerate" as const,
    };

    const fresh = await service.regenerateRecoveryCodes(request);
    const retry = await service.regenerateRecoveryCodes(request);

    expect(fresh).toMatchObject({ commandId, recoveryCodes: codes });
    expect(retry).toMatchObject({ kind: "delivery_unavailable", commandId });
    expect(mutation).toMatchObject({
      setRef: "replacement-set-1",
      proof: {
        proofDigest: "e".repeat(64),
        target: { operationId: "regenerateRecoveryCodes", resourceKind: "identity_account" },
      },
    });
    expect(mutation?.recoveryCodeDigests).toHaveLength(10);
  });

  it("supersedes a lost enrollment delivery with only the caller-held recovery capability", async () => {
    let digestCalls = 0;
    let superseded = false;
    const repository = {
      async loadSecurityOwnerMaterial() {
        return ownerMaterial();
      },
      async supersedeTotpEnrollment() {
        superseded = true;
        return true;
      },
      async consumeReauthenticationProof() {
        throw new Error("supersede must not consume a new proof");
      },
      async appendSecurityEvent() {},
    } as unknown as IdentitySecurityManagementRepository;
    const service = createService({
      repository,
      receipts: pendingReceipts(),
      references: [
        "replacement-enrollment",
        "replacement-authenticator",
        "018f6666-6666-7666-8666-666666666666",
      ],
      onReauthenticationDigest() {
        digestCalls += 1;
      },
    });

    const result = await service.beginTotpEnrollment({
      workload,
      context,
      session: session as never,
      commandId,
      idempotencyKey: "supersede-enrollment",
      receiptRecoveryCapability: "r".repeat(43),
      ceremonyAction: "supersede",
      priorCommandId: "2".repeat(32),
      priorTransactionRef: "lost-enrollment",
    } as never);

    expect(result).toMatchObject({
      commandId,
      transaction: { transactionRef: "replacement-enrollment" },
    });
    expect(superseded).toBe(true);
    expect(digestCalls).toBe(0);
  });

  it("maps stale workload authority during enrollment supersede to authentication failure", async () => {
    const repository = {
      async loadSecurityOwnerMaterial() {
        return ownerMaterial();
      },
      async supersedeTotpEnrollment() {
        return false;
      },
      async appendSecurityEvent() {},
    } as unknown as IdentitySecurityManagementRepository;
    const service = createService({
      repository,
      receipts: pendingReceipts(),
      references: [
        "replacement-enrollment",
        "replacement-authenticator",
      ],
    });

    await expect(service.beginTotpEnrollment({
      workload,
      context,
      session: session as never,
      commandId,
      idempotencyKey: "stale-authority",
      receiptRecoveryCapability: "r".repeat(43),
      ceremonyAction: "supersede",
      priorCommandId: "2".repeat(32),
      priorTransactionRef: "lost-enrollment",
    })).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("maps a concurrent enrollment-supersede conflict to authentication failure", async () => {
    const repository = {
      async loadSecurityOwnerMaterial() {
        return ownerMaterial();
      },
      async supersedeTotpEnrollment() {
        throw new IdentitySecurityAtomicRejection();
      },
      async appendSecurityEvent() {},
    } as unknown as IdentitySecurityManagementRepository;
    const service = createService({
      repository,
      receipts: pendingReceipts(),
      references: ["replacement-enrollment", "replacement-authenticator"],
    });

    await expect(service.beginTotpEnrollment({
      workload,
      context,
      session: session as never,
      commandId,
      idempotencyKey: "concurrent-supersede",
      receiptRecoveryCapability: "r".repeat(43),
      ceremonyAction: "supersede",
      priorCommandId: "2".repeat(32),
      priorTransactionRef: "lost-enrollment",
    })).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("supersedes a lost recovery-code delivery with capability only and no new proof", async () => {
    let digestCalls = 0;
    let mutation:
      | Parameters<IdentitySecurityManagementRepository["supersedeRecoveryCodes"]>[1]
      | undefined;
    const repository = {
      async loadActiveTotpMaterial() {
        return {
          ...ownerMaterial(),
          authenticator: {
            authenticatorRef: "authenticator-1",
            envelope: {
              algorithm: "A256GCM" as const,
              keyRevision: "key-1",
              nonce: "nonce",
              ciphertext: "sealed",
              authenticationTag: "tag",
            },
            lastAcceptedTimeStep: 100,
          },
        };
      },
      async supersedeRecoveryCodes(_transaction: unknown, input: NonNullable<typeof mutation>) {
        mutation = input;
        return { accountRef: "account-1", accountSecurityEpoch: "8" };
      },
      async appendSecurityEvent() {},
    } as unknown as IdentitySecurityManagementRepository;
    const service = createService({
      repository,
      receipts: pendingReceipts(),
      recoveryCodes: Array.from({ length: 10 }, (_, index) => `superseded-code-${index}`),
      references: ["superseded-set", "018f7777-7777-7777-8777-777777777777"],
      onReauthenticationDigest() {
        digestCalls += 1;
      },
    });

    const result = await service.regenerateRecoveryCodes({
      workload,
      context,
      session: session as never,
      commandId,
      idempotencyKey: "supersede-recovery-codes",
      receiptRecoveryCapability: "r".repeat(43),
      recoveryAction: "supersede",
      priorCommandId: "2".repeat(32),
    } as never);

    expect(result).toMatchObject({ commandId, recoveryCodes: expect.any(Array) });
    expect(mutation).not.toHaveProperty("proof");
    expect(mutation).toMatchObject({
      binding: {
        siteProjectBindingRef: "binding-1",
        workloadIdentityId: "workload-1",
        bindingEpoch: "1",
      },
      expectedAuthStrengthPolicyRevision: "default-v1",
    });
    expect(digestCalls).toBe(0);
  });
});

function createService(
  input: Readonly<{
    repository: IdentitySecurityManagementRepository;
    receipts: ReturnType<typeof pendingReceipts>;
    references: string[];
    recoveryCodes?: readonly string[];
    totpVerifier?: Readonly<{
      verify(): Promise<Readonly<{ valid: false } | { valid: true; timeStep: number }>>;
    }>;
    outbox?: Readonly<{
      enqueue(transaction: unknown, event: { payload: JsonValue }): Promise<void>;
    }>;
    receiptRecovery?: Pick<IdentityRepository, "bindReceiptRecoveryCapability">;
    issuedLabels?: string[];
    onReauthenticationDigest?: (credential: string) => void;
  }>,
) {
  return new IdentitySecurityManagementService({
    unitOfWork: {
      async execute(_fence, work) {
        return work(transaction);
      },
    },
    repository: input.repository,
    receiptRecovery: input.receiptRecovery ?? {
      async bindReceiptRecoveryCapability() {},
    },
    receipts: input.receipts,
    outbox: (input.outbox ?? { async enqueue() {} }) as never,
    totpEnrollmentIssuer: {
      async issue(issueInput) {
        input.issuedLabels?.push(issueInput.issuer);
        return {
          secret: "JBSWY3DPEHPK3PXP",
          otpauthUri: `otpauth://totp/${encodeURIComponent(issueInput.issuer)}:test`,
        };
      },
    },
    recoveryCodeIssuer: {
      issue() {
        return input.recoveryCodes ?? [];
      },
    },
    totpSecretProtector: {
      seal() {
        return {
          algorithm: "A256GCM",
          keyRevision: "key-1",
          nonce: "nonce",
          ciphertext: "sealed",
          authenticationTag: "tag",
        };
      },
      unseal() {
        return "JBSWY3DPEHPK3PXP";
      },
    },
    totpVerifier: (input.totpVerifier as never) ?? {
      async verify() {
        return { valid: false as const };
      },
    },
    passwordHasher: {
      async hash() {
        return { passwordHash: "$argon2id$test", pepperVersion: 1 };
      },
      async verify() {
        return true;
      },
    },
    dummyPasswordHash: { passwordHash: "$argon2id$dummy", pepperVersion: 1 },
    reauthenticationCredentials: {
      issue() {
        return { credential: "reauth-proof", digest: "e".repeat(64) };
      },
      digest(credential) {
        input.onReauthenticationDigest?.(credential);
        return "e".repeat(64);
      },
    },
    dummyTotpSecret: "JBSWY3DPEHPK3PXP",
    auditDigest,
    clock: () => new Date("2026-07-29T00:00:00.000Z"),
    reference: () => {
      const value = input.references.shift();
      if (value === undefined) throw new Error("reference exhausted");
      return value;
    },
  });
}

function ownerMaterial(identityIssuerLabel = "Acme AI") {
  return {
    accountRef: "account-1",
    subjectRef: "subject-1",
    sessionRef: "session-1",
    emailNormalized: "person@example.com",
    identityIssuerLabel,
    accountSecurityEpoch: "7",
    subjectGeneration: "3",
    sessionEpoch: "4",
    credentialEpoch: "5",
    authenticatedAt: "2026-07-29T00:00:00.000Z",
    authenticationMethods: ["password"] as const,
    passwordHash: "$argon2id$stored",
    pepperVersion: 1,
    passwordCredentialEpoch: "2",
    authStrengthPolicyRevision: "default-v1",
    authenticator: null,
    recoverySetRef: null,
    recoveryCodeDigests: [],
  };
}

function activeTotpMaterial() {
  return {
    ...ownerMaterial(),
    authenticator: {
      authenticatorRef: "authenticator-1",
      envelope: {
        algorithm: "A256GCM" as const,
        keyRevision: "key-1",
        nonce: "nonce",
        ciphertext: "sealed",
        authenticationTag: "tag",
      },
      lastAcceptedTimeStep: 100,
    },
    recoverySetRef: "recovery-set-1",
  };
}

function beginRepository(
  material: ReturnType<typeof ownerMaterial>,
): IdentitySecurityManagementRepository {
  return {
    async loadSecurityOwnerMaterial() {
      return material;
    },
    async beginTotpEnrollment() {
      return true;
    },
    async consumeReauthenticationProof() {
      return true;
    },
    async appendSecurityEvent() {},
  } as unknown as IdentitySecurityManagementRepository;
}

function pendingReceipts(onResult?: (value: JsonValue | null) => void) {
  let receipt: CommandReceipt = {
    commandId,
    environment: "production",
    region: "us-east-1",
    callerIdentity: "workload-1",
    operation: "",
    idempotencyKey: "",
    requestDigest: auditDigest({}),
    state: "pending",
    result: null,
    resultDigest: null,
  };
  return {
    async begin(_transaction: unknown, identity: CommandReceipt) {
      if (receipt.operation === "") receipt = { ...receipt, ...identity };
      return receipt;
    },
    async recordOutcome(
      _transaction: unknown,
      _identity: unknown,
      outcome: Readonly<{
        state: "succeeded" | "failed" | "outcome_unknown";
        result: JsonValue | null;
        resultDigest: string;
      }>,
    ) {
      receipt = { ...receipt, ...outcome };
      onResult?.(outcome.result);
      return receipt;
    },
  };
}
