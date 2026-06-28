import { describe, expect, it } from "vitest";
import {
  adminActionManifestSchema,
  adminModuleManifestSchema,
  adminNavItemManifestSchema,
  adminResourceManifestSchema,
} from "../src/admin/manifest-schema.js";

const validModule = {
  id: "kokoro-user",
  labelKey: "admin.modules.user",
  basePath: "/admin/users",
  requiredPermission: "user.admin",
};

describe("adminModuleManifestSchema", () => {
  it("accepts resources and optional nav items", () => {
    const parsed = adminModuleManifestSchema.parse({
      ...validModule,
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

  it("defaults navItems and resources to empty arrays", () => {
    const parsed = adminModuleManifestSchema.parse(validModule);
    expect(parsed.navItems).toEqual([]);
    expect(parsed.resources).toEqual([]);
  });

  it("rejects unknown top-level keys", () => {
    expect(() =>
      adminModuleManifestSchema.parse({ ...validModule, extra: true }),
    ).toThrow();
  });

  it("rejects unknown keys nested in resources", () => {
    expect(() =>
      adminModuleManifestSchema.parse({
        ...validModule,
        resources: [
          {
            id: "users",
            labelKey: "admin.user.resources.users",
            route: "/admin/users",
            requiredPermission: "user.read",
            typo: 1,
          },
        ],
      }),
    ).toThrow();
  });

  it.each(["id", "labelKey", "basePath", "requiredPermission"])(
    "rejects missing required field %s",
    (field) => {
      const incomplete: Record<string, unknown> = { ...validModule };
      delete incomplete[field];
      expect(() => adminModuleManifestSchema.parse(incomplete)).toThrow();
    },
  );

  it.each(["id", "labelKey", "basePath", "requiredPermission"])(
    "rejects empty string for %s",
    (field) => {
      expect(() =>
        adminModuleManifestSchema.parse({ ...validModule, [field]: "" }),
      ).toThrow();
    },
  );
});

describe("adminActionManifestSchema", () => {
  it.each(["link", "mutation", "dangerMutation"])(
    "accepts kind %s",
    (kind) => {
      expect(
        adminActionManifestSchema.parse({
          id: "a",
          labelKey: "k",
          kind,
          requiredPermission: "p",
        }).kind,
      ).toBe(kind);
    },
  );

  it("rejects an unknown kind", () => {
    expect(() =>
      adminActionManifestSchema.parse({
        id: "a",
        labelKey: "k",
        kind: "delete",
        requiredPermission: "p",
      }),
    ).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() =>
      adminActionManifestSchema.parse({
        id: "a",
        labelKey: "k",
        kind: "link",
        requiredPermission: "p",
        extra: 1,
      }),
    ).toThrow();
  });
});

describe("adminResourceManifestSchema", () => {
  it("defaults actions to an empty array", () => {
    expect(
      adminResourceManifestSchema.parse({
        id: "r",
        labelKey: "k",
        route: "/r",
        requiredPermission: "p",
      }).actions,
    ).toEqual([]);
  });
});

describe("adminNavItemManifestSchema", () => {
  it("rejects unknown keys", () => {
    expect(() =>
      adminNavItemManifestSchema.parse({
        id: "n",
        labelKey: "k",
        route: "/n",
        requiredPermission: "p",
        extra: 1,
      }),
    ).toThrow();
  });
});
