import { describe, expect, it } from "vitest";
import {
  PublicCommandReceiptService,
  type PublicCommandReceiptRecord,
} from
  "../../src/modules/identity/application/services/public-command-receipt-service.js";
import type { JsonValue } from "../../src/shared/outbox-inbox/receipt.js";
import type {
  AuthenticatedUserSession,
  ProductWorkloadIdentity,
} from "../../src/modules/authorization/domain/session-access-grant.js";

describe("Public command receipt owner", () => {
  it.each([
    ["authenticated session", session, null],
    ["recovery capability", null, RECOVERY_CAPABILITY],
    ["convergent session and capability", session, RECOVERY_CAPABILITY],
  ] as const)("returns a safe executable ceremony through %s", async (_mode, userSession, capability) => {
    const fixture = receiptService(confirmRecoveryRecord());

    const result = await fixture.service.execute({
      workload,
      context: {} as never,
      session: userSession,
      receiptRecoveryCapability: capability,
      commandId: COMMAND_ID,
    });

    expect(result).toEqual({
      receipt: {
        commandId: COMMAND_ID,
        deliveryState: "first_claim_consumed",
        observedAt: NOW,
        requestDigest: REQUEST_DIGEST,
        state: "committed",
      },
      reconciliation: {
        kind: "superseding_ceremony_required",
        ceremony: {
          bindingDigest: "b".repeat(64),
          expiresAt: RECOVERY_EXPIRES_AT,
          invalidatesPriorDelivery: true,
          operationId: "regenerateRecoveryCodes",
          transactionRef: "recovery-set-1",
        },
      },
    });
    expect(fixture.reads).toEqual([{
      commandId: COMMAND_ID,
      environment: workload.environment,
      region: workload.region,
      siteRef: workload.siteRef,
      siteReleaseRef: workload.siteReleaseRef,
      siteProjectBindingRef: workload.siteProjectBindingRef,
      workloadIdentityId: workload.workloadIdentityId,
      bindingEpoch: workload.bindingEpoch,
    }]);
    if (capability !== null) {
      expect(fixture.digests).toContainEqual({
        purpose: "regenerateRecoveryCodes",
        capability: RECOVERY_CAPABILITY,
        siteRef: workload.siteRef,
        siteReleaseRef: workload.siteReleaseRef,
        siteProjectBindingRef: workload.siteProjectBindingRef,
        workloadIdentityId: workload.workloadIdentityId,
        bindingEpoch: workload.bindingEpoch,
      });
    }
    expect(JSON.stringify(result)).not.toContain(RECOVERY_CAPABILITY);
  });

  it.each([
    ["unknown command", () => null],
    ["command id", () => ({ ...confirmRecoveryRecord(), commandId: "2".repeat(32) })],
    ["environment", () => ({ ...confirmRecoveryRecord(), environment: "staging" })],
    ["region", () => ({ ...confirmRecoveryRecord(), region: "eu-west-1" })],
    ["caller workload", () => ({ ...confirmRecoveryRecord(), callerIdentity: "other-workload" })],
    ["recovery Site", () => withRecovery({ siteRef: "other-site" })],
    ["recovery release", () => withRecovery({ siteReleaseRef: "other-release" })],
    ["recovery project binding", () => withRecovery({ siteProjectBindingRef: "other-binding" })],
    ["recovery workload", () => withRecovery({ workloadIdentityId: "other-workload" })],
    ["recovery binding epoch", () => withRecovery({ bindingEpoch: "3" })],
    ["consumed recovery capability", () => withRecovery({ state: "consumed" })],
    ["expired recovery capability", () => withRecovery({ expiresAt: NOW })],
    ["delivery Site", () => withDelivery({ siteRef: "other-site" })],
    ["owner subject", () => withSessionOwner({ subjectRef: "other-subject" })],
    ["owner subject generation", () => withSessionOwner({ subjectGeneration: "4" })],
    ["owner session", () => withSessionOwner({ sessionRef: "other-session" })],
    ["owner session epoch", () => withSessionOwner({ sessionEpoch: "5" })],
    ["owner restriction epoch", () => withSessionOwner({ restrictionEpoch: "6" })],
    ["owner credential epoch", () => withSessionOwner({ credentialEpoch: "7" })],
    ["delivery request digest", () => withDelivery({ requestDigest: "f".repeat(64) })],
    ["unrelated original operation", () => ({
      ...confirmRecoveryRecord(), operation: "disableTotp",
    })],
  ] satisfies readonly (readonly [
    string,
    () => PublicCommandReceiptRecord | null,
  ])[])("maps a mismatched %s to the same not-found result", async (_axis, record) => {
    const fixture = receiptService(record());

    await expect(fixture.service.execute({
      workload,
      context: {} as never,
      session,
      receiptRecoveryCapability: RECOVERY_CAPABILITY,
      commandId: COMMAND_ID,
    })).rejects.toThrow("PUBLIC_COMMAND_RECEIPT_NOT_FOUND");
  });

  it("maps a wrong well-formed capability to the same not-found result", async () => {
    const fixture = receiptService(confirmRecoveryRecord());

    await expect(fixture.service.execute({
      workload,
      context: {} as never,
      session: null,
      receiptRecoveryCapability: "x".repeat(43),
      commandId: COMMAND_ID,
    })).rejects.toThrow("PUBLIC_COMMAND_RECEIPT_NOT_FOUND");
  });

  it("requires at least one independently verified receipt owner", async () => {
    const fixture = receiptService(confirmRecoveryRecord());

    await expect(fixture.service.execute({
      workload,
      context: {} as never,
      session: null,
      receiptRecoveryCapability: null,
      commandId: COMMAND_ID,
    })).rejects.toThrow("PUBLIC_COMMAND_RECEIPT_NOT_FOUND");
  });

  it("rejects both credentials when a delivery-free receipt cannot prove the session owner", async () => {
    const record = confirmRecoveryRecord();
    const fixture = receiptService({
      ...record,
      operation: "createIdentitySession",
      receiptState: "pending",
      delivery: null,
      sessionOwner: null,
      recovery: {
        ...record.recovery!,
        purpose: "createIdentitySession",
        transactionRef: null,
      },
    });

    await expect(fixture.service.execute({
      workload,
      context: {} as never,
      session,
      receiptRecoveryCapability: RECOVERY_CAPABILITY,
      commandId: COMMAND_ID,
    })).rejects.toThrow("PUBLIC_COMMAND_RECEIPT_NOT_FOUND");
  });

  it("requires the release-bound recovery authority even for a session-owned terminal receipt",
    async () => {
      const record = confirmRecoveryRecord();
      const fixture = receiptService({
        ...record,
        recovery: null,
        delivery: { ...record.delivery!, state: "superseded" },
      });

      await expect(fixture.service.execute({
        workload,
        context: {} as never,
        session,
        receiptRecoveryCapability: null,
        commandId: COMMAND_ID,
      })).rejects.toThrow("PUBLIC_COMMAND_RECEIPT_NOT_FOUND");
    });

  it("rejects a capability-bound operation outside generated state-read recovery", async () => {
    const record = confirmRecoveryRecord();
    const fixture = receiptService({
      ...record,
      operation: "disableTotp",
      delivery: null,
      sessionOwner: null,
      recovery: { ...record.recovery!, purpose: "disableTotp" },
    });

    await expect(fixture.service.execute({
      workload,
      context: {} as never,
      session: null,
      receiptRecoveryCapability: RECOVERY_CAPABILITY,
      commandId: COMMAND_ID,
    })).rejects.toThrow("PUBLIC_COMMAND_RECEIPT_NOT_FOUND");
  });

  it("returns the production email-verification terminal receipt through its capability", async () => {
    const record = confirmRecoveryRecord();
    const fixture = receiptService({
      ...record,
      operation: "completeEmailVerification",
      delivery: null,
      sessionOwner: null,
      recovery: { ...record.recovery!, purpose: "completeEmailVerification" },
    });

    await expect(fixture.service.execute({
      workload,
      context: {} as never,
      session: null,
      receiptRecoveryCapability: RECOVERY_CAPABILITY,
      commandId: COMMAND_ID,
    })).resolves.toEqual({
      receipt: {
        commandId: COMMAND_ID,
        deliveryState: "not_applicable",
        observedAt: NOW,
        requestDigest: REQUEST_DIGEST,
        state: "committed",
      },
      reconciliation: { kind: "terminal", outcome: "committed" },
    });
  });

  it.each([
    ["Site", { siteRef: "other-site" }],
    ["release", { siteReleaseRef: "other-release" }],
    ["project binding", { siteProjectBindingRef: "other-binding" }],
    ["workload", { workloadIdentityId: "other-workload" }],
    ["binding epoch", { bindingEpoch: "3" }],
    ["request digest", { requestDigest: "f".repeat(64) }],
  ] as const)("rejects a capability lookup whose delivery %s disagrees with its receipt authority",
    async (_axis, mutation) => {
      const fixture = receiptService(withDelivery(mutation));

      await expect(fixture.service.execute({
        workload,
        context: {} as never,
        session: null,
        receiptRecoveryCapability: RECOVERY_CAPABILITY,
        commandId: COMMAND_ID,
      })).rejects.toThrow("PUBLIC_COMMAND_RECEIPT_NOT_FOUND");
    });

  it.each([
    ["pending", "accepted", { kind: "pending", retryAfterSeconds: 2 }],
    ["outcome_unknown", "outcome_unknown", { kind: "pending", retryAfterSeconds: 2 }],
    ["succeeded", "committed", { kind: "terminal", outcome: "committed" }],
    ["failed", "rejected", { kind: "terminal", outcome: "rejected" }],
  ] as const)("maps the durable %s state without replaying its stored result",
    async (receiptState, publicState, reconciliation) => {
      const record = confirmRecoveryRecord();
      const fixture = receiptService({
        ...record,
        operation: "createIdentitySession",
        receiptState,
        delivery: null,
        recovery: {
          ...record.recovery!,
          purpose: "createIdentitySession",
          transactionRef: null,
        },
      });

      const result = await fixture.service.execute({
        workload,
        context: {} as never,
        session: null,
        receiptRecoveryCapability: RECOVERY_CAPABILITY,
        commandId: COMMAND_ID,
      });

      expect(result).toEqual({
        receipt: {
          commandId: COMMAND_ID,
          deliveryState: "not_applicable",
          observedAt: NOW,
          requestDigest: REQUEST_DIGEST,
          state: publicState,
        },
        reconciliation,
      });
    });
});

