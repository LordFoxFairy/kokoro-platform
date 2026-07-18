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
    { method: "POST", route: "/plans/upsert" },
    { method: "DELETE", route: "/admin/payments/plans/:planId" },
    { method: "POST", route: "/admin/payments/plans/:planId/restore" },
    { method: "POST", route: "/admin/payments/grant-plan" },
    { method: "POST", route: "/orders/:id/refund" },
    { method: "POST", route: "/admin/payments/providers/upsert" },
    { method: "DELETE", route: "/admin/payments/providers/:key" },
    { method: "POST", route: "/admin/payments/events/:id/replay" },
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
        actions: [
          {
            id: "upsert",
            labelKey: "admin.payment.actions.upsertPlan",
            kind: "mutation",
            requiredPermission: "payment.plan.write",
            route: "/plans/upsert",
            method: "POST",
          },
          {
            id: "delete",
            labelKey: "admin.payment.actions.deletePlan",
            kind: "dangerMutation",
            requiredPermission: "payment.plan.delete",
            route: "/admin/payments/plans/:planId",
            method: "DELETE",
          },
          {
            id: "restore",
            labelKey: "admin.payment.actions.restorePlan",
            kind: "mutation",
            requiredPermission: "payment.plan.restore",
            route: "/admin/payments/plans/:planId/restore",
            method: "POST",
          },
          {
            id: "grant-to-team",
            labelKey: "admin.payment.actions.grantPlanToTeam",
            kind: "mutation",
            requiredPermission: "payment.plan.grant",
            route: "/admin/payments/grant-plan",
            method: "POST",
          },
        ],
      },
      {
        id: "orders",
        labelKey: "admin.payment.resources.orders",
        route: "/admin/payments/orders",
        requiredPermission: "payment.order.read",
        actions: [
          {
            id: "refund",
            labelKey: "admin.payment.actions.refundOrder",
            kind: "dangerMutation",
            requiredPermission: "payment.order.refund",
            route: "/orders/:id/refund",
            method: "POST",
          },
        ],
      },
      {
        id: "subscriptions",
        labelKey: "admin.payment.resources.subscriptions",
        route: "/admin/payments/subscriptions",
        requiredPermission: "payment.subscription.read",
        actions: [],
      },
      {
        id: "payment-events",
        labelKey: "admin.payment.resources.paymentEvents",
        route: "/admin/payments/events",
        requiredPermission: "payment.event.read",
        actions: [
          {
            id: "replay",
            labelKey: "admin.payment.actions.replayPaymentEvent",
            kind: "mutation",
            requiredPermission: "payment.event.replay",
            route: "/admin/payments/events/:id/replay",
            method: "POST",
          },
        ],
      },
      {
        id: "refunds",
        labelKey: "admin.payment.resources.refunds",
        route: "/admin/payments/refunds",
        requiredPermission: "payment.refund.read",
        actions: [],
      },
      {
        id: "providers",
        labelKey: "admin.payment.resources.providers",
        route: "/admin/payments/providers",
        requiredPermission: "payment.provider.read",
        actions: [
          {
            id: "upsert",
            labelKey: "admin.payment.actions.upsertProvider",
            kind: "mutation",
            requiredPermission: "payment.provider.write",
            route: "/admin/payments/providers/upsert",
            method: "POST",
          },
          {
            id: "delete",
            labelKey: "admin.payment.actions.deleteProvider",
            kind: "dangerMutation",
            requiredPermission: "payment.provider.delete",
            route: "/admin/payments/providers/:key",
            method: "DELETE",
          },
        ],
      },
    ],
  }),
};

export const paymentAdminManifest = paymentAdminContract.manifest;
