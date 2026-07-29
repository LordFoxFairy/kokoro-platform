import { describe, expect, it } from "vitest";
import {
  PlatformUnitOfWork,
  type PlatformTransactionHost,
} from "../../src/shared/unit-of-work/unit-of-work.js";
import {
  issuePlatformTransaction,
  resolvePlatformTransaction,
  revokePlatformTransaction,
  type PlatformSqlTransaction,
  type PlatformTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";
import {
  parseRequestSecurityContext,
  verifyRequestSecurityContext,
} from "../../src/shared/security-context/request-security-context.js";

describe("PlatformUnitOfWork", () => {
  it("exposes only an opaque transaction and revokes it after commit", async () => {
    let captured: PlatformTransaction | undefined;
    const sql: PlatformSqlTransaction = {
      query: async () => [],
      execute: async () => 0,
    };
    const host: PlatformTransactionHost = {
      transaction: async (_fence, work) => {
        const lease = issuePlatformTransaction(sql);
        try {
          return await work(lease.transaction);
        } finally {
          captured = lease.transaction;
          revokePlatformTransaction(lease);
        }
      },
    };

    const unitOfWork = new PlatformUnitOfWork(host, () => "2026-07-28T00:05:00.000Z");
    const context = await transactionContext();
    await expect(unitOfWork.execute({ context, operation: "test.write" }, async (transaction) => Object.keys(transaction))).resolves.toEqual([]);
    await expect(unitOfWork.execute({ context, operation: "test.write" }, async () => Promise.reject(new Error("DOMAIN_FAILURE")))).rejects.toThrow(
      "DOMAIN_FAILURE",
    );
    expect(captured).toBeDefined();
    expect(() => resolvePlatformTransaction(captured!)).toThrowError("PLATFORM_TRANSACTION_NOT_ACTIVE");
    const expiredUnitOfWork = new PlatformUnitOfWork(host, () => "2026-07-29T00:00:00.000Z");
    await expect(expiredUnitOfWork.execute({ context, operation: "test.write" }, async () => undefined)).rejects.toThrow("REQUEST_SECURITY_CONTEXT_EXPIRED");
  });

  it("rejects a structurally valid but unverified context", async () => {
    const host: PlatformTransactionHost = { transaction: async () => { throw new Error("MUST_NOT_OPEN_TRANSACTION"); } };
    const unitOfWork = new PlatformUnitOfWork(host, () => "2026-07-28T00:05:00.000Z");
    const unverified = parseRequestSecurityContext(transactionContextInput());
    await expect(unitOfWork.execute({ context: unverified as never, operation: "test.write" }, async () => undefined)).rejects.toThrow("REQUEST_SECURITY_CONTEXT_NOT_VERIFIED");
  });
});

async function transactionContext() {
  return verifyRequestSecurityContext(transactionContextInput(), {
    now: "2026-07-28T00:05:00.000Z", operation: "test.write", expectedAudience: "platform", expectedEnvironment: "test", expectedRegion: "local",
    callerVerifier: { verify: async () => ({ workloadIdentityId: "worker", kind: "platform_worker", audience: "platform", environment: "test", region: "local", allowedOperations: ["test.write"], siteId: null, bindingEpoch: "1", issuedAt: "2026-07-28T00:00:00.000Z", expiresAt: "2026-07-29T00:00:00.000Z", issuer: "spiffe://kokoro.test", keyVersion: "ca-1" }) },
  });
}

function transactionContextInput() { return { requestId: "req", correlationId: "corr", trustedCaller: { kind: "platform_worker", workloadIdentityId: "worker", environment: "test", region: "local", audience: "platform", allowedOperations: ["test.write"], bindingEpoch: "1", issuedAt: "2026-07-28T00:00:00.000Z", expiresAt: "2026-07-29T00:00:00.000Z" }, actor: { kind: "workload", subjectId: "worker", subjectGeneration: "1" }, delegatedGrant: null, target: { siteId: null, workspaceId: null, projectId: null, purpose: "test", scopes: [] }, audience: "platform", environment: "test", region: "local", evidence: [{ kind: "workload_attestation", evidenceId: "ev", issuer: "spiffe://kokoro.test" }], policyEpoch: "1", issuedAt: "2026-07-28T00:00:00.000Z", expiresAt: "2026-07-29T00:00:00.000Z" }; }
