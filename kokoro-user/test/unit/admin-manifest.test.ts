import { describe, expect, it } from "vitest";
import { userAdminManifest } from "../../src/interfaces/admin/manifest.js";
import { adminModuleManifestSchema } from "../../src/interfaces/admin/schema.js";
import { userPlatformModule } from "../../src/module.js";

describe("userAdminManifest", () => {
  it("matches the local admin manifest schema", () => {
    const parsed = adminModuleManifestSchema.parse(userAdminManifest);

    expect(parsed.id).toBe("kokoro-user");
    expect(parsed.resources.map((resource) => resource.id)).toEqual([
      "users",
      "teams",
      "memberships",
      "service-accounts",
    ]);
  });

  it("keeps platform module metadata aligned with the admin manifest", () => {
    expect(userPlatformModule.admin).toMatchObject({
      mode: "manifest",
      basePath: userAdminManifest.basePath,
      manifestExport: "userAdminManifest",
    });
    expect(userPlatformModule.storage.databaseEnv).toBe("DATABASE_URL_USER");
  });
});
