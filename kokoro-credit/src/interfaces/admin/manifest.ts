import type { AdminModuleManifest } from "./schema.js";
import { adminModuleManifestSchema } from "./schema.js";

export const creditAdminManifest: AdminModuleManifest = adminModuleManifestSchema.parse({
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
      actions: [],
    },
  ],
});
