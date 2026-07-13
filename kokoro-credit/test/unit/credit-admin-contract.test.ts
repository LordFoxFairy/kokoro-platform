import { describe, expect, it } from "vitest";
import { creditAdminContract } from "../../src/interfaces/admin/credit-admin-contract.js";
import { creditAdminManifest } from "../../src/interfaces/admin/manifest.js";

describe("credit admin contract", () => {
  it("keeps the manifest derived from the contract", () => {
    expect(creditAdminManifest).toEqual(creditAdminContract.manifest);
  });

  it("declares real method/route entries for every mutation action", () => {
    const routeKeys = new Set(
      creditAdminContract.routes.map((route) => `${route.method} ${route.route}`),
    );

    for (const resource of creditAdminContract.manifest.resources) {
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

  it("exposes account and pricing lifecycle actions", () => {
    const accountActions = creditAdminContract.manifest.resources
      .find((resource) => resource.id === "credit-accounts")
      ?.actions.map((action) => action.id);
    const pricingActions = creditAdminContract.manifest.resources
      .find((resource) => resource.id === "pricing-rules")
      ?.actions.map((action) => action.id);

    expect(accountActions).toEqual(["grant", "set-quota", "delete", "restore"]);
    expect(pricingActions).toEqual(["create", "delete", "restore"]);
  });
});
