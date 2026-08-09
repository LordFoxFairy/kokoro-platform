import { describe, expect, it } from "vitest";
import { createCommerceCommandAuthorization } from "../../src/modules/commerce/application/command-authorization.js";
import { PostgresCommerceCommandAuthorityReader } from "../../src/modules/commerce/infrastructure/postgres/command-authority-reader.js";
import { issuePlatformTransaction, revokePlatformTransaction, type PlatformSqlTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";
import { verifyRequestSecurityContext } from "../../src/shared/security-context/request-security-context.js";

const authorization = createCommerceCommandAuthorization(
  new PostgresCommerceCommandAuthorityReader(),
);

describe("Commerce effect-point authorization", () => {
  it("fails closed when the verified context has no boundary-issued CSRF evidence", async () => {
    const sql: PlatformSqlTransaction = { query: async () => { throw new Error("MUST_NOT_QUERY"); }, execute: async () => 0 };
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(authorization.authorizeCommand(lease.transaction, await context(false), "confirmRedemption", "2026-07-28T00:05:00.000Z")).rejects.toThrow("COMMERCE_EFFECT_NOT_AUTHORIZED");
    } finally { revokePlatformTransaction(lease); }
  });

  it("locks and rechecks binding, Site, Release, subject and session epochs", async () => {
    const statements: string[] = [];
    const sql: PlatformSqlTransaction = {
      query: async (statement) => { statements.push(statement); return [{ siteId: "site-1", releaseRef: "release-1", subjectId: "user-1", bindingEpoch: 2n, securityEpoch: 7n, policyEpoch: 6n, subjectGeneration: 3n, restrictionEpoch: 5n, sessionEpoch: 4n, bindingState: "active", siteState: "active", releaseState: "active", subjectState: "active", sessionState: "active", environment: "production", region: "us-east-1", audience: "platform-public", expiresAt: new Date("2026-07-29T00:00:00.000Z") }] as never; },
      execute: async () => 0,
    };
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(authorization.authorizeCommand(lease.transaction, await context(true), "confirmRedemption", "2026-07-28T00:05:00.000Z")).resolves.toMatchObject({ siteId: "site-1", releaseRef: "release-1" });
      expect(statements[0]).toContain(
        "FROM platform.lock_commerce_command_authority($1,$2,$3,$4)",
      );
    } finally { revokePlatformTransaction(lease); }
  });

  it("rejects a stale Site security epoch after taking the authority locks", async () => {
    const sql: PlatformSqlTransaction = {
      query: async () => [{ siteId: "site-1", releaseRef: "release-1", subjectId: "user-1", bindingEpoch: 2n, securityEpoch: 8n, policyEpoch: 6n, subjectGeneration: 3n, restrictionEpoch: 5n, sessionEpoch: 4n, bindingState: "active", siteState: "active", releaseState: "active", subjectState: "active", sessionState: "active", environment: "production", region: "us-east-1", audience: "platform-public", expiresAt: new Date("2026-07-29T00:00:00.000Z") }] as never,
      execute: async () => 0,
    };
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(authorization.authorizeCommand(lease.transaction, await context(true), "confirmRedemption", "2026-07-28T00:05:00.000Z")).rejects.toThrow("COMMERCE_EFFECT_NOT_AUTHORIZED");
    } finally { revokePlatformTransaction(lease); }
  });
});

async function context(csrf: boolean) { return verifyRequestSecurityContext({ requestId: "req", correlationId: "corr", trustedCaller: { kind: "site_product", workloadIdentityId: "site-web-1", siteId: "site-1", siteReleaseRef: "release-1", siteSecurityEpoch: "7", environment: "production", region: "us-east-1", audience: "platform-public", allowedOperations: ["confirmRedemption"], bindingEpoch: "2", issuedAt: "2026-07-28T00:00:00.000Z", expiresAt: "2026-07-29T00:00:00.000Z" }, actor: { kind: "user", subjectId: "user-1", subjectGeneration: "3", sessionId: "session-1", sessionEpoch: "4", restrictionEpoch: "5" }, delegatedGrant: null, target: { siteId: "site-1", workspaceId: null, projectId: null, purpose: "confirmRedemption", scopes: [] }, audience: "platform-public", environment: "production", region: "us-east-1", evidence: [...(csrf ? [{ kind: "csrf_verification", evidenceId: "c".repeat(64), issuer: "kokoro-platform-public" }] : []), { kind: "workload_attestation", evidenceId: "attestation", issuer: "spiffe://kokoro.test" }], policyEpoch: "6", issuedAt: "2026-07-28T00:00:00.000Z", expiresAt: "2026-07-29T00:00:00.000Z" }, { now: "2026-07-28T00:05:00.000Z", operation: "confirmRedemption", expectedAudience: "platform-public", expectedEnvironment: "production", expectedRegion: "us-east-1", callerVerifier: { verify: async () => ({ workloadIdentityId: "site-web-1", kind: "site_product", audience: "platform-public", environment: "production", region: "us-east-1", allowedOperations: ["confirmRedemption"], siteId: "site-1", siteReleaseRef: "release-1", siteSecurityEpoch: "7", bindingEpoch: "2", issuedAt: "2026-07-28T00:00:00.000Z", expiresAt: "2026-07-29T00:00:00.000Z", issuer: "spiffe://kokoro.test", keyVersion: "ca-1" }) } }); }