const COMMAND_ID = "1".repeat(32);
const REQUEST_DIGEST = "a".repeat(64);
const RECOVERY_CAPABILITY = "r".repeat(43);
const NOW = "2026-08-11T00:00:00.000Z";
const RECOVERY_EXPIRES_AT = "2026-08-12T00:00:00.000Z";

const workload: ProductWorkloadIdentity = Object.freeze({
  certificateSha256: "c".repeat(64),
  workloadIdentityId: "workload-1",
  siteProjectBindingRef: "binding-1",
  deploymentRef: "deployment-1",
  siteRef: "site-1",
  siteReleaseRef: "release-1",
  webArtifactDigest: "d".repeat(64),
  sessionContractRevision: "session-browser-v3",
  environment: "production",
  region: "us-east-1",
  audience: "site-product",
  allowedOperations: Object.freeze(["getPublicCommandReceipt"]),
  bindingEpoch: "2",
  siteSecurityEpoch: "1",
  policyEpoch: "2",
  csrfSha256: "e".repeat(64),
});

const session: AuthenticatedUserSession = Object.freeze({
  identitySessionRef: "session-1",
  subjectRef: "subject-1",
  siteRef: "site-1",
  subjectGeneration: "3",
  identitySessionEpoch: "4",
  restrictionEpoch: "5",
  credentialEpoch: "6",
  authenticationMethods: Object.freeze(["password"] as const),
  authenticatedAt: NOW,
  expiresAt: RECOVERY_EXPIRES_AT,
});

