import { describe, expect, it } from "vitest";
import { PostgresIdentityRepository } from "../../src/modules/identity/infrastructure/postgres/identity-repository.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
  type PlatformSqlTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";

describe("Postgres identity authentication rate authority", () => {
  it("locks a known account after the bounded password-failure budget", async () => {
    let rate: { failedAttemptCount: number; windowStartedAt: string; lockedUntil: string | null } | null = null;
    const sql = statefulSql(() => rate, (values) => {
      rate = {
        windowStartedAt: values[2] as string,
        failedAttemptCount: values[3] as number,
        lockedUntil: values[4] as string | null,
      };
    });
    const lease = issuePlatformTransaction(sql);
    try {
      const repository = new PostgresIdentityRepository();
      for (let index = 0; index < 10; index += 1) {
        await repository.recordIdentityPasswordFailure(lease.transaction, {
          siteRef: "site-1", accountRef: "account-1", subjectRef: "subject-1",
          passwordCredentialEpoch: "7", now: `2026-07-29T00:00:${String(index).padStart(2, "0")}.000Z`,
        });
      }
      expect(rate).toEqual({
        windowStartedAt: "2026-07-29T00:00:00.000Z",
        failedAttemptCount: 10,
        lockedUntil: "2026-07-29T00:15:09.000Z",
      });
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects a correct password during lock and resets after the window for password-only success", async () => {
    let rate: { failedAttemptCount: number; windowStartedAt: string; lockedUntil: string | null } | null = {
      failedAttemptCount: 10,
      windowStartedAt: "2026-07-29T00:00:00.000Z",
      lockedUntil: "2026-07-29T00:15:00.000Z",
    };
    const sql = statefulSql(() => rate, (values) => {
      rate = {
        windowStartedAt: values[2] as string,
        failedAttemptCount: 0,
        lockedUntil: null,
      };
    });
    const lease = issuePlatformTransaction(sql);
    try {
      const repository = new PostgresIdentityRepository();
      const locked = await repository.beginIdentityAuthentication(lease.transaction, {
        siteRef: "site-1", accountRef: "account-1", subjectRef: "subject-1",
        passwordCredentialEpoch: "7", transactionRef: "auth-1",
        initiatingCommandId: "1".repeat(32), requestDigest: "a".repeat(64),
        now: "2026-07-29T00:10:00.000Z", expiresAt: "2026-07-29T00:15:00.000Z",
      });
      expect(locked).toEqual({ kind: "locked" });

      const recovered = await repository.beginIdentityAuthentication(lease.transaction, {
        siteRef: "site-1", accountRef: "account-1", subjectRef: "subject-1",
        passwordCredentialEpoch: "7", transactionRef: "auth-2",
        initiatingCommandId: "2".repeat(32), requestDigest: "a".repeat(64),
        now: "2026-07-29T00:16:00.000Z", expiresAt: "2026-07-29T00:21:00.000Z",
      });
      expect(recovered).toEqual({ kind: "password_only" });
      expect(rate).toEqual({
        failedAttemptCount: 0,
        windowStartedAt: "2026-07-29T00:16:00.000Z",
        lockedUntil: null,
      });
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("keeps independent MFA transactions pending up to the bounded account capacity", async () => {
    const statements: string[] = [];
    const sql: PlatformSqlTransaction = {
      async query(statement) {
        statements.push(statement);
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes("identity_password_credential")) return [{ credentialEpoch: 7n }] as never;
        if (statement.includes("identity_auth_rate_limit")) return [];
        if (statement.includes("identity_totp_authenticator")) return [{ authenticatorRef: "totp-1" }] as never;
        if (statement.includes("identity_recovery_code_set")) return [];
        if (statement.includes('count(*)::integer AS "pendingCount"')) return [{ pendingCount: 1 }] as never;
        return [];
      },
      async execute(statement) {
        statements.push(statement);
        return 1;
      },
    };
    const lease = issuePlatformTransaction(sql);
    try {
      const result = await new PostgresIdentityRepository().beginIdentityAuthentication(lease.transaction, {
        siteRef: "site-1", accountRef: "account-1", subjectRef: "subject-1",
        passwordCredentialEpoch: "7", transactionRef: "auth-new",
        initiatingCommandId: "3".repeat(32), requestDigest: "a".repeat(64),
        now: "2026-07-29T00:01:00.000Z", expiresAt: "2026-07-29T00:06:00.000Z",
      });
      expect(result).toEqual({
        kind: "pending", transactionRef: "auth-new", challengeKind: "totp",
        expiresAt: "2026-07-29T00:06:00.000Z",
      });
      expect(statements.some((statement) => statement.includes("state='superseded'"))).toBe(false);
      expect(statements.some((statement) => statement.includes("expires_at<="))).toBe(true);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects a sixth pending MFA transaction without invalidating the existing five", async () => {
    const statements: string[] = [];
    const sql: PlatformSqlTransaction = {
      async query(statement) {
        statements.push(statement);
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (statement.includes("identity_password_credential")) return [{ credentialEpoch: 7n }] as never;
        if (statement.includes("identity_auth_rate_limit")) return [];
        if (statement.includes("identity_totp_authenticator")) return [{ authenticatorRef: "totp-1" }] as never;
        if (statement.includes("identity_recovery_code_set")) return [];
        if (statement.includes('count(*)::integer AS "pendingCount"')) return [{ pendingCount: 5 }] as never;
        return [];
      },
      async execute(statement) {
        statements.push(statement);
        return 1;
      },
    };
    const lease = issuePlatformTransaction(sql);
    try {
      const result = await new PostgresIdentityRepository().beginIdentityAuthentication(lease.transaction, {
        siteRef: "site-1", accountRef: "account-1", subjectRef: "subject-1",
        passwordCredentialEpoch: "7", transactionRef: "auth-six",
        initiatingCommandId: "4".repeat(32), requestDigest: "a".repeat(64),
        now: "2026-07-29T00:01:00.000Z", expiresAt: "2026-07-29T00:06:00.000Z",
      });
      expect(result).toEqual({ kind: "capacity_exceeded" });
      expect(statements.some((statement) => statement.includes("INSERT INTO platform.identity_auth_transaction"))).toBe(false);
      expect(statements.some((statement) => statement.includes("state='superseded'"))).toBe(false);
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});

function statefulSql(
  currentRate: () => { failedAttemptCount: number; windowStartedAt: string; lockedUntil: string | null } | null,
  writeRate: (values: readonly unknown[]) => void,
): PlatformSqlTransaction {
  return {
    async query(statement) {
      if (statement.includes("pg_advisory_xact_lock")) return [];
      if (statement.includes("identity_password_credential")) return [{ credentialEpoch: 7n }] as never;
      if (statement.includes("identity_auth_rate_limit")) {
        const rate = currentRate();
        return rate === null ? [] : [rate] as never;
      }
      if (statement.includes("identity_totp_authenticator") || statement.includes("identity_recovery_code_set")) return [];
      return [];
    },
    async execute(statement, values = []) {
      if (statement.includes("identity_auth_rate_limit")) writeRate(values);
      return 1;
    },
  };
}
