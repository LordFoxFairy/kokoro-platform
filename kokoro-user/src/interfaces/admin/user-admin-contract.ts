import type { AdminModuleManifest } from "./schema.js";
import { adminModuleManifestSchema } from "./schema.js";

export type UserAdminRouteMethod = "GET" | "POST" | "DELETE";

export interface UserAdminRoute {
  method: UserAdminRouteMethod;
  path: string;
}

const manifest: AdminModuleManifest = adminModuleManifestSchema.parse({
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
          id: "create",
          labelKey: "admin.user.actions.create",
          kind: "mutation",
          requiredPermission: "user.write",
          route: "/users/ensure",
        },
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
        {
          id: "delete",
          labelKey: "admin.user.actions.delete",
          kind: "dangerMutation",
          requiredPermission: "user.delete",
          route: "/users/:userId",
          method: "DELETE",
        },
        {
          id: "restore",
          labelKey: "admin.user.actions.restore",
          kind: "mutation",
          requiredPermission: "user.restore",
          route: "/users/:userId/restore",
        },
      ],
    },
    {
      id: "teams",
      labelKey: "admin.user.resources.teams",
      route: "/admin/teams",
      requiredPermission: "team.read",
      actions: [
        {
          id: "create",
          labelKey: "admin.user.actions.createTeam",
          kind: "mutation",
          requiredPermission: "team.manage",
          route: "/teams/upsert",
        },
        {
          id: "delete",
          labelKey: "admin.user.actions.deleteTeam",
          kind: "dangerMutation",
          requiredPermission: "team.delete",
          route: "/teams/:teamId",
          method: "DELETE",
        },
        {
          id: "restore",
          labelKey: "admin.user.actions.restoreTeam",
          kind: "mutation",
          requiredPermission: "team.restore",
          route: "/teams/:teamId/restore",
        },
      ],
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
          route: "/memberships/change-role",
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
          id: "delete",
          labelKey: "admin.user.actions.deleteServiceAccount",
          kind: "dangerMutation",
          requiredPermission: "serviceAccount.delete",
          route: "/service-accounts/:serviceAccountId",
          method: "DELETE",
        },
      ],
    },
  ],
});

const routes: UserAdminRoute[] = [
  { method: "GET", path: "/admin/users" },
  { method: "GET", path: "/admin/teams" },
  { method: "GET", path: "/admin/memberships" },
  { method: "GET", path: "/admin/service-accounts" },
  { method: "POST", path: "/users/ensure" },
  { method: "POST", path: "/admin/users/:id/disable" },
  { method: "POST", path: "/admin/users/:id/enable" },
  { method: "DELETE", path: "/users/:userId" },
  { method: "POST", path: "/users/:userId/restore" },
  { method: "POST", path: "/teams/upsert" },
  { method: "DELETE", path: "/teams/:teamId" },
  { method: "POST", path: "/teams/:teamId/restore" },
  { method: "POST", path: "/memberships/change-role" },
  { method: "DELETE", path: "/service-accounts/:serviceAccountId" },
];

export const userAdminContract = {
  manifest,
  routes,
};
