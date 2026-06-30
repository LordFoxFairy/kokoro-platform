import type { AdminModuleManifest } from "./schema.js";
import { adminModuleManifestSchema } from "./schema.js";

export const paymentAdminManifest: AdminModuleManifest = adminModuleManifestSchema.parse({
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
          id: "publish",
          labelKey: "admin.payment.actions.publishPlan",
          kind: "mutation",
          requiredPermission: "payment.plan.publish",
        },
        {
          id: "grant-to-team",
          labelKey: "admin.payment.actions.grantPlanToTeam",
          kind: "mutation",
          requiredPermission: "payment.plan.grant",
          route: "/admin/payments/grant-plan",
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
      actions: [],
    },
    {
      id: "refunds",
      labelKey: "admin.payment.resources.refunds",
      route: "/admin/payments/refunds",
      requiredPermission: "payment.refund.read",
      actions: [
        {
          id: "approve",
          labelKey: "admin.payment.actions.approveRefund",
          kind: "dangerMutation",
          requiredPermission: "payment.refund.approve",
        },
      ],
    },
  ],
});
