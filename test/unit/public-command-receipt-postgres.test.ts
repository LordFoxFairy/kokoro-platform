import { describe, expect, it } from "vitest";
import { PostgresPublicCommandReceiptRepository } from
  "../../src/modules/identity/infrastructure/postgres/public-command-receipt-repository.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";

describe("Postgres public command receipt reader", () => {
  it("reads only the exact workload-bound receipt, recovery, delivery, and session owner facts",
    async () => {
      let statement = "";
      let values: readonly unknown[] = [];
      const lease = issuePlatformTransaction({
        async query(sql, parameters = []) {
          statement = sql;
          values = parameters;
          return [row()] as never;
        },
        async execute() {
          throw new Error("receipt lookup must remain read-only");
        },
      });
      try {
        const result = await new PostgresPublicCommandReceiptRepository().find(
          lease.transaction,
          input(),
        );

        expect(result).toEqual({
          commandId: "1".repeat(32),
          environment: "production",
          region: "us-east-1",
          callerIdentity: "workload-1",
          operation: "confirmTotpEnrollment",
          requestDigest: "a".repeat(64),
          receiptState: "succeeded",
          recovery: {
            siteRef: "site-1",
            siteReleaseRef: "release-1",
            siteProjectBindingRef: "binding-1",
            workloadIdentityId: "workload-1",
            bindingEpoch: "2",
            purpose: "regenerateRecoveryCodes",
            transactionRef: "recovery-set-1",
            capabilityDigest: "b".repeat(64),
            state: "active",
            expiresAt: "2026-08-12T00:00:00.000Z",
          },
          delivery: {
            state: "first_claim_consumed",
            siteRef: "site-1",
            siteReleaseRef: "release-1",
            siteProjectBindingRef: "binding-1",
            workloadIdentityId: "workload-1",
            bindingEpoch: "2",
            subjectRef: "subject-1",
            subjectGeneration: "3",
            sessionRef: "session-1",
            sessionEpoch: "4",
            credentialEpoch: "6",
            requestDigest: "a".repeat(64),
          },
          sessionOwner: {
            siteRef: "site-1",
            siteReleaseRef: "release-1",
            siteProjectBindingRef: "binding-1",
            workloadIdentityId: "workload-1",
            bindingEpoch: "2",
            subjectRef: "subject-1",
            subjectGeneration: "3",
            sessionRef: "session-1",
            sessionEpoch: "4",
            restrictionEpoch: "5",
            credentialEpoch: "6",
          },
        });
        expect(values).toEqual([
          "1".repeat(32),
          "production",
          "us-east-1",
          "workload-1",
        ]);
        for (const ownerTable of [
          "platform.identity_session_delivery_claim",
          "platform.identity_totp_enrollment_delivery_claim",
          "platform.identity_reauthentication_delivery_claim",
          "platform.identity_recovery_code_delivery_claim",
          "platform.identity_receipt_recovery_capability",
        ]) expect(statement).toContain(ownerTable);
        expect(statement).toContain("receipt.caller_identity=$4");
        expect(statement).not.toContain("recovery.site_ref=$5");
        expect(statement).not.toContain("delivery.site_ref=$5");
        expect(statement).not.toContain("receipt.result AS");
        expect(statement).not.toContain("FOR UPDATE");
      } finally {
        revokePlatformTransaction(lease);
      }
    });

  it("fails closed when more than one delivery owner row exists", async () => {
    const lease = issuePlatformTransaction({
      async query() { return [row(), row()] as never; },
      async execute() { return 0; },
    });
    try {
      await expect(new PostgresPublicCommandReceiptRepository().find(
        lease.transaction,
        input(),
      )).resolves.toBeNull();
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects a partial recovery authority row instead of treating it as absent", async () => {
    const lease = issuePlatformTransaction({
      async query() {
        return [{ ...row(), recoveryPurpose: null }] as never;
      },
      async execute() { return 0; },
    });
    try {
      await expect(new PostgresPublicCommandReceiptRepository().find(
        lease.transaction,
        input(),
      )).rejects.toThrow("PUBLIC_COMMAND_RECEIPT_ROW_INVALID");
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});

function input() {
  return {
    commandId: "1".repeat(32),
    environment: "production",
    region: "us-east-1",
    siteRef: "site-1",
    siteReleaseRef: "release-1",
    siteProjectBindingRef: "binding-1",
    workloadIdentityId: "workload-1",
    bindingEpoch: "2",
  };
}

function row() {
  return {
    commandId: "1".repeat(32),
    environment: "production",
    region: "us-east-1",
    callerIdentity: "workload-1",
    operation: "confirmTotpEnrollment",
    requestDigest: "a".repeat(64),
    receiptState: "succeeded",
    recoverySiteRef: "site-1",
    recoverySiteReleaseRef: "release-1",
    recoverySiteProjectBindingRef: "binding-1",
    recoveryWorkloadIdentityId: "workload-1",
    recoveryBindingEpoch: 2n,
    recoveryPurpose: "regenerateRecoveryCodes",
    recoveryTransactionRef: "recovery-set-1",
    recoveryCapabilityDigest: "b".repeat(64),
    recoveryState: "active",
    recoveryExpiresAt: new Date("2026-08-12T00:00:00.000Z"),
    deliveryState: "first_claim_consumed",
    deliverySiteRef: "site-1",
    deliverySiteReleaseRef: "release-1",
    deliverySiteProjectBindingRef: "binding-1",
    deliveryWorkloadIdentityId: "workload-1",
    deliveryBindingEpoch: 2n,
    deliverySubjectRef: "subject-1",
    deliverySubjectGeneration: 3n,
    deliverySessionRef: "session-1",
    deliverySessionEpoch: 4n,
    deliveryCredentialEpoch: 6n,
    deliveryRequestDigest: "a".repeat(64),
    ownerRestrictionEpoch: 5n,
  };
}
