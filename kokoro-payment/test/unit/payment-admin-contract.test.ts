import { describe, expect, it } from "vitest";
import { paymentAdminContract } from "../../src/interfaces/admin/payment-admin-contract.js";
import { paymentAdminManifest } from "../../src/interfaces/admin/manifest.js";

describe("payment admin contract", () => {
  it("keeps the manifest derived from the contract", () => {
    expect(paymentAdminManifest).toEqual(paymentAdminContract.manifest);
  });

  it("exposes every payment resource as read-only during redeem-only launch", () => {
    for (const resource of paymentAdminContract.manifest.resources) {
      expect(resource.actions, resource.id).toEqual([]);
    }
    expect(paymentAdminContract.routes.every((route) => route.method === "GET")).toBe(true);
  });

  it("does not advertise plan, order, refund, subscription, provider, or event mutations", () => {
    const planActions = paymentAdminContract.manifest.resources
      .find((resource) => resource.id === "plans")
      ?.actions.map((action) => action.id);
    const refundActions = paymentAdminContract.manifest.resources
      .find((resource) => resource.id === "refunds")
      ?.actions.map((action) => action.id);

    expect(planActions).toEqual([]);
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
