import { describe, expect, it } from "vitest";
import { modelAdminContract } from "../../src/interfaces/admin/model-admin-contract.js";
import { modelAdminManifest } from "../../src/interfaces/admin/manifest.js";

describe("model admin contract", () => {
  it("keeps the manifest derived from the contract", () => {
    expect(modelAdminManifest).toEqual(modelAdminContract.manifest);
  });

  it("declares real method/route entries for every mutation action", () => {
    const routeKeys = new Set(
      modelAdminContract.routes.map((route) => `${route.method} ${route.route}`),
    );

    for (const resource of modelAdminContract.manifest.resources) {
      for (const action of resource.actions) {
        if (action.kind === "mutation" || action.kind === "dangerMutation") {
          expect(action.route, `${resource.id}.${action.id} route`).toBeTypeOf("string");
          expect(routeKeys.has(`${action.method} ${action.route}`), `${resource.id}.${action.id}`).toBe(
            true,
          );
        }
      }
    }
  });

  it("exposes only real model actions", () => {
    const providerActions = modelAdminContract.manifest.resources
      .find((resource) => resource.id === "provider-accounts")
      ?.actions.map((action) => action.id);
    const bindingActions = modelAdminContract.manifest.resources
      .find((resource) => resource.id === "model-bindings")
      ?.actions.map((action) => action.id);
    const labelActions = modelAdminContract.manifest.resources
      .find((resource) => resource.id === "model-labels")
      ?.actions.map((action) => action.id);
    const policyActions = modelAdminContract.manifest.resources
      .find((resource) => resource.id === "site-policies")
      ?.actions.map((action) => action.id);

    expect(providerActions).toEqual(["create", "delete", "restore", "disable", "enable"]);
    expect(bindingActions).toEqual(["create", "delete", "restore", "disable", "enable"]);
    expect(labelActions).toEqual([]);
    expect(policyActions).toEqual(["set"]);
  });
});
