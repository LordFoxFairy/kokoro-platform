import { describe, expect, it } from "vitest";
import { modelAdminManifest } from "../../src/interfaces/admin/manifest.js";
import { adminModuleManifestSchema } from "../../src/interfaces/admin/schema.js";
import { modelPlatformModule } from "../../src/module.js";

describe("model admin manifest", () => {
  it("matches the local admin manifest schema and platform metadata", () => {
    const parsed = adminModuleManifestSchema.parse(modelAdminManifest);

    expect(parsed.resources.map((resource) => resource.id)).toEqual([
      "provider-accounts",
      "model-bindings",
      "model-labels",
    ]);
    expect(modelPlatformModule.admin).toMatchObject({
      mode: "manifest",
      basePath: modelAdminManifest.basePath,
      manifestExport: "modelAdminManifest",
    });
  });
});
