import { describe, expect, it } from "vitest";
import { adminModuleManifestSchema } from "../../src/interfaces/admin/schema.js";
import { hubAdminContract } from "../../src/interfaces/admin/hub-admin-contract.js";
import { hubAdminManifest } from "../../src/interfaces/admin/manifest.js";

describe("hub admin contract", () => {
  it("exposes a schema-valid module manifest", () => {
    expect(() => adminModuleManifestSchema.parse(hubAdminManifest)).not.toThrow();
    expect(hubAdminManifest.id).toBe("kokoro-hub");
    expect(hubAdminManifest.basePath).toBe("/hub/admin");
  });

  it("declares the operator skill actions with single-param official proxy routes", () => {
    const skills = hubAdminManifest.resources.find((resource) => resource.id === "skills");
    const actionIds = skills?.actions.map((action) => action.id);
    // 运营面只暴露官方目录治理动作(official-flags/delete);租户 per-user enable/disable 不在此。
    expect(actionIds).toEqual(["official-flags", "delete"]);
    // 读路由对齐通用网关(namespace-free 官方目录)。
    expect(skills?.route).toBe("/hub/admin/official/skills");

    const del = skills?.actions.find((action) => action.id === "delete");
    expect(del?.method).toBe("DELETE");
    expect(del?.kind).toBe("dangerMutation");
    // 单参 :name(scope=official 隐含),通用网关可解析。
    expect(del?.route).toBe("/hub/admin/official/skills/:name");
  });

  it("keeps the route list aligned with the API surface", () => {
    expect(hubAdminContract.routes).toContainEqual({ method: "GET", path: "/hub/admin/skills/pool" });
    expect(hubAdminContract.routes).toContainEqual({
      method: "POST",
      path: "/hub/admin/skills/:scope/:name/enable",
    });
    expect(hubAdminContract.routes).toContainEqual({
      method: "DELETE",
      path: "/hub/admin/skills/:scope/:name",
    });
  });
});
