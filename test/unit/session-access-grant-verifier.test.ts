import { describe, expect, it } from "vitest";
import { signedCredentialDigest } from "../../src/modules/authorization/application/contracts/authorization-digest.js";
import { PostgresSessionAccessGrantVerifier } from
  "../../src/modules/authorization/infrastructure/postgres/session-access-grant-verifier.js";
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

describe("Platform SessionAccessGrant verifier", () => {
  it("derives current owner and resource facts from only the opaque delivered credential", async () => {
    const sql = new GrantSql();
    sql.rows = [{
      siteId: "site-a", siteReleaseRef: "release-a", projectRef: "project-a",
      subjectRef: "subject-a", subjectGeneration: 7n,
      identitySessionRef: "identity-session-a",
      resource: { kind: "session", sessionRef: "session-a" },
    }];
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresSessionAccessGrantVerifier().verify(lease.transaction, {
        siteId: "site-a", credential: "signed-grant-a", purpose: "write",
        environment: "production", region: "us-east-1",
      })).resolves.toEqual({
        siteId: "site-a", siteReleaseRef: "release-a", projectRef: "project-a",
        subjectRef: "subject-a", subjectGeneration: 7n,
        identitySessionRef: "identity-session-a",
        resource: { kind: "session", sessionRef: "session-a" },
      });
      expect(sql.values).toEqual([
        signedCredentialDigest("signed-grant-a"), "site-a", "write", "session.write",
        "production", "us-east-1",
      ]);
      for (const fragment of [
        "site.security_epoch=access_grant.site_security_epoch",
        "membership.authorization_epoch=access_grant.authorization_epoch",
        "access_grant.delivery_state='delivered'",
        "identity_session.expires_at>statement_timestamp()",
        "release.state='active'",
      ]) expect(sql.statement).toContain(fragment);
      expect(sql.statement).toContain("AS access_grant");
      expect(sql.statement).not.toMatch(/\bAS\s+grant\b/iu);
      expect(sql.statement).not.toMatch(
        /FOR\s+(?:NO\s+KEY\s+)?UPDATE|FOR\s+(?:KEY\s+)?SHARE/iu,
      );
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("returns one indistinguishable rejection for stale grants and rejects malformed owner facts", async () => {
    const sql = new GrantSql();
    const lease = issuePlatformTransaction(sql);
    try {
      const verifier = new PostgresSessionAccessGrantVerifier();
      await expect(verifier.verify(lease.transaction, {
        siteId: "site-a", credential: "signed-grant-a", purpose: "write",
        environment: "production", region: "us-east-1",
      })).resolves.toBeNull();
      sql.rows = [{
        siteId: "site-a", siteReleaseRef: "release-a", projectRef: "project-a",
        subjectRef: "subject-a", subjectGeneration: 0n,
        identitySessionRef: "identity-session-a",
        resource: { kind: "session", sessionRef: "session-a" },
      }];
      await expect(verifier.verify(lease.transaction, {
        siteId: "site-a", credential: "signed-grant-a", purpose: "write",
        environment: "production", region: "us-east-1",
      })).rejects.toThrow("SESSION_ACCESS_GRANT_OWNER_CORRUPT");
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});
