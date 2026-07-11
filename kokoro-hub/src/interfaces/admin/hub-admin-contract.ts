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
    // HUB-2 上传写面独立成资源（skills 资源的动作序列是既有契约面，不追加扰动）。
    {
      id: "skill-uploads",
      labelKey: "admin.hub.resources.skillUploads",
      route: "/hub/skills/:scope/:name/revisions",
      requiredPermission: "hub.skill.read",
      actions: [
        {
          id: "upload-preview",
          labelKey: "admin.hub.actions.uploadPreview",
          kind: "mutation",
          requiredPermission: "hub.skill.upload",
          route: "/hub/skills/upload/preview",
        },
        {
          id: "upload-confirm",
          labelKey: "admin.hub.actions.uploadConfirm",
          kind: "mutation",
          requiredPermission: "hub.skill.upload",
          route: "/hub/skills/upload/confirm",
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
  { method: "POST", path: "/hub/skills/upload/preview" },
  { method: "POST", path: "/hub/skills/upload/confirm" },
  { method: "GET", path: "/hub/skills/:scope/:name/revisions" },
];

export const hubAdminContract = {
  manifest,
  routes,
};
