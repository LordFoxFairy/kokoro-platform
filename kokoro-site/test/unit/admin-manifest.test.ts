import { describe, expect, it } from "vitest";
import { siteAdminManifest } from "../../src/interfaces/admin/manifest.js";
import { adminModuleManifestSchema } from "../../src/interfaces/admin/schema.js";
import { sitePlatformModule } from "../../src/module.js";

describe("siteAdminManifest", () => {
  it("matches the local admin manifest schema", () => {
    const parsed = adminModuleManifestSchema.parse(siteAdminManifest);

    expect(parsed.id).toBe("kokoro-site");
    expect(parsed.resources.map((resource) => resource.id)).toEqual([
      "sites",
      "domains",
      "apps",
      "policies",
    ]);
  });

  it("keeps platform module metadata aligned with the admin manifest", () => {
    expect(sitePlatformModule.admin).toMatchObject({
      mode: "manifest",
      basePath: siteAdminManifest.basePath,
      manifestExport: "siteAdminManifest",
    });
    expect(sitePlatformModule.storage.databaseEnv).toBe("DATABASE_URL_SITE");
  });
});
