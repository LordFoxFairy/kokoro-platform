import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Site lifecycle production provider", () => {
  it("registers the typed Site owner on the single Admin mTLS listener", async () => {
    const [admin, composition] = await Promise.all([
      readFile(resolve("src/process/admin.ts"), "utf8"),
      readFile(resolve("src/process/admin-composition.ts"), "utf8"),
    ]);
    expect(admin).not.toMatch(/createPlatformSiteAdminComposition\(database\);/u);
    expect(composition).toContain("createPlatformSiteAdminComposition(input.database, authorizationEventSigner)");
    expect(composition).toContain("router.service(SiteLifecycleService");
    expect(composition).not.toMatch(/fetch\(|http:\/\/|https:\/\//u);
  });
});
