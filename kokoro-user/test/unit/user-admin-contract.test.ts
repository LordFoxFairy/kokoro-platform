import { describe, expect, it } from "vitest";
import { userAdminManifest } from "../../src/interfaces/admin/manifest.js";
import { userAdminContract } from "../../src/interfaces/admin/user-admin-contract.js";

describe("userAdminContract", () => {
  it("is the single source for the exported manifest", () => {
    expect(userAdminManifest).toEqual(userAdminContract.manifest);
  });

  it("declares real routes for every mutation action", () => {
    const routes = new Set(userAdminContract.routes.map((route) => `${route.method} ${route.path}`));

    const actions = userAdminContract.manifest.resources.flatMap((resource) => resource.actions ?? []);
    for (const action of actions) {
      if (action.kind !== "mutation" && action.kind !== "dangerMutation") {
        continue;
      }

      expect(action.route, `${action.id} should declare a route`).toBeDefined();
      expect(
        routes.has(`${action.method ?? "POST"} ${action.route}`),
        `${action.id} route should exist in userAdminContract.routes`,
      ).toBe(true);
    }
  });

  it("exposes delete and restore actions for user lifecycle resources", () => {
    const users = userAdminContract.manifest.resources.find((resource) => resource.id === "users");
    const teams = userAdminContract.manifest.resources.find((resource) => resource.id === "teams");
    const serviceAccounts = userAdminContract.manifest.resources.find(
      (resource) => resource.id === "service-accounts",
    );

    expect(users?.actions?.map((action) => action.id)).toEqual([
      "create",
      "disable",
      "enable",
      "delete",
      "restore",
    ]);
    expect(teams?.actions?.map((action) => action.id)).toEqual(["create", "delete", "restore"]);
    expect(serviceAccounts?.actions?.map((action) => action.id)).toEqual(["delete"]);
  });

  it("declares every identity resource as Site scoped", () => {
    expect(Object.fromEntries(userAdminContract.manifest.resources.map((resource) => [resource.id, resource.siteScopeField]))).toEqual({
      users: "siteId",
      teams: "siteId",
      memberships: "siteId",
      "service-accounts": "siteId",
    });
  });
});
