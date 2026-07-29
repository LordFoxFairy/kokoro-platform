import { describe, expect, it } from "vitest";
import { PostgresIdentitySecurityManagementRepository } from "../../src/modules/identity/infrastructure/postgres/identity-security-management-repository.js";
import { IdentitySecurityAtomicRejection } from "../../src/modules/identity/application/contracts/identity-security-management-repository.js";
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
      expect(ownerStatement).toContain("JOIN platform.authorization_site site");
      expect(ownerStatement).toContain("site.state='active'");
      expect(ownerStatement).toContain("release.release_ref=$5");
      expect(ownerStatement).toContain("release.state='active'");
      expect(ownerStatement).toContain("JOIN platform.authorization_product_binding product_binding");
      expect(ownerStatement).toContain("product_binding.binding_ref=$6");
      expect(ownerStatement).toContain("product_binding.workload_identity_id=$7");
      expect(ownerStatement).toContain("product_binding.binding_epoch=$8::bigint");
      expect(ownerStatement).toContain("product_binding.state='active'");
      expect(ownerValues).toEqual([
        "site-1",
        "subject-1",
        "session-1",
        "2026-07-29T00:00:00.000Z",
        "release-1",
        "binding-1",
        "workload-1",
        "1",
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

  it.each([
    ["suspended site", { siteState: "suspended" }],
    ["retired SiteRelease", { releaseState: "retired" }],
    ["revoked product binding", { bindingState: "revoked" }],
    ["rotated binding epoch", { bindingEpoch: 2n }],
  ] as const)("rejects a %s row even if an adapter bypasses SQL authority filters", async (_reason, stale) => {
    const lease = issuePlatformTransaction({
      async query(statement) {
        return statement.includes("FROM platform.identity_account account")
          ? ([{ ...ownerRow("Acme AI"), ...stale }] as never)
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
              ...enrollmentRecoveryAuthorityRow(),
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
              recoverySiteReleaseRef: "release-1",
              recoverySiteProjectBindingRef: "binding-1",
              recoveryWorkloadIdentityId: "workload-1",
              recoveryBindingEpoch: 1n,
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
            expectedAuthStrengthPolicyRevision: "default-v1",
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

  it("rejects an epoch-1 enrollment recovery capability after caller and authority rotate to epoch 2", async () => {
    let mutations = 0;
    const lease = issuePlatformTransaction({
      async query(statement) {
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes("FROM platform.identity_account account")) {
          return [ownerRow("Acme AI", 2n)] as never;
        }
        if (statement.includes("FROM platform.identity_totp_authenticator") &&
            statement.includes("state='active'")) return [];
        if (statement.includes("FROM platform.identity_totp_enrollment_transaction enrollment")) {
          return [{
            ...enrollmentRecoveryAuthorityRow(),
            authenticatorRef: "old-authenticator", enrollmentState: "pending",
            enrollmentExpiresAt: "2026-07-29T00:09:00.000Z",
            claimRequestDigest: "a".repeat(64), claimState: "first_claim_consumed",
            receiptRequestDigest: "a".repeat(64), operation: "beginTotpEnrollment",
            receiptState: "succeeded", callerIdentity: "workload-1",
            recoverySiteRef: "site-1", recoverySiteReleaseRef: "release-1",
            recoverySiteProjectBindingRef: "binding-1", recoveryWorkloadIdentityId: "workload-1",
            recoveryBindingEpoch: 1n, recoveryPurpose: "beginTotpEnrollment",
            recoveryTransactionRef: "old-enrollment", capabilityDigest: "b".repeat(64),
            recoveryState: "active", recoveryExpiresAt: "2026-07-30T00:00:00.000Z",
          }] as never;
        }
        return [];
      },
      async execute() {
        mutations += 1;
        return 1;
      },
    });
    try {
      await expect(new PostgresIdentitySecurityManagementRepository().supersedeTotpEnrollment(
        lease.transaction,
        {
          binding: binding("2"), accountRef: "account-1", expectedAccountSecurityEpoch: "7",
          expectedAuthStrengthPolicyRevision: "default-v1",
          priorCommandId: "1".repeat(32), priorTransactionRef: "old-enrollment",
          newCommandId: "2".repeat(32), requestDigest: "c".repeat(64),
          workloadIdentityId: "workload-1", capabilityDigest: "b".repeat(64),
          transactionRef: "new-enrollment", authenticatorRef: "new-authenticator",
          envelope: { algorithm: "A256GCM", keyRevision: "key-1", nonce: "nonce",
            ciphertext: "sealed", authenticationTag: "tag" },
          now: "2026-07-29T00:00:00.000Z", expiresAt: "2026-07-29T00:10:00.000Z",
        },
      )).resolves.toBe(false);
      expect(mutations).toBe(0);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects enrollment delivery recovery after the issuing session credential epoch rotates", async () => {
    let mutations = 0;
    const lease = issuePlatformTransaction({
      async query(statement) {
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes("FROM platform.identity_account account")) {
          return [ownerRow("Acme AI")] as never;
        }
        if (statement.includes("FROM platform.identity_totp_authenticator") &&
            statement.includes("state='active'")) return [];
        if (statement.includes("FROM platform.identity_totp_enrollment_transaction enrollment")) {
          return [{
            ...enrollmentRecoveryAuthorityRow(), enrollmentCredentialEpoch: 4n, claimCredentialEpoch: 4n,
            authenticatorRef: "old-authenticator", enrollmentState: "pending",
            enrollmentExpiresAt: "2026-07-29T00:09:00.000Z",
            claimRequestDigest: "a".repeat(64), claimState: "first_claim_consumed",
            receiptRequestDigest: "a".repeat(64), operation: "beginTotpEnrollment",
            receiptState: "succeeded", callerIdentity: "workload-1",
            recoverySiteRef: "site-1", recoverySiteReleaseRef: "release-1",
            recoverySiteProjectBindingRef: "binding-1", recoveryWorkloadIdentityId: "workload-1",
            recoveryBindingEpoch: 1n, recoveryPurpose: "beginTotpEnrollment",
            recoveryTransactionRef: "old-enrollment", capabilityDigest: "b".repeat(64),
            recoveryState: "active", recoveryExpiresAt: "2026-07-30T00:00:00.000Z",
          }] as never;
        }
        return [];
      },
      async execute() {
        mutations += 1;
        return 1;
      },
    });
    try {
      await expect(new PostgresIdentitySecurityManagementRepository().supersedeTotpEnrollment(
        lease.transaction,
        {
          binding: binding(), accountRef: "account-1", expectedAccountSecurityEpoch: "7",
          expectedAuthStrengthPolicyRevision: "default-v1", priorCommandId: "1".repeat(32),
          priorTransactionRef: "old-enrollment", newCommandId: "2".repeat(32),
          requestDigest: "c".repeat(64), workloadIdentityId: "workload-1",
          capabilityDigest: "b".repeat(64), transactionRef: "new-enrollment",
          authenticatorRef: "new-authenticator", envelope: { algorithm: "A256GCM",
            keyRevision: "key-1", nonce: "nonce", ciphertext: "sealed", authenticationTag: "tag" },
          now: "2026-07-29T00:00:00.000Z", expiresAt: "2026-07-29T00:10:00.000Z",
        },
      )).resolves.toBe(false);
      expect(mutations).toBe(0);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects a stale proof before starting a new TOTP enrollment mutation", async () => {
    let mutations = 0;
    const lease = issuePlatformTransaction({
      async query(statement) {
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes("FROM platform.identity_account account")) {
          return [ownerRow("Acme AI", 2n)] as never;
        }
        if (statement.includes("FROM platform.identity_reauthentication_proof proof")) return [];
        throw new Error(`unexpected query before proof validation: ${statement}`);
      },
      async execute() {
        mutations += 1;
        return 1;
      },
    });
    try {
      await expect(new PostgresIdentitySecurityManagementRepository().beginTotpEnrollment(
        lease.transaction,
        {
          binding: binding("2"), accountRef: "account-1", expectedAccountSecurityEpoch: "7",
          commandId: "1".repeat(32), requestDigest: "a".repeat(64),
          proof: {
            proofDigest: "b".repeat(64), workloadIdentityId: "workload-1",
            expectedAuthStrengthPolicyRevision: "default-v1",
            target: { audience: "platform-public", operationId: "beginTotpEnrollment",
              resourceKind: "identity_account" },
          },
          transactionRef: "enrollment-1", authenticatorRef: "authenticator-1",
          envelope: { algorithm: "A256GCM", keyRevision: "key-1", nonce: "nonce",
            ciphertext: "sealed", authenticationTag: "tag" },
          now: "2026-07-29T00:00:00.000Z", expiresAt: "2026-07-29T00:10:00.000Z",
        },
      )).resolves.toBe(false);
      expect(mutations).toBe(0);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it.each([
    "suspended site",
    "revoked product binding",
    "rotated binding epoch",
  ])("rejects TOTP enrollment supersede under a %s before any delivery mutation", async () => {
    let authorityStatement = "";
    let mutations = 0;
    const lease = issuePlatformTransaction({
      async query(statement) {
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes("FROM platform.identity_account account")) {
          authorityStatement = statement;
          return [];
        }
        return [];
      },
      async execute() {
        mutations += 1;
        return 1;
      },
    });
    try {
      await expect(new PostgresIdentitySecurityManagementRepository().supersedeTotpEnrollment(
        lease.transaction,
        {
          binding: binding(), accountRef: "account-1", expectedAccountSecurityEpoch: "7",
          expectedAuthStrengthPolicyRevision: "default-v1",
          priorCommandId: "1".repeat(32), priorTransactionRef: "lost-enrollment",
          newCommandId: "2".repeat(32), requestDigest: "a".repeat(64),
          workloadIdentityId: "workload-1", capabilityDigest: "b".repeat(64),
          transactionRef: "replacement-enrollment", authenticatorRef: "authenticator-2",
          envelope: { algorithm: "A256GCM", keyRevision: "key-1", nonce: "nonce",
            ciphertext: "sealed", authenticationTag: "tag" },
          now: "2026-07-29T00:00:00.000Z", expiresAt: "2026-07-29T00:10:00.000Z",
        },
      )).resolves.toBe(false);
      expect(mutations).toBe(0);
      expect(authorityStatement).toContain("site.state='active'");
      expect(authorityStatement).toContain("product_binding.binding_ref=$6");
      expect(authorityStatement).toContain("product_binding.binding_epoch=$8::bigint");
      expect(authorityStatement).toContain("product_binding.state='active'");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it.each([
    "suspended site",
    "revoked product binding",
    "rotated binding epoch",
  ])("rejects recovery-code supersede under a %s before any code-set mutation", async () => {
    let authorityStatement = "";
    let mutations = 0;
    const lease = issuePlatformTransaction({
      async query(statement) {
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes("FROM platform.identity_account account")) {
          authorityStatement = statement;
          return [];
        }
        return [];
      },
      async execute() {
        mutations += 1;
        return 1;
      },
    });
    try {
      await expect(new PostgresIdentitySecurityManagementRepository().supersedeRecoveryCodes(
        lease.transaction,
        {
          binding: binding(), accountRef: "account-1", priorCommandId: "1".repeat(32),
          newCommandId: "2".repeat(32), expectedAuthStrengthPolicyRevision: "default-v1",
          requestDigest: "a".repeat(64), workloadIdentityId: "workload-1",
          capabilityDigest: "b".repeat(64), setRef: "replacement-set",
          recoveryCodeDigests: [{ codeDigest: "c".repeat(64) }],
          now: "2026-07-29T00:00:00.000Z",
        },
      )).resolves.toBeNull();
      expect(mutations).toBe(0);
      expect(authorityStatement).toContain("site.state='active'");
      expect(authorityStatement).toContain("product_binding.binding_ref=$6");
      expect(authorityStatement).toContain("product_binding.binding_epoch=$8::bigint");
      expect(authorityStatement).toContain("product_binding.state='active'");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("raises a typed rollback signal when concurrent enrollment supersede loses its CAS", async () => {
    const lease = issuePlatformTransaction({
      async query(statement) {
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes("FROM platform.identity_account account")) {
          return [ownerRow("Acme AI")] as never;
        }
        if (statement.includes("FROM platform.identity_totp_authenticator") &&
            statement.includes("state='active'")) return [];
        if (statement.includes("FROM platform.identity_totp_enrollment_transaction enrollment")) {
          return [{
            ...enrollmentRecoveryAuthorityRow(),
            authenticatorRef: "old-authenticator", enrollmentState: "pending",
            enrollmentExpiresAt: "2026-07-29T00:09:00.000Z",
            claimRequestDigest: "a".repeat(64), claimState: "first_claim_consumed",
            receiptRequestDigest: "a".repeat(64), operation: "beginTotpEnrollment",
            receiptState: "succeeded", callerIdentity: "workload-1",
            recoverySiteRef: "site-1", recoverySiteReleaseRef: "release-1",
            recoverySiteProjectBindingRef: "binding-1", recoveryWorkloadIdentityId: "workload-1",
            recoveryBindingEpoch: 1n,
            recoveryPurpose: "beginTotpEnrollment", recoveryTransactionRef: "old-enrollment",
            capabilityDigest: "b".repeat(64), recoveryState: "active",
            recoveryExpiresAt: "2026-07-30T00:00:00.000Z",
          }] as never;
        }
        return [];
      },
      async execute(statement) {
        return statement.includes("UPDATE platform.identity_receipt_recovery_capability") ? 0 : 1;
      },
    });
    try {
      await expect(new PostgresIdentitySecurityManagementRepository().supersedeTotpEnrollment(
        lease.transaction,
        {
          binding: binding(), accountRef: "account-1", expectedAccountSecurityEpoch: "7",
          expectedAuthStrengthPolicyRevision: "default-v1",
          priorCommandId: "1".repeat(32), priorTransactionRef: "old-enrollment",
          newCommandId: "2".repeat(32), requestDigest: "c".repeat(64),
          workloadIdentityId: "workload-1", capabilityDigest: "b".repeat(64),
          transactionRef: "new-enrollment", authenticatorRef: "new-authenticator",
          envelope: { algorithm: "A256GCM", keyRevision: "key-1", nonce: "nonce",
            ciphertext: "sealed", authenticationTag: "tag" },
          now: "2026-07-29T00:00:00.000Z", expiresAt: "2026-07-29T00:10:00.000Z",
        },
      )).rejects.toBeInstanceOf(IdentitySecurityAtomicRejection);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("raises a typed rollback signal before code replacement when recovery supersede loses its CAS", async () => {
    let codeSetMutations = 0;
    const lease = issuePlatformTransaction({
      async query(statement) {
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes("FROM platform.identity_account account")) {
          return [ownerRow("Acme AI")] as never;
        }
        if (statement.includes("FROM platform.identity_recovery_code_delivery_claim claim")) {
          return [{
            ...deliveryClaimAuthorityRow(),
            setRef: "old-set", claimState: "first_claim_consumed",
            claimRequestDigest: "a".repeat(64), receiptRequestDigest: "a".repeat(64),
            operation: "regenerateRecoveryCodes", receiptState: "succeeded",
            callerIdentity: "workload-1", recoverySiteRef: "site-1",
            recoverySiteReleaseRef: "release-1", recoverySiteProjectBindingRef: "binding-1",
            recoveryWorkloadIdentityId: "workload-1",
            recoveryBindingEpoch: 1n,
            recoveryPurpose: "regenerateRecoveryCodes", recoveryTransactionRef: "old-set",
            capabilityDigest: "b".repeat(64), recoveryState: "active",
            recoveryExpiresAt: "2026-07-30T00:00:00.000Z", setState: "active",
          }] as never;
        }
        return [];
      },
      async execute(statement) {
        if (statement.includes("UPDATE platform.identity_recovery_code_delivery_claim")) return 0;
        if (statement.includes("identity_recovery_code_set") ||
            statement.includes("identity_recovery_code\n")) codeSetMutations += 1;
        return 1;
      },
    });
    try {
      await expect(new PostgresIdentitySecurityManagementRepository().supersedeRecoveryCodes(
        lease.transaction,
        {
          binding: binding(), accountRef: "account-1", priorCommandId: "1".repeat(32),
          newCommandId: "2".repeat(32), expectedAuthStrengthPolicyRevision: "default-v1",
          requestDigest: "a".repeat(64), workloadIdentityId: "workload-1",
          capabilityDigest: "b".repeat(64), setRef: "new-set",
          recoveryCodeDigests: [{ codeDigest: "c".repeat(64) }],
          now: "2026-07-29T00:00:00.000Z",
        },
      )).rejects.toBeInstanceOf(IdentitySecurityAtomicRejection);
      expect(codeSetMutations).toBe(0);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("consumes a proof only for its exact SiteRelease, workload, target, owner and frozen epochs", async () => {
    let statement = "";
    let values: readonly unknown[] = [];
    const lease = issuePlatformTransaction({
      async query(sql) {
        if (sql.includes("pg_advisory_xact_lock")) return [];
        if (sql.includes("FROM platform.identity_account account")) {
          return [ownerRow("Acme AI")] as never;
        }
        if (sql.includes("FROM platform.identity_reauthentication_proof proof")) {
          return [{}] as never;
        }
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
      expect(statement).toContain("authorization_site site");
      expect(statement).toContain("site.state='active'");
      expect(statement).toContain("release.state='active'");
      expect(statement).toContain("binding.state='active'");
      expect(statement).toContain("binding.binding_ref=$17");
      expect(statement).toContain("binding.workload_identity_id=$18");
      expect(statement).toContain("binding.binding_epoch=$19::bigint");
      expect(statement).toContain("proof.site_project_binding_ref=binding.binding_ref");
      expect(statement).toContain("proof.binding_epoch=binding.binding_epoch");
      expect(statement).toContain("proof.state='active' AND proof.expires_at>$14::timestamptz");
      expect(values).toEqual([
        "a".repeat(64), "site-1", "release-1", "workload-1", "account-1",
        "subject-1", "session-1", "platform-public", "disableTotp", "identity_account",
        "3", "4", "2".repeat(32), "2026-07-29T00:00:00.000Z", "5", "default-v1",
        "binding-1", "workload-1", "1",
      ]);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("supersedes a lost proof delivery only through its bound recovery capability", async () => {
    const transfers: (readonly unknown[])[] = [];
    let replacementProofExpiresAt: unknown;
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
            ...proofRecoveryOwnerRow(),
            proofDigest: "a".repeat(64), proofState: "active",
            proofExpiresAt: "2026-07-29T00:03:00.000Z", audience: "platform-public",
            operationId: "regenerateRecoveryCodes", resourceKind: "identity_account",
            authStrengthPolicyRevision: "default-v1", claimState: "first_claim_consumed",
            claimRequestDigest: "b".repeat(64), receiptRequestDigest: "b".repeat(64),
            operation: "reauthenticateIdentitySession", receiptState: "succeeded",
            callerIdentity: "workload-1", recoverySiteRef: "site-1",
            proofSiteReleaseRef: "release-1", proofSiteProjectBindingRef: "binding-1",
            proofWorkloadIdentityId: "workload-1", proofBindingEpoch: 1n,
            recoverySiteReleaseRef: "release-1", recoverySiteProjectBindingRef: "binding-1",
            recoveryWorkloadIdentityId: "workload-1",
            recoveryBindingEpoch: 1n,
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
        if (statement.includes("INSERT INTO platform.identity_reauthentication_proof")) {
          replacementProofExpiresAt = values[17];
        }
        return 1;
      },
    });
    try {
      const result = await new PostgresIdentitySecurityManagementRepository()
        .supersedeReauthenticationProof(lease.transaction, {
          binding: binding(), accountRef: "account-1", expectedAccountSecurityEpoch: "7",
          expectedAuthStrengthPolicyRevision: "default-v1",
          priorCommandId, newCommandId, requestDigest: "d".repeat(64),
          workloadIdentityId: "workload-1", capabilityDigest: "c".repeat(64),
          proofDigest: "e".repeat(64), now: "2026-07-29T00:00:00.000Z",
          expiresAt: "2026-07-29T00:02:00.000Z",
        });

      expect(result).toEqual({
        target: { audience: "platform-public", operationId: "regenerateRecoveryCodes",
          resourceKind: "identity_account" },
        authStrengthPolicyRevision: "default-v1",
        expiresAt: "2026-07-29T00:03:00.000Z",
      });
      expect(transfers).toEqual([[priorCommandId, newCommandId]]);
      expect(replacementProofExpiresAt).toBe("2026-07-29T00:03:00.000Z");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects an epoch-1 proof recovery capability after caller and authority rotate to epoch 2", async () => {
    let mutations = 0;
    const lease = issuePlatformTransaction({
      async query(statement) {
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes("FROM platform.identity_account account")) {
          return [ownerRow("Acme AI", 2n)] as never;
        }
        if (statement.includes("FROM platform.identity_reauthentication_proof proof")) {
          return [{
            proofDigest: "a".repeat(64), proofState: "active",
            proofExpiresAt: "2026-07-29T00:05:00.000Z", audience: "platform-public",
            operationId: "regenerateRecoveryCodes", resourceKind: "identity_account",
            authStrengthPolicyRevision: "default-v1", claimState: "first_claim_consumed",
            claimRequestDigest: "b".repeat(64), receiptRequestDigest: "b".repeat(64),
            operation: "reauthenticateIdentitySession", receiptState: "succeeded",
            callerIdentity: "workload-1", proofSiteReleaseRef: "release-1",
            proofSiteProjectBindingRef: "binding-1", proofWorkloadIdentityId: "workload-1",
            proofBindingEpoch: 1n, recoverySiteRef: "site-1",
            recoverySiteReleaseRef: "release-1", recoverySiteProjectBindingRef: "binding-1",
            recoveryWorkloadIdentityId: "workload-1", recoveryBindingEpoch: 1n,
            recoveryPurpose: "reauthenticateIdentitySession", capabilityDigest: "c".repeat(64),
            recoveryState: "active", recoveryExpiresAt: "2026-07-30T00:00:00.000Z",
          }] as never;
        }
        return [];
      },
      async execute() {
        mutations += 1;
        return 1;
      },
    });
    try {
      await expect(new PostgresIdentitySecurityManagementRepository().supersedeReauthenticationProof(
        lease.transaction,
        {
          binding: binding("2"), accountRef: "account-1", expectedAccountSecurityEpoch: "7",
          expectedAuthStrengthPolicyRevision: "default-v1", priorCommandId: "1".repeat(32),
          newCommandId: "2".repeat(32), requestDigest: "d".repeat(64),
          workloadIdentityId: "workload-1", capabilityDigest: "c".repeat(64),
          proofDigest: "e".repeat(64), now: "2026-07-29T00:00:00.000Z",
          expiresAt: "2026-07-29T00:05:00.000Z",
        },
      )).resolves.toBeNull();
      expect(mutations).toBe(0);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects an epoch-1 recovery-code capability after caller and authority rotate to epoch 2", async () => {
    let mutations = 0;
    const lease = issuePlatformTransaction({
      async query(statement) {
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes("FROM platform.identity_account account")) {
          return [ownerRow("Acme AI", 2n)] as never;
        }
        if (statement.includes("FROM platform.identity_recovery_code_delivery_claim claim")) {
          return [{
            setRef: "old-set", setState: "active", claimState: "first_claim_consumed",
            claimRequestDigest: "a".repeat(64), receiptRequestDigest: "a".repeat(64),
            operation: "regenerateRecoveryCodes", receiptState: "succeeded",
            callerIdentity: "workload-1", recoverySiteRef: "site-1",
            recoverySiteReleaseRef: "release-1", recoverySiteProjectBindingRef: "binding-1",
            recoveryWorkloadIdentityId: "workload-1", recoveryBindingEpoch: 1n,
            recoveryPurpose: "regenerateRecoveryCodes", recoveryTransactionRef: "old-set",
            capabilityDigest: "b".repeat(64), recoveryState: "active",
            recoveryExpiresAt: "2026-07-30T00:00:00.000Z",
          }] as never;
        }
        return [];
      },
      async execute() {
        mutations += 1;
        return 1;
      },
    });
    try {
      await expect(new PostgresIdentitySecurityManagementRepository().supersedeRecoveryCodes(
        lease.transaction,
        {
          binding: binding("2"), accountRef: "account-1", priorCommandId: "1".repeat(32),
          newCommandId: "2".repeat(32), expectedAuthStrengthPolicyRevision: "default-v1",
          requestDigest: "c".repeat(64), workloadIdentityId: "workload-1",
          capabilityDigest: "b".repeat(64), setRef: "new-set",
          recoveryCodeDigests: [{ codeDigest: "d".repeat(64) }],
          now: "2026-07-29T00:00:00.000Z",
        },
      )).resolves.toBeNull();
      expect(mutations).toBe(0);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects recovery-code delivery recovery after the issuing session epoch rotates", async () => {
    let mutations = 0;
    const lease = issuePlatformTransaction({
      async query(statement) {
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes("FROM platform.identity_account account")) {
          return [ownerRow("Acme AI")] as never;
        }
        if (statement.includes("FROM platform.identity_recovery_code_delivery_claim claim")) {
          return [{
            ...deliveryClaimAuthorityRow(), claimSessionEpoch: 3n,
            setRef: "old-set", setState: "active", claimState: "first_claim_consumed",
            claimRequestDigest: "a".repeat(64), receiptRequestDigest: "a".repeat(64),
            operation: "regenerateRecoveryCodes", receiptState: "succeeded",
            callerIdentity: "workload-1", recoverySiteRef: "site-1",
            recoverySiteReleaseRef: "release-1", recoverySiteProjectBindingRef: "binding-1",
            recoveryWorkloadIdentityId: "workload-1", recoveryBindingEpoch: 1n,
            recoveryPurpose: "regenerateRecoveryCodes", recoveryTransactionRef: "old-set",
            capabilityDigest: "b".repeat(64), recoveryState: "active",
            recoveryExpiresAt: "2026-07-30T00:00:00.000Z",
          }] as never;
        }
        return [];
      },
      async execute() {
        mutations += 1;
        return 1;
      },
    });
    try {
      await expect(new PostgresIdentitySecurityManagementRepository().supersedeRecoveryCodes(
        lease.transaction,
        {
          binding: binding(), accountRef: "account-1", priorCommandId: "1".repeat(32),
          newCommandId: "2".repeat(32), expectedAuthStrengthPolicyRevision: "default-v1",
          requestDigest: "c".repeat(64), workloadIdentityId: "workload-1",
          capabilityDigest: "b".repeat(64), setRef: "new-set",
          recoveryCodeDigests: Array.from({ length: 10 }, (_, index) => ({
            codeDigest: index.toString(16).repeat(64),
          })),
          now: "2026-07-29T00:00:00.000Z",
        },
      )).resolves.toBeNull();
      expect(mutations).toBe(0);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("requires a challenge to carry the binding revision that issued it", async () => {
    let statement = "";
    const lease = issuePlatformTransaction({
      async query(sql) {
        statement = sql;
        return [];
      },
      async execute() {
        return 0;
      },
    });
    try {
      await new PostgresIdentitySecurityManagementRepository().loadReauthenticationChallengeMaterial(
        lease.transaction,
        {
          binding: binding("2"), workloadIdentityId: "workload-1",
          transactionRef: "challenge-1",
          target: { audience: "platform-public", operationId: "disableTotp",
            resourceKind: "identity_account" },
          now: "2026-07-29T00:00:00.000Z",
        },
      );
      expect(statement).toContain("challenge.site_project_binding_ref=product_binding.binding_ref");
      expect(statement).toContain("challenge.binding_epoch=product_binding.binding_epoch");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects an epoch-1 enrollment confirmation after the workload binding rotates to epoch 2", async () => {
    let mutations = 0;
    const lease = issuePlatformTransaction({
      async query(statement) {
        if (statement.includes("SELECT account_ref AS \"accountRef\"") &&
            statement.includes("identity_totp_enrollment_transaction")) {
          return [{ accountRef: "account-1" }] as never;
        }
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes("FROM platform.identity_account account")) {
          return [ownerRow("Acme AI", 2n)] as never;
        }
        if (statement.includes("FROM platform.identity_totp_enrollment_transaction enrollment")) {
          return [{
            accountRef: "account-1", authenticatorRef: "authenticator-1", state: "pending",
            attemptCount: 0, maxAttempts: 5, expiresAt: "2026-07-29T00:10:00.000Z",
            accountSecurityEpoch: 7n, subjectGeneration: 3n, sessionEpoch: 4n,
            credentialEpoch: 5n, lastAcceptedTimeStep: null,
            siteReleaseRef: "release-1", siteProjectBindingRef: "binding-1",
            workloadIdentityId: "workload-1", bindingEpoch: 1n,
            authStrengthPolicyRevision: "default-v1",
          }] as never;
        }
        if (statement.includes("UPDATE platform.identity_account")) {
          return [{ securityEpoch: 8n }] as never;
        }
        return [];
      },
      async execute() {
        mutations += 1;
        return 1;
      },
    });
    try {
      await expect(new PostgresIdentitySecurityManagementRepository().confirmTotpEnrollment(
        lease.transaction,
        {
          binding: binding("2"), transactionRef: "enrollment-1", timeStep: 101,
          commandId: "2".repeat(32), requestDigest: "a".repeat(64), setRef: "set-1",
          recoveryCodeDigests: Array.from({ length: 10 }, (_, index) => ({
            codeDigest: index.toString(16).repeat(64),
          })),
          now: "2026-07-29T00:00:00.000Z",
        },
      )).resolves.toBeNull();
      expect(mutations).toBe(0);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("does not resurrect a proof after its account-security epoch becomes stale", async () => {
    let mutations = 0;
    const lease = issuePlatformTransaction({
      async query(statement) {
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes("FROM platform.identity_account account")) {
          return [{ ...ownerRow("Acme AI"), accountSecurityEpoch: 8n }] as never;
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
            proofSiteReleaseRef: "release-1", proofSiteProjectBindingRef: "binding-1",
            proofWorkloadIdentityId: "workload-1", proofBindingEpoch: 1n,
            proofAccountRef: "account-1", proofSubjectRef: "subject-1",
            proofSessionRef: "session-1", proofAccountSecurityEpoch: 7n,
            proofSubjectGeneration: 3n, proofSessionEpoch: 4n, proofCredentialEpoch: 5n,
            claimSiteRef: "site-1", claimAccountRef: "account-1",
            claimSubjectRef: "subject-1", claimSessionRef: "session-1",
            recoverySiteReleaseRef: "release-1", recoverySiteProjectBindingRef: "binding-1",
            recoveryWorkloadIdentityId: "workload-1", recoveryBindingEpoch: 1n,
            recoveryPurpose: "reauthenticateIdentitySession", capabilityDigest: "c".repeat(64),
            recoveryState: "active", recoveryExpiresAt: "2026-07-30T00:00:00.000Z",
          }] as never;
        }
        return [];
      },
      async execute() {
        mutations += 1;
        return 1;
      },
    });
    try {
      await expect(new PostgresIdentitySecurityManagementRepository().supersedeReauthenticationProof(
        lease.transaction,
        {
          binding: binding(), accountRef: "account-1", expectedAccountSecurityEpoch: "8",
          expectedAuthStrengthPolicyRevision: "default-v1", priorCommandId: "1".repeat(32),
          newCommandId: "2".repeat(32), requestDigest: "d".repeat(64),
          workloadIdentityId: "workload-1", capabilityDigest: "c".repeat(64),
          proofDigest: "e".repeat(64), now: "2026-07-29T00:00:00.000Z",
          expiresAt: "2026-07-29T00:05:00.000Z",
        },
      )).resolves.toBeNull();
      expect(mutations).toBe(0);
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
      expect(statements[proofLock]).toContain("site.state='active'");
      expect(statements[proofLock]).toContain("release.state='active'");
      expect(statements[proofLock]).toContain("binding.state='active'");
      expect(statements[proofLock]).toContain("binding.binding_ref=$16");
      expect(statements[proofLock]).toContain("binding.workload_identity_id=$17");
      expect(statements[proofLock]).toContain("binding.binding_epoch=$18::bigint");
      expect(statements[proofLock]).toContain("FOR UPDATE OF proof");
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});

function binding(bindingEpoch = "1") {
  return {
    siteRef: "site-1",
    siteReleaseRef: "release-1",
    siteProjectBindingRef: "binding-1",
    workloadIdentityId: "workload-1",
    bindingEpoch,
    subjectRef: "subject-1",
    sessionRef: "session-1",
    subjectGeneration: "3",
    sessionEpoch: "4",
    credentialEpoch: "5",
    authenticatedAt: "2026-07-29T00:00:00.000Z",
    authenticationMethods: ["password"] as const,
  };
}

function ownerRow(identityIssuerLabel: string, bindingEpoch = 1n) {
  return {
    siteRef: "site-1",
    siteState: "active",
    siteReleaseRef: "release-1",
    releaseState: "active",
    siteProjectBindingRef: "binding-1",
    workloadIdentityId: "workload-1",
    bindingEpoch,
    bindingState: "active",
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

function deliveryClaimAuthorityRow() {
  return {
    claimSiteRef: "site-1",
    claimSiteReleaseRef: "release-1",
    claimSiteProjectBindingRef: "binding-1",
    claimWorkloadIdentityId: "workload-1",
    claimBindingEpoch: 1n,
    claimAccountRef: "account-1",
    claimSubjectRef: "subject-1",
    claimSessionRef: "session-1",
    claimAccountSecurityEpoch: 7n,
    claimSubjectGeneration: 3n,
    claimSessionEpoch: 4n,
    claimCredentialEpoch: 5n,
    claimAuthStrengthPolicyRevision: "default-v1",
  };
}

function enrollmentRecoveryAuthorityRow() {
  return {
    ...deliveryClaimAuthorityRow(),
    enrollmentSiteReleaseRef: "release-1",
    enrollmentSiteProjectBindingRef: "binding-1",
    enrollmentWorkloadIdentityId: "workload-1",
    enrollmentBindingEpoch: 1n,
    enrollmentAccountRef: "account-1",
    enrollmentSubjectRef: "subject-1",
    enrollmentSessionRef: "session-1",
    enrollmentAccountSecurityEpoch: 7n,
    enrollmentSubjectGeneration: 3n,
    enrollmentSessionEpoch: 4n,
    enrollmentCredentialEpoch: 5n,
    enrollmentAuthStrengthPolicyRevision: "default-v1",
  };
}

function proofRecoveryOwnerRow() {
  return {
    proofAccountRef: "account-1",
    proofSubjectRef: "subject-1",
    proofSessionRef: "session-1",
    proofAccountSecurityEpoch: 7n,
    proofSubjectGeneration: 3n,
    proofSessionEpoch: 4n,
    proofCredentialEpoch: 5n,
    claimSiteRef: "site-1",
    claimAccountRef: "account-1",
    claimSubjectRef: "subject-1",
    claimSessionRef: "session-1",
  };
}
