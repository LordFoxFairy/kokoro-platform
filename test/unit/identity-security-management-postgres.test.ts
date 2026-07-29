import { describe, expect, it } from "vitest";
import { PostgresIdentitySecurityManagementRepository } from "../../src/modules/identity/infrastructure/postgres/identity-security-management-repository.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";

describe("Postgres Identity security-management SiteRelease authority", () => {
  it("resolves the issuer label through the exact active SiteRelease binding", async () => {
    let ownerStatement = "";
    let ownerValues: readonly unknown[] = [];
    const lease = issuePlatformTransaction({
      async query(statement, values = []) {
        if (statement.includes("FROM platform.identity_account account")) {
          ownerStatement = statement;
          ownerValues = values;
          return [ownerRow("Acme AI")] as never;
        }
        if (statement.includes("identity_recovery_code")) return [];
        return [];
      },
      async execute() {
        return 0;
      },
    });
    try {
      const material =
        await new PostgresIdentitySecurityManagementRepository().loadSecurityOwnerMaterial(
          lease.transaction,
          { binding: binding(), now: "2026-07-29T00:00:00.000Z" },
        );

      expect(material?.identityIssuerLabel).toBe("Acme AI");
      expect(ownerStatement).toContain("JOIN platform.authorization_site_release release");
      expect(ownerStatement).toContain("release.release_ref=$5");
      expect(ownerStatement).toContain("release.state='active'");
      expect(ownerValues).toEqual([
        "site-1",
        "subject-1",
        "session-1",
        "2026-07-29T00:00:00.000Z",
        "release-1",
      ]);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects an empty label even if a corrupt adapter row bypasses the database constraint", async () => {
    const lease = issuePlatformTransaction({
      async query(statement) {
        return statement.includes("FROM platform.identity_account account")
          ? ([ownerRow("")] as never)
          : [];
      },
      async execute() {
        return 0;
      },
    });
    try {
      await expect(
        new PostgresIdentitySecurityManagementRepository().loadSecurityOwnerMaterial(
          lease.transaction,
          { binding: binding(), now: "2026-07-29T00:00:00.000Z" },
        ),
      ).resolves.toBeNull();
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("moves the recovery capability to the new enrollment so lost-response supersede remains repeatable", async () => {
    const transfers: (readonly unknown[])[] = [];
    const lease = issuePlatformTransaction({
      async query(statement) {
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes("FROM platform.identity_account account"))
          return [ownerRow("Acme AI")] as never;
        if (
          statement.includes("FROM platform.identity_totp_authenticator") &&
          statement.includes("state='active'")
        )
          return [];
        if (
          statement.includes("FROM platform.identity_totp_enrollment_transaction enrollment") &&
          statement.includes("JOIN platform.identity_receipt_recovery_capability")
        ) {
          return [
            {
              authenticatorRef: "old-authenticator",
              enrollmentState: "pending",
              enrollmentExpiresAt: "2026-07-29T00:09:00.000Z",
              claimRequestDigest: "a".repeat(64),
              claimState: "first_claim_consumed",
              receiptRequestDigest: "a".repeat(64),
              operation: "beginTotpEnrollment",
              receiptState: "succeeded",
              callerIdentity: "workload-1",
              recoverySiteRef: "site-1",
              recoveryWorkloadIdentityId: "workload-1",
              recoveryPurpose: "beginTotpEnrollment",
              recoveryTransactionRef: "old-enrollment",
              capabilityDigest: "b".repeat(64),
              recoveryState: "active",
              recoveryExpiresAt: "2026-07-30T00:00:00.000Z",
            },
          ] as never;
        }
        return [];
      },
      async execute(statement, values = []) {
        if (statement.includes("UPDATE platform.identity_receipt_recovery_capability"))
          transfers.push(values);
        return 1;
      },
    });
    try {
      const accepted =
        await new PostgresIdentitySecurityManagementRepository().supersedeTotpEnrollment(
          lease.transaction,
          {
            binding: binding(),
            accountRef: "account-1",
            expectedAccountSecurityEpoch: "7",
            priorCommandId: "1".repeat(32),
            priorTransactionRef: "old-enrollment",
            newCommandId: "2".repeat(32),
            requestDigest: "c".repeat(64),
            workloadIdentityId: "workload-1",
            capabilityDigest: "b".repeat(64),
            transactionRef: "new-enrollment",
            authenticatorRef: "new-authenticator",
            envelope: {
              algorithm: "A256GCM",
              keyRevision: "key-1",
              nonce: "n".repeat(16),
              ciphertext: "c".repeat(16),
              authenticationTag: "t".repeat(22),
            },
            now: "2026-07-29T00:00:00.000Z",
            expiresAt: "2026-07-29T00:10:00.000Z",
          },
        );

      expect(accepted).toBe(true);
      expect(transfers).toEqual([["1".repeat(32), "2".repeat(32), "new-enrollment"]]);
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});

function binding() {
  return {
    siteRef: "site-1",
    siteReleaseRef: "release-1",
    subjectRef: "subject-1",
    sessionRef: "session-1",
    subjectGeneration: "3",
    sessionEpoch: "4",
    credentialEpoch: "5",
    authenticatedAt: "2026-07-29T00:00:00.000Z",
    authenticationMethods: ["password"] as const,
  };
}

function ownerRow(identityIssuerLabel: string) {
  return {
    accountRef: "account-1",
    subjectRef: "subject-1",
    sessionRef: "session-1",
    emailNormalized: "person@example.com",
    identityIssuerLabel,
    accountSecurityEpoch: 7n,
    subjectGeneration: 3n,
    sessionEpoch: 4n,
    credentialEpoch: 5n,
    authenticatedAt: "2026-07-29T00:00:00.000Z",
    authenticationMethods: ["password"],
    passwordHash: "$argon2id$stored",
    pepperVersion: 1,
    passwordCredentialEpoch: 2n,
    authenticatorRef: null,
    secretAlgorithm: null,
    secretKeyRevision: null,
    secretNonce: null,
    secretCiphertext: null,
    secretAuthenticationTag: null,
    lastAcceptedTimeStep: null,
    recoverySetRef: null,
  };
}
