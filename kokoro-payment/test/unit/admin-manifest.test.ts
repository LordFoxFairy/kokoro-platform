import { describe, expect, it } from "vitest";
import { paymentAdminManifest } from "../../src/interfaces/admin/manifest.js";
import { adminModuleManifestSchema } from "../../src/interfaces/admin/schema.js";
import { paymentPlatformModule } from "../../src/module.js";

describe("payment admin manifest", () => {
  it("matches the local admin manifest schema and platform metadata", () => {
    const parsed = adminModuleManifestSchema.parse(paymentAdminManifest);

    expect(parsed.resources.map((resource) => resource.id)).toEqual([
      "plans",
      "orders",
      "subscriptions",
      "payment-events",
      "refunds",
      "providers",
    ]);
    expect(paymentPlatformModule.admin).toMatchObject({
      mode: "manifest",
      basePath: paymentAdminManifest.basePath,
      manifestExport: "paymentAdminManifest",
    });
  });
});
