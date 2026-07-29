import { describe, expect, it } from "vitest";
import { signedCredentialDigest } from "../../src/modules/authorization/application/contracts/authorization-digest.js";
import { PostgresAdmissionSessionGrantOwner } from "../../src/modules/admission/infrastructure/postgres/admission-session-grant-owner.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
  type PlatformSqlTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";

class GrantSql implements PlatformSqlTransaction {
  rows: readonly Record<string, unknown>[] = [];
  statement = "";
  values: readonly unknown[] = [];

  async query<Row extends Record<string, unknown>>(
    statement: string,
    values: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.statement = statement;
    this.values = values;
    return this.rows as readonly Row[];
  }

  async execute(): Promise<number> { throw new Error("read only"); }
}

const input = {
  siteId: "site-a",
  projectRef: "project-a",
  sessionId: "session-a",
  runId: "run-a",
  configurationRevisionId: "release-a",
  credential: "signed-grant-a",
};

describe("Platform-local Admission SessionAccessGrant owner", () => {
  it("derives exact subject facts from a current delivered credential", async () => {
    const sql = new GrantSql();
    sql.rows = [{
      siteId: "site-a", projectRef: "project-a", subjectRef: "subject-a",
      subjectGeneration: 7n, resource: { kind: "run", sessionRef: "session-a", runRef: "run-a" },
    }];
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresAdmissionSessionGrantOwner().resolve(lease.transaction, input))
        .resolves.toEqual({
          kind: "resolved",
          value: { subjectRef: "subject-a", subjectGeneration: 7n },
        });
      expect(sql.values).toEqual([
        signedCredentialDigest("signed-grant-a"), "site-a", "project-a", "release-a",
      ]);
      expect(sql.statement).toContain("site.security_epoch=grant.site_security_epoch");
      expect(sql.statement).toContain("membership.authorization_epoch=grant.authorization_epoch");
      expect(sql.statement).toContain("grant.delivery_state='delivered'");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("fails closed for stale credentials and resources outside the requested Session/Run", async () => {
    const sql = new GrantSql();
    const lease = issuePlatformTransaction(sql);
    try {
      const owner = new PostgresAdmissionSessionGrantOwner();
      await expect(owner.resolve(lease.transaction, input)).resolves.toMatchObject({
        kind: "denied", denial: { code: "ADMISSION_SESSION_ACCESS_GRANT_NOT_AUTHORIZED" },
      });
      sql.rows = [{
        siteId: "site-a", projectRef: "project-a", subjectRef: "subject-a",
        subjectGeneration: 7n, resource: { kind: "session", sessionRef: "other-session" },
      }];
      await expect(owner.resolve(lease.transaction, input)).resolves.toMatchObject({
        kind: "denied", denial: { code: "ADMISSION_SESSION_ACCESS_GRANT_NOT_AUTHORIZED" },
      });
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});
