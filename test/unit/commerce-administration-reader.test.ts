import { describe, expect, it } from "vitest";
import { PostgresCommerceAdministrationReader } from
  "../../src/modules/commerce/infrastructure/postgres/commerce-administration-reader.js";
import type { AdminQueryPermit } from
  "../../src/modules/admin/interfaces/connect/admin-query-service.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import { PostgresCreditGrantProgramAdministrationReader } from
  "../../src/modules/commerce/infrastructure/postgres/credit-program-administration-reader.js";

describe("PostgresCommerceAdministrationReader", () => {
  it("observes a committed catalog epoch and an independent database clock", async () => {
    const statements: string[] = [];
    const lease = issuePlatformTransaction({ execute: async () => 0, query: async (statement) => {
      statements.push(statement);
      return [{ watermark: "41", observedAt: new Date("2026-07-30T02:00:00.000Z") }] as never;
    } });
    const host = queryHost(lease.transaction);
    const reader = new PostgresCommerceAdministrationReader(host,
      new PostgresCreditGrantProgramAdministrationReader(host));
    try {
      await expect(reader.observeCatalog(permit("commerce.credit-program.read"), "site-1"))
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
    const host = queryHost(lease.transaction);
    const reader = new PostgresCommerceAdministrationReader(host,
      new PostgresCreditGrantProgramAdministrationReader(host));
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

  it("accepts a persisted daily CreditProgram with no relative expiry", async () => {
    const lease = issuePlatformTransaction({ execute: async () => 0, query: async () => [{
      siteId: "site-1", creditProgramRevisionRef: "daily-v1", programRef: "daily",
      revision: "1", uxBucketClass: "daily", unit: "credit", amount: "10", burnPriority: 1,
      scopePolicy: { version: 1, surfaceRefs: ["chat"], capabilityKeys: ["chat.generate"],
        agentRefs: [], allowUnattributedAgent: true }, liabilityMerchantAccountRef: "merchant:main",
      windowKind: "daily", calendarZone: "America/New_York", windowAnchor: "daily@00:00:00",
      rolloverPolicy: "none", expiresAfterSeconds: null, revisionDigest: "d".repeat(64),
      publishedAt: "2026-07-30T01:00:00.000Z",
    }] as never });
    const host = queryHost(lease.transaction);
    const reader = new PostgresCommerceAdministrationReader(host,
      new PostgresCreditGrantProgramAdministrationReader(host));
    try {
      await expect(reader.getCreditProgramRevision(permit("commerce.credit-program.read"),
        "site-1", "daily-v1")).resolves.toMatchObject({ uxBucketClass: "daily",
        expiresAfterSeconds: null });
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
    const host = queryHost(lease.transaction);
    const reader = new PostgresCommerceAdministrationReader(host,
      new PostgresCreditGrantProgramAdministrationReader(host));
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
    const host = queryHost(lease.transaction);
    const reader = new PostgresCommerceAdministrationReader(host,
      new PostgresCreditGrantProgramAdministrationReader(host));
    try {
      const firstPage = await reader.observeCatalog(permit("commerce.entitlement-template.read"), "site-1");
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
      const host = { adminSiteQueryTransaction: async () => {
        throw new Error("MUST_NOT_OPEN_TRANSACTION");
      } } as ConstructorParameters<typeof PostgresCommerceAdministrationReader>[0];
      const reader = new PostgresCommerceAdministrationReader(host,
        new PostgresCreditGrantProgramAdministrationReader(host));
      expect(() => reader.listOffers(permit("commerce.offer.read"), {
        siteId: "site-1", afterRef: null, watermark, limit: 10,
      })).toThrow("COMMERCE_ADMIN_PAGE_INVALID");
    },
  );

  it("hydrates the complete Plan join and credit_program_enrollment output", async () => {
    const statements: string[] = [];
    const lease = issuePlatformTransaction({ execute: async () => 0, query: async (statement) => {
      statements.push(statement);
      return [{ siteId: "site-1", productRef: "subscription", productKind: "subscription",
        productVersionRef: "subscription-v1", revision: "1", safeLabel: "Subscription",
        planVersionRef: "plan-v1", planRef: "plan", planRevision: "1",
        planSafeLabel: "Monthly plan", planTermAction: "new_subscription",
        planTermSeconds: "2592000", planStackingScope: "account",
        planRevisionDigest: "c".repeat(64), fulfillmentProgramRevisionRef: "fulfillment-v1",
        outputs: [{ outputLineId: "credits", ordinal: 1, cardinality: 1,
          outputKind: "credit_program_enrollment", targetRevisionRef: "credits-daily-v1" }],
        legalTermRefs: [], publishedAt: "2026-07-30T01:00:00.000Z" }] as never;
    } });
    const host = queryHost(lease.transaction);
    const reader = new PostgresCommerceAdministrationReader(host,
      new PostgresCreditGrantProgramAdministrationReader(host));
    try {
      await expect(reader.getOffer(permit("commerce.offer.read"), "site-1", "subscription-v1"))
        .resolves.toMatchObject({
          planVersion: { planVersionRef: "plan-v1", termSeconds: 2_592_000n,
            revisionDigest: "c".repeat(64) },
          outputs: [{ outputKind: "credit_program_enrollment",
            targetRevisionRef: "credits-daily-v1" }],
        });
      expect(statements[0]).toContain("JOIN platform.commerce_catalog_plan_version plan");
      expect(statements[0]).toContain("output.credit_program_revision_ref");
    } finally { revokePlatformTransaction(lease); }
  });

  it("fails closed on an unknown RedemptionProgram availability state", async () => {
    const lease = issuePlatformTransaction({ execute: async () => 0, query: async () => [{
      siteId: "site-1", redemptionProgramRevisionRef: "redemption-v1", programRef: "redemption",
      revision: "1", productVersionRef: "offer-v1", fulfillmentProgramRevisionRef: "fulfillment-v1",
      maxRedemptionsPerAccount: 1, availabilityState: "deleted",
      publishedAt: "2026-07-30T01:00:00.000Z",
    }] as never });
    const host = queryHost(lease.transaction);
    const reader = new PostgresCommerceAdministrationReader(host,
      new PostgresCreditGrantProgramAdministrationReader(host));
    try {
      await expect(reader.getRedemptionProgram(permit("commerce.redemption-program.read"),
        "site-1", "redemption-v1")).rejects.toThrow("COMMERCE_ADMIN_ROW_CORRUPT");
    } finally { revokePlatformTransaction(lease); }
  });
});

function permit(operation: string): AdminQueryPermit {
  return { operatorRef: "operator:1", environment: "production", region: "us-east-1",
    operation, authorityBindingDigest: "a".repeat(64),
    scope: { kind: "site", siteRefs: ["site-1"] } } as AdminQueryPermit;
}

function queryHost(transaction: ReturnType<typeof issuePlatformTransaction>["transaction"]) {
  return {
    adminSiteQueryTransaction: async (_permit: AdminQueryPermit, _siteId: string,
      work: (value: typeof transaction) => Promise<unknown>) => work(transaction),
  } as ConstructorParameters<typeof PostgresCommerceAdministrationReader>[0];
}
