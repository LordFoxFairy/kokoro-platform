import type { AdminModuleManifest } from "./schema.js";
import { adminModuleManifestSchema } from "./schema.js";

export const modelAdminManifest: AdminModuleManifest = adminModuleManifestSchema.parse({
  id: "kokoro-model",
  labelKey: "admin.modules.model",
  basePath: "/admin/models",
  requiredPermission: "model.admin",
  resources: [
    {
      id: "provider-accounts",
      labelKey: "admin.model.resources.providerAccounts",
      route: "/admin/models/provider-accounts",
      requiredPermission: "model.providerAccount.read",
      actions: [
        {
          id: "disable",
          labelKey: "admin.model.actions.disableProviderAccount",
          kind: "dangerMutation",
          requiredPermission: "model.providerAccount.disable",
          route: "/admin/models/provider-accounts/:id/disable",
        },
        {
          id: "enable",
          labelKey: "admin.model.actions.enableProviderAccount",
          kind: "mutation",
          requiredPermission: "model.providerAccount.disable",
          route: "/admin/models/provider-accounts/:id/enable",
        },
      ],
    },
    {
      id: "model-bindings",
      labelKey: "admin.model.resources.modelBindings",
      route: "/admin/models/bindings",
      requiredPermission: "model.binding.read",
      actions: [
        {
          id: "disable",
          labelKey: "admin.model.actions.disableBinding",
          kind: "dangerMutation",
          requiredPermission: "model.binding.disable",
          route: "/admin/models/bindings/:id/disable",
        },
        {
          id: "enable",
          labelKey: "admin.model.actions.enableBinding",
          kind: "mutation",
          requiredPermission: "model.binding.disable",
          route: "/admin/models/bindings/:id/enable",
        },
      ],
    },
    {
      id: "model-labels",
      labelKey: "admin.model.resources.modelLabels",
      route: "/admin/models/labels",
      requiredPermission: "model.label.read",
      actions: [],
    },
    {
      id: "site-policies",
      labelKey: "admin.model.resources.sitePolicies",
      route: "/admin/models/site-policies",
      requiredPermission: "model.sitePolicy.read",
      actions: [
        {
          id: "set",
          labelKey: "admin.model.actions.setSitePolicy",
          kind: "mutation",
          requiredPermission: "model.sitePolicy.write",
          route: "/admin/models/site-policies",
        },
      ],
    },
  ],
});
