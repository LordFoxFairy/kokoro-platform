import type { AdminModuleManifest } from "./schema.js";
import { adminModuleManifestSchema } from "./schema.js";

export type AdminRouteContract = {
  method: "GET" | "POST" | "DELETE";
  route: string;
};

export const paymentAdminContract: {
  manifest: AdminModuleManifest;
  routes: AdminRouteContract[];
} = {
  routes: [
    { method: "GET", route: "/admin/payments/plans" },
    { method: "GET", route: "/admin/payments/orders" },
    { method: "GET", route: "/admin/payments/subscriptions" },
    { method: "GET", route: "/admin/payments/events" },
    { method: "GET", route: "/admin/payments/refunds" },
    { method: "GET", route: "/admin/payments/providers" },
    { method: "GET", route: "/admin/payments/stats" },
  ],
  manifest: adminModuleManifestSchema.parse({
    id: "kokoro-payment",
    labelKey: "admin.modules.payment",
    basePath: "/admin/payments",
    requiredPermission: "payment.admin",
    resources: [
      {
        id: "plans",
        labelKey: "admin.payment.resources.plans",
        route: "/admin/payments/plans",
        requiredPermission: "payment.plan.read",
        siteScopeField: "siteId",
        actions: [],
      },
      {
        id: "orders",
        labelKey: "admin.payment.resources.orders",
        route: "/admin/payments/orders",
        requiredPermission: "payment.order.read",
        siteScopeField: "siteId",
        actions: [],
      },
      {
        id: "subscriptions",
        labelKey: "admin.payment.resources.subscriptions",
        route: "/admin/payments/subscriptions",
        requiredPermission: "payment.subscription.read",
        siteScopeField: "siteId",
        actions: [],
      },
      {
        id: "payment-events",
        labelKey: "admin.payment.resources.paymentEvents",
        route: "/admin/payments/events",
        requiredPermission: "payment.event.read",
        siteScopeField: null,
        actions: [],
      },
      {
        id: "refunds",
        labelKey: "admin.payment.resources.refunds",
        route: "/admin/payments/refunds",
        requiredPermission: "payment.refund.read",
        siteScopeField: "siteId",
        actions: [],
      },
      {
        id: "providers",
        labelKey: "admin.payment.resources.providers",
        route: "/admin/payments/providers",
        requiredPermission: "payment.provider.read",
        siteScopeField: null,
        actions: [],
      },
    ],
  }),
};

export const paymentAdminManifest = paymentAdminContract.manifest;
