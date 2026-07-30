import { describe, expect, it } from "vitest";
import { PostgresCommerceAdministrationReader } from
  "../../src/modules/commerce/infrastructure/postgres/commerce-administration-reader.js";
import type { AdminQueryPermit } from
  "../../src/modules/admin/interfaces/connect/admin-query-service.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";

describe("PostgresCommerceAdministrationReader", () => {
  it("reads the complete typed CreditProgram revision only within the permitted Site", async () => {
    const statements: string[] = [];
    const lease = issuePlatformTransaction({ execute: async () => 0, query: async (statement) => {
      statements.push(statement);
      return [{ siteId: "site-1", creditProgramRevisionRef: "credits-v1", programRef: "credits",
        revision: 1n, uxBucketClass: "permanent", unit: "kokoro-credit", amount: "1000",
        burnPriority: 1000, scopePolicy: { version: 1, surfaceRefs: ["chat"],
          capabilityKeys: ["model.chat"], agentRefs: [], allowUnattributedAgent: true },
        liabilityMerchantAccountRef: "merchant:main", windowKind: "none", calendarZone: null,
        windowAnchor: null, expiresAfterSeconds: null, revisionDigest: "a".repeat(64),
        publishedAt: new Date("2026-07-30T01:00:00.000Z") }] as never;
    } });
    const reader = new PostgresCommerceAdministrationReader({
      adminQueryTransaction: async (_permit, work) => work(lease.transaction),
    });
    try {
      await expect(reader.getCreditProgramRevision(permit("commerce.credit-program.read"),
        "site-1", "credits-v1")).resolves.toMatchObject({
        siteId: "site-1", amount: "1000", scopePolicy: { version: 1 }, publishedAt: "2026-07-30T01:00:00.000Z",
      });
      expect(statements[0]).toContain("FROM platform.commerce_credit_program_revision");
      expect(() => reader.getCreditProgramRevision(permit("commerce.credit-program.read"),
        "site-2", "credits-v1")).toThrow("ADMIN_SITE_SCOPE_DENIED");
      expect(statements).toHaveLength(1);
    } finally { revokePlatformTransaction(lease); }
  });

  it("lists EntitlementTemplate revisions with a stable Site-scoped watermark", async () => {
    const statements: string[] = [];
    const lease = issuePlatformTransaction({ execute: async () => 0, query: async (statement) => {
      statements.push(statement);
      return [{ siteId: "site-1", entitlementTemplateRevisionRef: "premium-v1",
        templateRef: "premium", revision: "1", capabilityKey: "chat.premium",
        safeLabel: "Premium chat", expiresAfterSeconds: "3600", revisionDigest: "b".repeat(64),
        publishedAt: "2026-07-30T01:00:00.000Z" }] as never;
    } });
    const reader = new PostgresCommerceAdministrationReader({
      adminQueryTransaction: async (_permit, work) => work(lease.transaction),
    });
    try {
      await expect(reader.listEntitlementTemplateRevisions(permit("commerce.entitlement-template.read"), {
        siteId: "site-1", afterRef: null, watermark: "2026-07-30T02:00:00.000Z", limit: 10,
      })).resolves.toMatchObject([{ entitlementTemplateRevisionRef: "premium-v1",
        expiresAfterSeconds: 3600n }]);
      expect(statements[0]).toContain("revision.published_at<=$3::timestamptz");
    } finally { revokePlatformTransaction(lease); }
  });
});

function permit(operation: string): AdminQueryPermit {
  return { operatorRef: "operator:1", environment: "production", region: "us-east-1",
    operation, scope: { kind: "site", siteRefs: ["site-1"] } } as AdminQueryPermit;
}
