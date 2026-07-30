import { describe, expect, it } from "vitest";
import { PostgresCommerceAdministrationReader } from
  "../../src/modules/commerce/infrastructure/postgres/commerce-administration-reader.js";
import type { AdminQueryPermit } from
  "../../src/modules/admin/interfaces/connect/admin-query-service.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";

describe("PostgresCommerceAdministrationReader", () => {
  it("observes a committed catalog epoch and an independent database clock", async () => {
    const statements: string[] = [];
    const lease = issuePlatformTransaction({ execute: async () => 0, query: async (statement) => {
      statements.push(statement);
      return [{ watermark: "41", observedAt: new Date("2026-07-30T02:00:00.000Z") }] as never;
    } });
    const reader = new PostgresCommerceAdministrationReader({
      adminQueryTransaction: async (_permit, work) => work(lease.transaction),
    });
    try {
      await expect(reader.observeCatalog(permit("commerce.credit-program.read")))
        .resolves.toEqual({ watermark: "41", observedAt: "2026-07-30T02:00:00.000Z" });
      expect(statements).toEqual([expect.stringContaining("commerce_catalog_epoch_authority")]);
      expect(statements[0]).toContain("clock_timestamp()");
    } finally { revokePlatformTransaction(lease); }
  });

  it("reads the complete typed CreditProgram revision only within the permitted Site", async () => {
    const statements: string[] = [];
    const lease = issuePlatformTransaction({ execute: async () => 0, query: async (statement) => {
      statements.push(statement);
      return [{ siteId: "site-1", creditProgramRevisionRef: "credits-v1", programRef: "credits",
        revision: 1n, uxBucketClass: "permanent", unit: "kokoro-credit", amount: "1000",
        burnPriority: 1000, scopePolicy: { version: 1, surfaceRefs: ["chat"],
          capabilityKeys: ["model.chat"], agentRefs: [], allowUnattributedAgent: true },
        liabilityMerchantAccountRef: "merchant:main", windowKind: "none", calendarZone: null,
        windowAnchor: null, rolloverPolicy: "none", expiresAfterSeconds: null,
        revisionDigest: "a".repeat(64),
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
        siteId: "site-1", afterRef: null, watermark: "41", limit: 10,
      })).resolves.toMatchObject([{ entitlementTemplateRevisionRef: "premium-v1",
        expiresAfterSeconds: 3600n }]);
      expect(statements[0]).toContain("revision.catalog_epoch<=$3::bigint");
    } finally { revokePlatformTransaction(lease); }
  });

  it("does not phantom a writer that allocated the next epoch but committed after page one", async () => {
    const writerEpoch = 42n; let writerCommitted = false; const statements: string[] = [];
    const lease = issuePlatformTransaction({ execute: async () => 0, query: async (statement, parameters) => {
      statements.push(statement);
      if (statement.includes("commerce_catalog_epoch_authority")) {
        return [{ watermark: "41", observedAt: "2026-07-30T02:00:00.000Z" }] as never;
      }
      const watermark = BigInt(String(parameters?.[2]));
      return writerCommitted && writerEpoch <= watermark ? [{ entitlementTemplateRevisionRef: "late-v1" }] as never : [];
    } });
    const reader = new PostgresCommerceAdministrationReader({
      adminQueryTransaction: async (_permit, work) => work(lease.transaction),
    });
    try {
      const firstPage = await reader.observeCatalog(permit("commerce.entitlement-template.read"));
      writerCommitted = true;
      await expect(reader.listEntitlementTemplateRevisions(permit("commerce.entitlement-template.read"), {
        siteId: "site-1", afterRef: null, watermark: firstPage.watermark, limit: 10,
      })).resolves.toEqual([]);
      expect(firstPage.watermark).toBe("41");
      expect(statements[1]).toContain("revision.catalog_epoch<=$3::bigint");
    } finally { revokePlatformTransaction(lease); }
  });

  it.each(["-1", "01", "9223372036854775808", "2026-07-30T02:00:00.000Z"])(
    "rejects a non-canonical catalog watermark (%s)", (watermark) => {
      const reader = new PostgresCommerceAdministrationReader({ adminQueryTransaction: async () => {
        throw new Error("MUST_NOT_OPEN_TRANSACTION");
      } });
      expect(() => reader.listOffers(permit("commerce.offer.read"), {
        siteId: "site-1", afterRef: null, watermark, limit: 10,
      })).toThrow("COMMERCE_ADMIN_PAGE_INVALID");
    },
  );
});

function permit(operation: string): AdminQueryPermit {
  return { operatorRef: "operator:1", environment: "production", region: "us-east-1",
    operation, scope: { kind: "site", siteRefs: ["site-1"] } } as AdminQueryPermit;
}
