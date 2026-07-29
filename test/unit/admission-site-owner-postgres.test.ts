import { describe, expect, it } from "vitest";
import { PostgresAdmissionSiteOwner } from "../../src/modules/admission/infrastructure/postgres/admission-site-owner.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
  type PlatformSqlTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";

class SiteSql implements PlatformSqlTransaction {
  row?: Record<string, unknown>;
  async query<Row extends Record<string, unknown>>(): Promise<readonly Row[]> {
    return this.row === undefined ? [] : [this.row as Row];
  }
  async execute(): Promise<number> { throw new Error("read only"); }
}

describe("Postgres Admission Site owner", () => {
  it("resolves the active release only for an active Site project and allowed locale", async () => {
    const sql = new SiteSql();
    sql.row = {
      siteId: "site-1",
      projectRef: "project-1",
      configurationRevisionId: "release-1",
      policyDecisionRef: "feature-policy-7",
      localePolicy: { defaultLocale: "en-US", allowedLocales: ["en-US", "zh-CN"] },
    };
    const lease = issuePlatformTransaction(sql);
    try {
      const owner = new PostgresAdmissionSiteOwner();
      await expect(owner.resolve(lease.transaction, {
        siteId: "site-1", projectRef: "project-1", locale: "zh-CN",
      })).resolves.toEqual({
        kind: "resolved",
        value: { configurationRevisionId: "release-1", policyDecisionRef: "feature-policy-7" },
      });
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("denies an unknown project or locale without a default-Site fallback", async () => {
    const sql = new SiteSql();
    const lease = issuePlatformTransaction(sql);
    try {
      const owner = new PostgresAdmissionSiteOwner();
      await expect(owner.resolve(lease.transaction, {
        siteId: "site-1", projectRef: "project-missing", locale: "en-US",
      })).resolves.toMatchObject({
        kind: "denied", denial: { code: "ADMISSION_SITE_PROJECT_NOT_ACTIVE" },
      });

      sql.row = {
        siteId: "site-1", projectRef: "project-1", configurationRevisionId: "release-1",
        policyDecisionRef: "feature-policy-7",
        localePolicy: { defaultLocale: "en-US", allowedLocales: ["en-US"] },
      };
      await expect(owner.resolve(lease.transaction, {
        siteId: "site-1", projectRef: "project-1", locale: "fr-FR",
      })).resolves.toMatchObject({
        kind: "denied", denial: { code: "ADMISSION_SITE_LOCALE_NOT_ALLOWED" },
      });
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});
