import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const modelRoot = new URL("../../kokoro-model/", import.meta.url);

describe("legacy kokoro-model Admin authority retirement", () => {
  it("keeps the old manifest, routes, and exports absent", () => {
    for (const relative of [
      "src/interfaces/http/admin-routes.ts",
      "src/interfaces/admin/manifest.ts",
      "src/interfaces/admin/model-admin-contract.ts",
      "src/interfaces/admin/schema.ts",
    ]) {
      expect(existsSync(new URL(relative, modelRoot)), relative).toBe(false);
    }
    const server = readFileSync(new URL("src/interfaces/http/server.ts", modelRoot), "utf8");
    const index = readFileSync(new URL("src/index.ts", modelRoot), "utf8");
    const module = readFileSync(new URL("src/module.ts", modelRoot), "utf8");
    expect(server).not.toMatch(/registerModelAdminRoutes|declareRouteAccess\(app, "\/admin"/u);
    expect(index).not.toMatch(/interfaces\/admin|modelAdminManifest/u);
    expect(module).not.toMatch(/admin-manifest|basePath: "\/admin\/models"/u);
  });

  it("retains executable 404 coverage for callers holding Admin credentials", () => {
    const test = readFileSync(
      new URL("test/unit/legacy-admin-closed.test.ts", modelRoot),
      "utf8",
    );
    expect(test).toMatch(/x-kokoro-service": "admin"/u);
    expect(test).toMatch(/\/admin\/models\/provider-accounts/u);
    expect(test).toMatch(/statusCode\)\.toBe\(404\)/u);
  });
});
