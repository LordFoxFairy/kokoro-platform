import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Site admin production composition", () => {
  it("wires maker-checker and owner mutations locally without Platform self-RPC", async () => {
    const [composition, admin] = await Promise.all([
      readFile(resolve("src/process/site-admin-composition.ts"), "utf8"),
      readFile(resolve("src/process/admin.ts"), "utf8"),
    ]);
    expect(composition).toContain("new PostgresSiteEffectApprovalAuthority");
    expect(composition).toContain("new SiteEffectApprovalService");
    expect(composition).toContain("new SiteLifecycleService");
    expect(composition).toContain("new SiteTrafficStopService");
    expect(composition).toContain("new SiteDangerousAdminHandler");
    expect(composition).not.toMatch(/fetch\(|http:\/\/|https:\/\//u);
    expect(admin).toContain("createPlatformSiteAdminComposition(database)");
  });
});
