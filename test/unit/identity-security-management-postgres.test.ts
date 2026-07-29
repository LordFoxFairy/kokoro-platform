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

  it("consumes a proof only for its exact SiteRelease, workload, target, owner and frozen epochs", async () => {
    let statement = "";
    let values: readonly unknown[] = [];
    const lease = issuePlatformTransaction({
      async query() {
        return [];
      },
      async execute(sql, parameters = []) {
        statement = sql;
        values = parameters;
        return 1;
      },
    });
    try {
      const consumed = await new PostgresIdentitySecurityManagementRepository()
        .consumeReauthenticationProof(lease.transaction, {
          binding: binding(),
          accountRef: "account-1",
          commandId: "2".repeat(32),
          proof: {
            proofDigest: "a".repeat(64),
            workloadIdentityId: "workload-1",
            expectedAuthStrengthPolicyRevision: "default-v1",
            target: {
              audience: "platform-public",
              operationId: "disableTotp",
              resourceKind: "identity_account",
            },
          },
          now: "2026-07-29T00:00:00.000Z",
        });

      expect(consumed).toBe(true);
      expect(statement).toContain("site_release_ref=$3");
      expect(statement).toContain("workload_identity_id=$4");
      expect(statement).toContain("operation_id=$9");
      expect(statement).toContain("resource_ref=$5");
      expect(statement).toContain("account_security_epoch=(");
      expect(statement).toContain("subject_generation=$11::bigint");
      expect(statement).toContain("session_epoch=$12::bigint");
      expect(statement).toContain("credential_epoch=$15::bigint");
      expect(statement).toContain("auth_strength_policy_revision=$16");
      expect(statement).toContain("authorization_site_release release");
      expect(statement).toContain("authorization_product_binding binding");
      expect(statement).toContain("release.state='active'");
      expect(statement).toContain("binding.state='active'");
      expect(statement).toContain("proof.state='active' AND proof.expires_at>$14::timestamptz");
      expect(values).toEqual([
        "a".repeat(64), "site-1", "release-1", "workload-1", "account-1",
        "subject-1", "session-1", "platform-public", "disableTotp", "identity_account",
        "3", "4", "2".repeat(32), "2026-07-29T00:00:00.000Z", "5", "default-v1",
      ]);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("supersedes a lost proof delivery only through its bound recovery capability", async () => {
    const transfers: (readonly unknown[])[] = [];
    const priorCommandId = "1".repeat(32);
    const newCommandId = "2".repeat(32);
    const lease = issuePlatformTransaction({
      async query(statement) {
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes("FROM platform.identity_account account")) {
          return [ownerRow("Acme AI")] as never;
        }
        if (statement.includes("FROM platform.identity_reauthentication_proof proof")) {
          return [{
            proofDigest: "a".repeat(64), proofState: "active",
            proofExpiresAt: "2026-07-29T00:05:00.000Z", audience: "platform-public",
            operationId: "regenerateRecoveryCodes", resourceKind: "identity_account",
            authStrengthPolicyRevision: "default-v1", claimState: "first_claim_consumed",
            claimRequestDigest: "b".repeat(64), receiptRequestDigest: "b".repeat(64),
            operation: "reauthenticateIdentitySession", receiptState: "succeeded",
            callerIdentity: "workload-1", recoverySiteRef: "site-1",
            recoveryWorkloadIdentityId: "workload-1",
            recoveryPurpose: "reauthenticateIdentitySession", capabilityDigest: "c".repeat(64),
            recoveryState: "active", recoveryExpiresAt: "2026-07-30T00:00:00.000Z",
          }] as never;
        }
        return [];
      },
      async execute(statement, values = []) {
        if (statement.includes("UPDATE platform.identity_receipt_recovery_capability")) {
          transfers.push(values);
        }
        return 1;
      },
    });
    try {
      const result = await new PostgresIdentitySecurityManagementRepository()
        .supersedeReauthenticationProof(lease.transaction, {
          binding: binding(), accountRef: "account-1", expectedAccountSecurityEpoch: "7",
          priorCommandId, newCommandId, requestDigest: "d".repeat(64),
          workloadIdentityId: "workload-1", capabilityDigest: "c".repeat(64),
          proofDigest: "e".repeat(64), now: "2026-07-29T00:00:00.000Z",
          expiresAt: "2026-07-29T00:05:00.000Z",
        });

      expect(result).toEqual({
        target: { audience: "platform-public", operationId: "regenerateRecoveryCodes",
          resourceKind: "identity_account" },
        authStrengthPolicyRevision: "default-v1",
      });
      expect(transfers).toEqual([[priorCommandId, newCommandId]]);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it.each([
    "auth-strength policy revision",
    "active SiteRelease",
    "active workload binding",
  ])("rejects a stale %s before mutating the TOTP factor", async () => {
    let factorMutations = 0;
    const statements: string[] = [];
    const lease = issuePlatformTransaction({
      async query(statement) {
        statements.push(statement);
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes("FROM platform.identity_account account")) {
          return [activeOwnerRow()] as never;
        }
        if (statement.includes("FROM platform.identity_reauthentication_proof proof")) return [];
        return [];
      },
      async execute(statement) {
        if (statement.includes("UPDATE platform.identity_totp_authenticator")) factorMutations += 1;
        return statement.includes("identity_reauthentication_proof") ? 0 : 1;
      },
    });
    try {
      await expect(new PostgresIdentitySecurityManagementRepository().disableTotp(
        lease.transaction,
        {
          binding: binding(), accountRef: "account-1", authenticatorRef: "authenticator-1",
          timeStep: 101, commandId: "2".repeat(32), now: "2026-07-29T00:00:00.000Z",
          proof: {
            proofDigest: "a".repeat(64), workloadIdentityId: "workload-1",
            expectedAuthStrengthPolicyRevision: "default-v1",
            target: { audience: "platform-public", operationId: "disableTotp",
              resourceKind: "identity_account" },
          },
        },
      )).resolves.toBeNull();
      expect(factorMutations).toBe(0);
      const proofLock = statements.findIndex((statement) =>
        statement.includes("FROM platform.identity_reauthentication_proof proof"));
      expect(proofLock).toBeGreaterThan(-1);
      expect(statements[proofLock]).toContain("proof.auth_strength_policy_revision=$15");
      expect(statements[proofLock]).toContain("release.state='active'");
      expect(statements[proofLock]).toContain("binding.state='active'");
      expect(statements[proofLock]).toContain("FOR UPDATE OF proof");
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
    authStrengthPolicyRevision: "default-v1",
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

function activeOwnerRow() {
  return {
    ...ownerRow("Acme AI"),
    authenticatorRef: "authenticator-1",
    secretAlgorithm: "A256GCM",
    secretKeyRevision: "key-1",
    secretNonce: "nonce",
    secretCiphertext: "sealed",
    secretAuthenticationTag: "tag",
    lastAcceptedTimeStep: 100n,
    recoverySetRef: "recovery-set-1",
  };
}
