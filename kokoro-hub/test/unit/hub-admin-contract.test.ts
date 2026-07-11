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

  it("declares the skill write actions with proxy routes", () => {
    const skills = hubAdminManifest.resources.find((resource) => resource.id === "skills");
    const actionIds = skills?.actions.map((action) => action.id);
    expect(actionIds).toEqual(["enable", "disable", "official-flags", "delete"]);

    const del = skills?.actions.find((action) => action.id === "delete");
    expect(del?.method).toBe("DELETE");
    expect(del?.kind).toBe("dangerMutation");
  });

  it("keeps the route list aligned with the API surface", () => {
    expect(hubAdminContract.routes).toContainEqual({ method: "GET", path: "/hub/skills/pool" });
    expect(hubAdminContract.routes).toContainEqual({
      method: "POST",
      path: "/hub/skills/:scope/:name/enable",
    });
    expect(hubAdminContract.routes).toContainEqual({
      method: "DELETE",
      path: "/hub/skills/:scope/:name",
    });
  });
});
