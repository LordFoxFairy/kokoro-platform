import { describe, expect, it } from "vitest";
import { AccountReadService } from "../../src/modules/commerce/application/services/account-read.js";
import type { AccountReadRepository } from "../../src/modules/commerce/application/contracts/account-read-repository.js";
import { issuePlatformTransaction, revokePlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";
import type { VerifiedRequestSecurityContext } from "../../src/shared/security-context/index.js";

describe("AccountReadService", () => {
  it("revalidates current authority in the read transaction before applying exact account scope", async () => {
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
    const calls: string[] = [];
    const repository = repositoryStub({
      getCreditGrant: async (_transaction, input) => {
        calls.push("query");
        expect(input).toEqual({ siteId: "site-1", subjectId: "subject-1", subjectGeneration: "2", grantId: "grant-1" });
        return { freshness: freshness(), grant: {} } as never;
      },
    });
    const service = new AccountReadService({
      repository,
      unitOfWork: { execute: async (_fence, work) => work(lease.transaction) },
      authorizeRead: async (_transaction, _context, operation) => {
        calls.push(`authorize:${operation}`);
        return { siteId: "site-1", releaseRef: "release-1", subjectId: "subject-1" };
      },
    });
    try {
      await service.getCreditGrant({ context: context("getCreditGrant"), grantId: "grant-1" });
      expect(calls).toEqual(["authorize:getCreditGrant", "query"]);
    } finally { revokePlatformTransaction(lease); }
  });

  it("returns the same non-disclosing not-found error for an unowned grant or usage", async () => {
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
    const service = new AccountReadService({
      repository: repositoryStub(), unitOfWork: { execute: async (_fence, work) => work(lease.transaction) },
      authorizeRead: async () => ({ siteId: "site-1", releaseRef: "release-1", subjectId: "subject-1" }),
    });
    try {
      await expect(service.getCreditGrant({ context: context("getCreditGrant"), grantId: "missing" }))
        .rejects.toMatchObject({ code: "ACCOUNT_RESOURCE_NOT_FOUND" });
      await expect(service.getUsageDetail({ context: context("getUsageDetail"), usageId: "missing" }))
        .rejects.toMatchObject({ code: "ACCOUNT_RESOURCE_NOT_FOUND" });
    } finally { revokePlatformTransaction(lease); }
  });
});

function repositoryStub(overrides: Partial<AccountReadRepository> = {}): AccountReadRepository {
  return {
    getCreditGrant: async () => null,
    getCreditSummary: async () => ({ activeHoldCount: 0, freshness: freshness(), units: [] }),
    getUsageDetail: async () => null,
    listAccountProducts: async () => ({ freshness: freshness(), products: [] }),
    ...overrides,
  };
}
function freshness() { return { asOf: "2026-07-29T01:00:00.000Z", lagSeconds: 0, revision: "1", state: "current" as const }; }
function context(purpose: "getCreditGrant" | "getUsageDetail"): VerifiedRequestSecurityContext {
  return {
    environment: "test", region: "local", audience: "site-1",
    trustedCaller: { kind: "site_product", siteId: "site-1", workloadIdentityId: "workload-1", siteReleaseRef: "release-1" },
    actor: { kind: "user", subjectId: "subject-1", subjectGeneration: "2" },
    target: { siteId: "site-1", purpose },
  } as VerifiedRequestSecurityContext;
}