function confirmRecoveryRecord(): PublicCommandReceiptRecord {
  return {
    commandId: COMMAND_ID,
    environment: workload.environment,
    region: workload.region,
    callerIdentity: workload.workloadIdentityId,
    operation: "confirmTotpEnrollment",
    requestDigest: REQUEST_DIGEST,
    receiptState: "succeeded",
    recovery: {
      siteRef: workload.siteRef,
      siteReleaseRef: workload.siteReleaseRef,
      siteProjectBindingRef: workload.siteProjectBindingRef,
      workloadIdentityId: workload.workloadIdentityId,
      bindingEpoch: workload.bindingEpoch,
      purpose: "regenerateRecoveryCodes",
      transactionRef: "recovery-set-1",
      capabilityDigest: "c".repeat(64),
      state: "active",
      expiresAt: RECOVERY_EXPIRES_AT,
    },
    delivery: {
      state: "first_claim_consumed",
      siteRef: workload.siteRef,
      siteReleaseRef: workload.siteReleaseRef,
      siteProjectBindingRef: workload.siteProjectBindingRef,
      workloadIdentityId: workload.workloadIdentityId,
      bindingEpoch: workload.bindingEpoch,
      subjectRef: session.subjectRef,
      subjectGeneration: session.subjectGeneration,
      sessionRef: session.identitySessionRef,
      sessionEpoch: session.identitySessionEpoch,
      credentialEpoch: session.credentialEpoch,
      requestDigest: REQUEST_DIGEST,
    },
    sessionOwner: {
      siteRef: workload.siteRef,
      siteReleaseRef: workload.siteReleaseRef,
      siteProjectBindingRef: workload.siteProjectBindingRef,
      workloadIdentityId: workload.workloadIdentityId,
      bindingEpoch: workload.bindingEpoch,
      subjectRef: session.subjectRef,
      subjectGeneration: session.subjectGeneration,
      sessionRef: session.identitySessionRef,
      sessionEpoch: session.identitySessionEpoch,
      restrictionEpoch: session.restrictionEpoch,
      credentialEpoch: session.credentialEpoch,
    },
  };
}

