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
          id: "publish",
          labelKey: "admin.model.actions.publishBinding",
          kind: "mutation",
          requiredPermission: "model.binding.publish",
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
  ],
});
