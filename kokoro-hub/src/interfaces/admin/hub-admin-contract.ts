import type { AdminModuleManifest } from "./schema.js";
import { adminModuleManifestSchema } from "./schema.js";

export type HubAdminRouteMethod = "GET" | "POST" | "DELETE";

export interface HubAdminRoute {
  method: HubAdminRouteMethod;
  path: string;
}

// admin 网关据 manifest 声明式代理写操作（route 含 :param 模板）；HUB-3 接入网关时零改路由。
const manifest: AdminModuleManifest = adminModuleManifestSchema.parse({
  id: "kokoro-hub",
  labelKey: "admin.modules.hub",
  basePath: "/hub/admin",
  requiredPermission: "hub.admin",
  navItems: [
    {
      id: "skills",
      labelKey: "admin.hub.resources.skills",
      route: "/hub/skills/pool",
      requiredPermission: "hub.skill.read",
    },
  ],
  resources: [
    {
      id: "skills",
      labelKey: "admin.hub.resources.skills",
      route: "/hub/skills/pool",
      requiredPermission: "hub.skill.read",
      actions: [
        {
          id: "enable",
          labelKey: "admin.hub.actions.enable",
          kind: "mutation",
          requiredPermission: "hub.skill.toggle",
          route: "/hub/skills/:scope/:name/enable",
        },
        {
          id: "disable",
          labelKey: "admin.hub.actions.disable",
          kind: "mutation",
          requiredPermission: "hub.skill.toggle",
          route: "/hub/skills/:scope/:name/disable",
        },
        {
          id: "official-flags",
          labelKey: "admin.hub.actions.officialFlags",
          kind: "mutation",
          requiredPermission: "hub.skill.official",
          route: "/hub/skills/:name/official-flags",
        },
        {
          id: "delete",
          labelKey: "admin.hub.actions.delete",
          kind: "dangerMutation",
          requiredPermission: "hub.skill.delete",
          route: "/hub/skills/:scope/:name",
          method: "DELETE",
        },
      ],
    },
  ],
});

const routes: HubAdminRoute[] = [
  { method: "GET", path: "/hub/skills/pool" },
  { method: "GET", path: "/hub/skills/quota" },
  { method: "POST", path: "/hub/skills/:scope/:name/enable" },
  { method: "POST", path: "/hub/skills/:scope/:name/disable" },
  { method: "POST", path: "/hub/skills/:name/official-flags" },
  { method: "DELETE", path: "/hub/skills/:scope/:name" },
];

export const hubAdminContract = {
  manifest,
  routes,
};
