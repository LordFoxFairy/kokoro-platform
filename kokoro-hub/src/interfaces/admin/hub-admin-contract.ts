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
      route: "/hub/admin/official/skills",
      requiredPermission: "hub.skill.read",
    },
    {
      id: "mcp-servers",
      labelKey: "admin.hub.resources.mcpServers",
      route: "/hub/admin/official/mcp/servers",
      requiredPermission: "hub.mcp.read",
    },
  ],
  resources: [
    {
      id: "skills",
      labelKey: "admin.hub.resources.skills",
      route: "/hub/admin/official/skills",
      requiredPermission: "hub.skill.read",
      // 运营动作(官方目录治理):official-flags 上架/下架/required + 软删。均单参 :name(scope=official 隐含)。
      // 租户 per-user enable/disable 不属运营面,不在此暴露。
      actions: [
        {
          id: "official-flags",
          labelKey: "admin.hub.actions.officialFlags",
          kind: "mutation",
          requiredPermission: "hub.skill.official",
          route: "/hub/admin/skills/:name/official-flags",
        },
        {
          id: "delete",
          labelKey: "admin.hub.actions.delete",
          kind: "dangerMutation",
          requiredPermission: "hub.skill.delete",
          route: "/hub/admin/official/skills/:name",
          method: "DELETE",
        },
      ],
    },
    // HUB-2 上传写面独立成资源（skills 资源的动作序列是既有契约面，不追加扰动）。
    {
      id: "skill-uploads",
      labelKey: "admin.hub.resources.skillUploads",
      route: "/hub/admin/skills/:scope/:name/revisions",
      requiredPermission: "hub.skill.read",
      actions: [
        {
          id: "upload-preview",
          labelKey: "admin.hub.actions.uploadPreview",
          kind: "mutation",
          requiredPermission: "hub.skill.upload",
          route: "/hub/admin/skills/upload/preview",
        },
        {
          id: "upload-confirm",
          labelKey: "admin.hub.actions.uploadConfirm",
          kind: "mutation",
          requiredPermission: "hub.skill.upload",
          route: "/hub/admin/skills/upload/confirm",
        },
      ],
    },
    // HUB-4 运营位 + 审核状态机独立成资源（skills 资源的动作序列是既有契约面，不追加扰动）。
    {
      id: "skill-curation",
      labelKey: "admin.hub.resources.skillCuration",
      route: "/hub/admin/official/skills",
      requiredPermission: "hub.skill.read",
      actions: [
        {
          id: "curation",
          labelKey: "admin.hub.actions.curation",
          kind: "mutation",
          requiredPermission: "hub.skill.curation",
          route: "/hub/admin/official/skills/:name/curation",
        },
        {
          id: "review",
          labelKey: "admin.hub.actions.review",
          kind: "mutation",
          requiredPermission: "hub.skill.review",
          route: "/hub/admin/official/skills/:name/review",
        },
      ],
    },
    // HUB-3 MCP server 注册表（skills 面同构：注册/启停/软删；凭据只存 secret-ref）。
    {
      id: "mcp-servers",
      labelKey: "admin.hub.resources.mcpServers",
      route: "/hub/admin/official/mcp/servers",
      requiredPermission: "hub.mcp.read",
      // 运营动作(官方目录治理):注册(namespace-free 写入官方 scope)/启停/软删。
      // 启停/软删均单参 :name(scope=official 隐含);租户合并池不属运营面。
      actions: [
        {
          id: "register",
          labelKey: "admin.hub.actions.mcpRegister",
          kind: "mutation",
          requiredPermission: "hub.mcp.register",
          route: "/hub/admin/mcp/servers",
        },
        {
          id: "enable",
          labelKey: "admin.hub.actions.mcpEnable",
          kind: "mutation",
          requiredPermission: "hub.mcp.toggle",
          route: "/hub/admin/official/mcp/servers/:name/enable",
        },
        {
          id: "disable",
          labelKey: "admin.hub.actions.mcpDisable",
          kind: "mutation",
          requiredPermission: "hub.mcp.toggle",
          route: "/hub/admin/official/mcp/servers/:name/disable",
        },
        {
          id: "delete",
          labelKey: "admin.hub.actions.mcpDelete",
          kind: "dangerMutation",
          requiredPermission: "hub.mcp.delete",
          route: "/hub/admin/official/mcp/servers/:name",
          method: "DELETE",
        },
      ],
    },
  ],
});

const routes: HubAdminRoute[] = [
  { method: "GET", path: "/hub/admin/skills/pool" },
  { method: "GET", path: "/hub/admin/skills/quota" },
  { method: "POST", path: "/hub/admin/skills/:scope/:name/enable" },
  { method: "POST", path: "/hub/admin/skills/:scope/:name/disable" },
  { method: "POST", path: "/hub/admin/skills/:name/official-flags" },
  { method: "DELETE", path: "/hub/admin/skills/:scope/:name" },
  { method: "POST", path: "/hub/admin/skills/:scope/:name/curation" },
  { method: "POST", path: "/hub/admin/skills/:scope/:name/review" },
  { method: "POST", path: "/hub/admin/skills/upload/preview" },
  { method: "POST", path: "/hub/admin/skills/upload/confirm" },
  { method: "GET", path: "/hub/admin/skills/:scope/:name/revisions" },
  { method: "POST", path: "/hub/admin/mcp/servers" },
  { method: "GET", path: "/hub/admin/mcp/servers" },
  { method: "POST", path: "/hub/admin/mcp/servers/:scope/:name/enable" },
  { method: "POST", path: "/hub/admin/mcp/servers/:scope/:name/disable" },
  { method: "DELETE", path: "/hub/admin/mcp/servers/:scope/:name" },
  { method: "GET", path: "/hub/admin/official/mcp/servers" },
  { method: "POST", path: "/hub/admin/official/mcp/servers/:name/enable" },
  { method: "POST", path: "/hub/admin/official/mcp/servers/:name/disable" },
  { method: "DELETE", path: "/hub/admin/official/mcp/servers/:name" },
];

export const hubAdminContract = {
  manifest,
  routes,
};
