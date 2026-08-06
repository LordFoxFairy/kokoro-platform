import { describe, expect, it } from "vitest";
import { PostgresIdentityRepository } from "../../src/modules/identity/infrastructure/postgres/identity-repository.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";

const now = "2026-07-29T00:00:00.000Z";
const expiresAt = "2026-07-30T00:00:00.000Z";

describe("Postgres Identity receipt-recovery authority", () => {
  it("freezes the current release and product-binding revision at issuance", async () => {
    let insertStatement = "";
    let insertValues: readonly unknown[] = [];
    let authorityStatement = "";
    const lease = issuePlatformTransaction({
      async query(statement) {
        if (statement.includes("FROM platform.authorization_site site")) {
          authorityStatement = statement;
          return [{}] as never;
        }
        if (statement.includes("FROM platform.identity_receipt_recovery_capability")) {
          return [{
            siteRef: "site-1", siteReleaseRef: "release-1", siteProjectBindingRef: "binding-1",
            workloadIdentityId: "workload-1", bindingEpoch: 1n, purpose: "createIdentitySession",
            transactionRef: null, capabilityDigest: "a".repeat(64), state: "active", expiresAt,
          }] as never;
        }
        return [];
      },
      async execute(statement, values = []) {
        insertStatement = statement;
        insertValues = values;
        return 1;
      },
    });
    try {
      await new PostgresIdentityRepository().bindReceiptRecoveryCapability(lease.transaction, {
        commandId: "1".repeat(32), siteRef: "site-1", siteReleaseRef: "release-1",
        siteProjectBindingRef: "binding-1", workloadIdentityId: "workload-1", bindingEpoch: "1",
        purpose: "createIdentitySession", transactionRef: null, capabilityDigest: "a".repeat(64),
        expiresAt, now,
      });

      expect(insertStatement).toContain("site_release_ref,site_project_binding_ref");
      expect(insertStatement).toContain("workload_identity_id,binding_epoch");
      expect(authorityStatement).not.toContain("FOR SHARE");
      expect(insertValues).toEqual([
        "1".repeat(32), "site-1", "release-1", "binding-1", "workload-1", "1",
        "createIdentitySession", null, "a".repeat(64), expiresAt,
      ]);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects an epoch-1 session-delivery capability under current epoch 2 before mutation", async () => {
    let mutations = 0;
    const lease = issuePlatformTransaction({
      async query(statement) {
        if (!statement.includes("FROM platform.identity_session_delivery_claim claim")) return [];
        return [{
          accountRef: "account-1", subjectRef: "subject-1", sessionRef: "session-1",
          claimRequestDigest: "a".repeat(64), receiptRequestDigest: "a".repeat(64),
          callerIdentity: "workload-1", operation: "createIdentitySession", receiptState: "succeeded",
          recoverySiteRef: "site-1", recoverySiteReleaseRef: "release-1",
          recoverySiteProjectBindingRef: "binding-1", recoveryWorkloadIdentityId: "workload-1",
          recoveryBindingEpoch: 1n, recoveryPurpose: "createIdentitySession", recoveryTransactionRef: null,
          capabilityDigest: "b".repeat(64), recoveryState: "active", recoveryExpiresAt: expiresAt,
          sessionEpoch: 1n, credentialEpoch: 1n, sessionExpiresAt: expiresAt,
          authenticationMethods: ["password"], sessionState: "active",
        }] as never;
      },
      async execute() {
        mutations += 1;
        return 1;
      },
    });
    try {
      await expect(new PostgresIdentityRepository().consumeIdentitySessionDeliveryRecovery(
        lease.transaction,
        {
          priorCommandId: "1".repeat(32), newCommandId: "2".repeat(32), siteRef: "site-1",
          siteReleaseRef: "release-1", siteProjectBindingRef: "binding-1",
          workloadIdentityId: "workload-1", bindingEpoch: "2", purpose: "createIdentitySession",
          transactionRef: null, capabilityDigest: "b".repeat(64), now, retainUntil: expiresAt,
        },
      )).resolves.toBeNull();
      expect(mutations).toBe(0);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects an epoch-1 refresh-delivery capability under current epoch 2 before mutation", async () => {
    let mutations = 0;
    const lease = issuePlatformTransaction({
      async query(statement) {
        if (!statement.includes("JOIN platform.identity_refresh_credential credential")) return [];
        return [{
          subjectRef: "subject-1", sessionRef: "session-1",
          claimRequestDigest: "a".repeat(64), receiptRequestDigest: "a".repeat(64),
          callerIdentity: "workload-1", operation: "refreshIdentitySession", receiptState: "succeeded",
          recoverySiteRef: "site-1", recoverySiteReleaseRef: "release-1",
          recoverySiteProjectBindingRef: "binding-1", recoveryWorkloadIdentityId: "workload-1",
          recoveryBindingEpoch: 1n, recoveryPurpose: "refreshIdentitySession", recoveryTransactionRef: null,
          capabilityDigest: "b".repeat(64), recoveryState: "active", recoveryExpiresAt: expiresAt,
          familyRef: "family-1", currentGeneration: 1n, absoluteExpiresAt: expiresAt,
          sessionState: "active",
        }] as never;
      },
      async execute() {
        mutations += 1;
        return 1;
      },
    });
    try {
      await expect(new PostgresIdentityRepository().supersedeIdentityRefreshDelivery(
        lease.transaction,
        {
          priorCommandId: "1".repeat(32), newCommandId: "2".repeat(32), requestDigest: "c".repeat(64),
          siteRef: "site-1", siteReleaseRef: "release-1", siteProjectBindingRef: "binding-1",
          workloadIdentityId: "workload-1", bindingEpoch: "2", purpose: "refreshIdentitySession",
          capabilityDigest: "b".repeat(64), sessionCredentialDigest: "d".repeat(64),
          refreshCredentialDigest: "e".repeat(64), now, sessionExpiresAt: expiresAt, retainUntil: expiresAt,
        },
      )).resolves.toBeNull();
      expect(mutations).toBe(0);
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});
