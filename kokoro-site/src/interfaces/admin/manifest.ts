import type { AdminModuleManifest } from "./schema.js";
import { adminModuleManifestSchema } from "./schema.js";

export const siteAdminManifest: AdminModuleManifest = adminModuleManifestSchema.parse({
  id: "kokoro-site",
  labelKey: "admin.modules.site",
  basePath: "/admin/sites",
  requiredPermission: "site.admin",
  navItems: [
    {
      id: "sites",
      labelKey: "admin.site.resources.sites",
      route: "/admin/sites",
      requiredPermission: "site.read",
    },
    {
      id: "domains",
      labelKey: "admin.site.resources.domains",
      route: "/admin/site-domains",
      requiredPermission: "siteDomain.read",
    },
    {
      id: "apps",
      labelKey: "admin.site.resources.apps",
      route: "/admin/site-apps",
      requiredPermission: "siteApp.read",
    },
    {
      id: "policies",
      labelKey: "admin.site.resources.policies",
      route: "/admin/site-policies",
      requiredPermission: "sitePolicy.read",
    },
    {
      id: "feature-flags",
      labelKey: "admin.site.resources.featureFlags",
      route: "/admin/site-feature-flags",
      requiredPermission: "siteFeatureFlag.read",
    },
  ],
  resources: [
    {
      id: "sites",
      labelKey: "admin.site.resources.sites",
      route: "/admin/sites",
      requiredPermission: "site.read",
      actions: [
        {
          id: "upsert",
          labelKey: "admin.site.actions.upsert",
          kind: "mutation",
          requiredPermission: "site.write",
        },
      ],
    },
    {
      id: "domains",
      labelKey: "admin.site.resources.domains",
      route: "/admin/site-domains",
      requiredPermission: "siteDomain.read",
      actions: [
        {
          id: "bind",
          labelKey: "admin.site.actions.bindDomain",
          kind: "mutation",
          requiredPermission: "siteDomain.write",
        },
      ],
    },
    {
      id: "apps",
      labelKey: "admin.site.resources.apps",
      route: "/admin/site-apps",
      requiredPermission: "siteApp.read",
      actions: [
        {
          id: "configure",
          labelKey: "admin.site.actions.configureApp",
          kind: "mutation",
          requiredPermission: "siteApp.write",
        },
      ],
    },
    {
      id: "policies",
      labelKey: "admin.site.resources.policies",
      route: "/admin/site-policies",
      requiredPermission: "sitePolicy.read",
      actions: [
        {
          id: "set",
          labelKey: "admin.site.actions.setPolicy",
          kind: "mutation",
          requiredPermission: "sitePolicy.write",
        },
      ],
    },
    {
      id: "feature-flags",
      labelKey: "admin.site.resources.featureFlags",
      route: "/admin/site-feature-flags",
      requiredPermission: "siteFeatureFlag.read",
      actions: [
        {
          id: "toggle",
          labelKey: "admin.site.actions.toggleFeatureFlag",
          route: "/site-feature-flags/upsert",
          kind: "mutation",
          requiredPermission: "siteFeatureFlag.write",
        },
      ],
    },
  ],
});
