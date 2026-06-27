import { describe, expect, it } from "vitest";
import { adminModuleManifestSchema } from "../src/admin/manifest-schema.js";

describe("adminModuleManifestSchema", () => {
  it("accepts resources and optional nav items", () => {
    const parsed = adminModuleManifestSchema.parse({
      id: "kokoro-user",
      labelKey: "admin.modules.user",
      basePath: "/admin/users",
      requiredPermission: "user.admin",
      navItems: [
        {
          id: "users",
          labelKey: "admin.user.resources.users",
          route: "/admin/users",
          requiredPermission: "user.read",
        },
      ],
      resources: [
        {
          id: "users",
          labelKey: "admin.user.resources.users",
          route: "/admin/users",
          requiredPermission: "user.read",
        },
      ],
    });

    expect(parsed.navItems).toHaveLength(1);
    expect(parsed.resources[0]?.actions).toEqual([]);
  });
});
