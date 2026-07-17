import type { AdminModuleManifest } from "./schema.js";
import { adminModuleManifestSchema } from "./schema.js";

export type AdminRouteContract = {
  method: "GET" | "POST" | "DELETE";
  route: string;
};

export const modelAdminContract: {
  manifest: AdminModuleManifest;
  routes: AdminRouteContract[];
} = {
  routes: [
    { method: "GET", route: "/admin/models/provider-accounts" },
    { method: "GET", route: "/admin/models/bindings" },
    { method: "GET", route: "/admin/models/labels" },
    { method: "GET", route: "/admin/models/site-policies" },
    { method: "POST", route: "/provider-accounts/ensure" },
    { method: "DELETE", route: "/admin/models/provider-accounts/:providerAccountId" },
    { method: "POST", route: "/admin/models/provider-accounts/:providerAccountId/restore" },
    { method: "POST", route: "/admin/models/provider-accounts/:id/disable" },
    { method: "POST", route: "/admin/models/provider-accounts/:id/enable" },
    { method: "POST", route: "/model-bindings/ensure" },
    { method: "POST", route: "/model-labels/ensure" },
    { method: "DELETE", route: "/admin/models/bindings/:modelBindingId" },
    { method: "POST", route: "/admin/models/bindings/:modelBindingId/restore" },
    { method: "POST", route: "/admin/models/bindings/:id/disable" },
    { method: "POST", route: "/admin/models/bindings/:id/enable" },
    { method: "POST", route: "/admin/models/site-policies" },
  ],
  manifest: adminModuleManifestSchema.parse({
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
            id: "create",
            labelKey: "admin.model.actions.createProviderAccount",
            kind: "mutation",
            requiredPermission: "model.providerAccount.write",
            route: "/provider-accounts/ensure",
            method: "POST",
          },
          {
            id: "delete",
            labelKey: "admin.model.actions.deleteProviderAccount",
            kind: "dangerMutation",
            requiredPermission: "model.providerAccount.delete",
            route: "/admin/models/provider-accounts/:providerAccountId",
            method: "DELETE",
          },
          {
            id: "restore",
            labelKey: "admin.model.actions.restoreProviderAccount",
            kind: "mutation",
            requiredPermission: "model.providerAccount.restore",
            route: "/admin/models/provider-accounts/:providerAccountId/restore",
            method: "POST",
          },
          {
            id: "disable",
            labelKey: "admin.model.actions.disableProviderAccount",
            kind: "dangerMutation",
            requiredPermission: "model.providerAccount.disable",
            route: "/admin/models/provider-accounts/:id/disable",
            method: "POST",
          },
          {
            id: "enable",
            labelKey: "admin.model.actions.enableProviderAccount",
            kind: "mutation",
            requiredPermission: "model.providerAccount.enable",
            route: "/admin/models/provider-accounts/:id/enable",
            method: "POST",
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
            id: "create",
            labelKey: "admin.model.actions.createBinding",
            kind: "mutation",
            requiredPermission: "model.binding.write",
            route: "/model-bindings/ensure",
            method: "POST",
          },
          {
            id: "delete",
            labelKey: "admin.model.actions.deleteBinding",
            kind: "dangerMutation",
            requiredPermission: "model.binding.delete",
            route: "/admin/models/bindings/:modelBindingId",
            method: "DELETE",
          },
          {
            id: "restore",
            labelKey: "admin.model.actions.restoreBinding",
            kind: "mutation",
            requiredPermission: "model.binding.restore",
            route: "/admin/models/bindings/:modelBindingId/restore",
            method: "POST",
          },
          {
            id: "disable",
            labelKey: "admin.model.actions.disableBinding",
            kind: "dangerMutation",
            requiredPermission: "model.binding.disable",
            route: "/admin/models/bindings/:id/disable",
            method: "POST",
          },
          {
            id: "enable",
            labelKey: "admin.model.actions.enableBinding",
            kind: "mutation",
            requiredPermission: "model.binding.enable",
            route: "/admin/models/bindings/:id/enable",
            method: "POST",
          },
        ],
      },
      {
        id: "model-labels",
        labelKey: "admin.model.resources.modelLabels",
        route: "/admin/models/labels",
        requiredPermission: "model.label.read",
        actions: [
          {
            id: "create",
            labelKey: "admin.model.actions.createLabel",
            kind: "mutation",
            requiredPermission: "model.label.write",
            route: "/model-labels/ensure",
            method: "POST",
          },
        ],
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
            method: "POST",
          },
        ],
      },
    ],
  }),
};

export const modelAdminManifest = modelAdminContract.manifest;