function withRecovery(
  mutation: Partial<NonNullable<PublicCommandReceiptRecord["recovery"]>>,
): PublicCommandReceiptRecord {
  const record = confirmRecoveryRecord();
  return { ...record, recovery: { ...record.recovery!, ...mutation } };
}

function withDelivery(
  mutation: Partial<NonNullable<PublicCommandReceiptRecord["delivery"]>>,
): PublicCommandReceiptRecord {
  const record = confirmRecoveryRecord();
  return { ...record, delivery: { ...record.delivery!, ...mutation } };
}

function withSessionOwner(
  mutation: Partial<NonNullable<PublicCommandReceiptRecord["sessionOwner"]>>,
): PublicCommandReceiptRecord {
  const record = confirmRecoveryRecord();
  return { ...record, sessionOwner: { ...record.sessionOwner!, ...mutation } };
}

function receiptService(record: PublicCommandReceiptRecord | null) {
  const reads: unknown[] = [];
  const digests: JsonValue[] = [];
  const auditDigest = (value: JsonValue) => {
    digests.push(value);
    if (value !== null && typeof value === "object" && !Array.isArray(value) &&
        Object.hasOwn(value, "capability")) {
      return value.capability === RECOVERY_CAPABILITY ? "c".repeat(64) : "f".repeat(64);
    }
    return "b".repeat(64);
  };
  return {
    reads,
    digests,
    service: new PublicCommandReceiptService({
      unitOfWork: {
        async execute(_fence, work) {
          return work({} as never);
        },
      },
      repository: {
        async find(_transaction, input) {
          reads.push(input);
          return record;
        },
      },
      auditDigest,
      clock: () => new Date(NOW),
    }),
  };
}
