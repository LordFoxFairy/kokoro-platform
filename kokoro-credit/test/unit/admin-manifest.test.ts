import { describe, expect, it } from "vitest";
import { creditAdminManifest } from "../../src/interfaces/admin/manifest.js";
import { adminModuleManifestSchema } from "../../src/interfaces/admin/schema.js";
import { creditPlatformModule } from "../../src/module.js";

describe("credit admin manifest", () => {
  it("matches the local admin manifest schema and platform metadata", () => {
    const parsed = adminModuleManifestSchema.parse(creditAdminManifest);

    expect(parsed.resources.map((resource) => resource.id)).toEqual([
      "credit-accounts",
      "ledger-entries",
      "usage-records",
      "pricing-rules",
    ]);
    expect(creditPlatformModule.admin).toMatchObject({
      mode: "manifest",
      basePath: creditAdminManifest.basePath,
      manifestExport: "creditAdminManifest",
    });
  });
});
