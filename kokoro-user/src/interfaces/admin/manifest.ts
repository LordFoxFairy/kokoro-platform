import type { AdminModuleManifest } from "./schema.js";
import { adminModuleManifestSchema } from "./schema.js";

export const userAdminManifest: AdminModuleManifest = adminModuleManifestSchema.parse({
  id: "kokoro-user",
  labelKey: "admin.modules.user",
  basePath: "/admin/users",
  requiredPermission: "user.admin",
  navItems: [
    {
      id: "users",
      labelKey: "admin.user.resources.users",
      route: "/admin/users",
      requiredPermission: "user.read",
    },
    {
      id: "teams",
      labelKey: "admin.user.resources.teams",
      route: "/admin/teams",
      requiredPermission: "team.read",
    },
    {
      id: "memberships",
      labelKey: "admin.user.resources.memberships",
      route: "/admin/memberships",
      requiredPermission: "membership.read",
    },
    {
      id: "service-accounts",
      labelKey: "admin.user.resources.serviceAccounts",
      route: "/admin/service-accounts",
      requiredPermission: "serviceAccount.read",
    },
  ],
  resources: [
    {
      id: "users",
      labelKey: "admin.user.resources.users",
      route: "/admin/users",
      requiredPermission: "user.read",
      actions: [
        {
          id: "disable",
          labelKey: "admin.user.actions.disable",
          kind: "dangerMutation",
          requiredPermission: "user.disable",
          route: "/admin/users/:id/disable",
        },
        {
          id: "enable",
          labelKey: "admin.user.actions.enable",
          kind: "mutation",
          requiredPermission: "user.disable",
          route: "/admin/users/:id/enable",
        },
      ],
    },
    {
      id: "teams",
      labelKey: "admin.user.resources.teams",
      route: "/admin/teams",
      requiredPermission: "team.read",
      actions: [],
    },
    {
      id: "memberships",
      labelKey: "admin.user.resources.memberships",
      route: "/admin/memberships",
      requiredPermission: "membership.read",
      actions: [
        {
          id: "change-role",
          labelKey: "admin.user.actions.changeRole",
          kind: "mutation",
          requiredPermission: "membership.manage",
        },
      ],
    },
    {
      id: "service-accounts",
      labelKey: "admin.user.resources.serviceAccounts",
      route: "/admin/service-accounts",
      requiredPermission: "serviceAccount.read",
      actions: [
        {
          id: "revoke",
          labelKey: "admin.user.actions.revokeServiceAccount",
          kind: "dangerMutation",
          requiredPermission: "serviceAccount.revoke",
        },
      ],
    },
  ],
});
