import type { AdminModuleManifest } from "./schema.js";
import { adminModuleManifestSchema } from "./schema.js";

export type AdminRouteContract = {
  method: "GET" | "POST" | "DELETE";
  route: string;
};

export const creditAdminContract: {
  manifest: AdminModuleManifest;
  routes: AdminRouteContract[];
} = {
  routes: [
    { method: "GET", route: "/admin/credits/accounts" },
    { method: "GET", route: "/admin/credits/ledger" },
    { method: "GET", route: "/admin/credits/usage" },
    { method: "GET", route: "/admin/credits/pricing" },
    { method: "POST", route: "/admin/credits/grant" },
    { method: "POST", route: "/admin/credits/reset" },
    { method: "POST", route: "/admin/credits/accounts/:accountId/quota" },
    { method: "DELETE", route: "/admin/credits/accounts/:accountId" },
    { method: "POST", route: "/admin/credits/accounts/:accountId/restore" },
    { method: "POST", route: "/admin/credits/pricing-rules" },
    { method: "DELETE", route: "/admin/credits/pricing-rules/:pricingRuleId" },
    { method: "POST", route: "/admin/credits/pricing-rules/:pricingRuleId/restore" },
  ],
  manifest: adminModuleManifestSchema.parse({
    id: "kokoro-credit",
    labelKey: "admin.modules.credit",
    basePath: "/admin/credits",
    requiredPermission: "credit.admin",
    resources: [
      {
        id: "credit-accounts",
        labelKey: "admin.credit.resources.accounts",
        route: "/admin/credits/accounts",
        requiredPermission: "credit.account.read",
        actions: [
          {
            id: "grant",
            labelKey: "admin.credit.actions.grant",
            kind: "mutation",
            requiredPermission: "credit.grant",
            route: "/admin/credits/grant",
            method: "POST",
          },
          {
            id: "reset",
            labelKey: "admin.credit.actions.reset",
            kind: "mutation",
            requiredPermission: "credit.grant",
            route: "/admin/credits/reset",
            method: "POST",
          },
          {
            id: "set-quota",
            labelKey: "admin.credit.actions.setQuota",
            kind: "mutation",
            requiredPermission: "credit.quota.set",
            route: "/admin/credits/accounts/:accountId/quota",
            method: "POST",
          },
          {
            id: "delete",
            labelKey: "admin.credit.actions.delete",
            kind: "dangerMutation",
            requiredPermission: "credit.account.delete",
            route: "/admin/credits/accounts/:accountId",
            method: "DELETE",
          },
          {
            id: "restore",
            labelKey: "admin.credit.actions.restore",
            kind: "mutation",
            requiredPermission: "credit.account.restore",
            route: "/admin/credits/accounts/:accountId/restore",
            method: "POST",
          },
        ],
      },
      {
        id: "ledger-entries",
        labelKey: "admin.credit.resources.ledgerEntries",
        route: "/admin/credits/ledger",
        requiredPermission: "credit.ledger.read",
        actions: [],
      },
      {
        id: "usage-records",
        labelKey: "admin.credit.resources.usageRecords",
        route: "/admin/credits/usage",
        requiredPermission: "credit.usage.read",
        actions: [],
      },
      {
        id: "pricing-rules",
        labelKey: "admin.credit.resources.pricingRules",
        route: "/admin/credits/pricing",
        requiredPermission: "credit.pricing.read",
        actions: [
          {
            id: "create",
            labelKey: "admin.credit.actions.createPricingRule",
            kind: "mutation",
            requiredPermission: "credit.pricing.create",
            route: "/admin/credits/pricing-rules",
            method: "POST",
          },
          {
            id: "delete",
            labelKey: "admin.credit.actions.deletePricingRule",
            kind: "dangerMutation",
            requiredPermission: "credit.pricing.delete",
            route: "/admin/credits/pricing-rules/:pricingRuleId",
            method: "DELETE",
          },
          {
            id: "restore",
            labelKey: "admin.credit.actions.restorePricingRule",
            kind: "mutation",
            requiredPermission: "credit.pricing.restore",
            route: "/admin/credits/pricing-rules/:pricingRuleId/restore",
            method: "POST",
          },
        ],
      },
    ],
  }),
};

export const creditAdminManifest = creditAdminContract.manifest;
