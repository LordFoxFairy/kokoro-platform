import { describe, expect, it } from "vitest";
import { paymentAdminContract } from "../../src/interfaces/admin/payment-admin-contract.js";
import { paymentAdminManifest } from "../../src/interfaces/admin/manifest.js";

describe("payment admin contract", () => {
  it("keeps the manifest derived from the contract", () => {
    expect(paymentAdminManifest).toEqual(paymentAdminContract.manifest);
  });

  it("declares real method/route entries for every mutation action", () => {
    const routeKeys = new Set(
      paymentAdminContract.routes.map((route) => `${route.method} ${route.route}`),
    );

    for (const resource of paymentAdminContract.manifest.resources) {
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

  it("exposes only real plan and refund actions", () => {
    const planActions = paymentAdminContract.manifest.resources
      .find((resource) => resource.id === "plans")
      ?.actions.map((action) => action.id);
    const refundActions = paymentAdminContract.manifest.resources
      .find((resource) => resource.id === "refunds")
      ?.actions.map((action) => action.id);

    expect(planActions).toEqual(["upsert", "delete", "restore", "grant-to-team"]);
    expect(refundActions).toEqual([]);
  });

  it("declares Site projections and platform-global sensitive resources", () => {
    expect(Object.fromEntries(paymentAdminContract.manifest.resources.map((resource) => [resource.id, resource.siteScopeField]))).toEqual({
      plans: "siteId",
      orders: "siteId",
      subscriptions: "siteId",
      "payment-events": null,
      refunds: "siteId",
      providers: null,
    });
  });
});
