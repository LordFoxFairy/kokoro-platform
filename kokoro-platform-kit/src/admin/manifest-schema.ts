import { z } from "zod";

// strict: manifests are authored structural contracts; an unknown key is a typo to reject, not strip.
// route/method 让网关据 manifest 精确代理写操作（route 可含 :param 模板）；未声明 route 的 action 暂不可代理。
export const adminActionManifestSchema = z
  .object({
    id: z.string().min(1),
    labelKey: z.string().min(1),
    kind: z.enum(["link", "mutation", "dangerMutation"]),
    requiredPermission: z.string().min(1),
    route: z.string().min(1).optional(),
    method: z.enum(["POST", "DELETE"]).default("POST"),
  })
  .strict();

export const adminResourceManifestSchema = z
  .object({
    id: z.string().min(1),
    labelKey: z.string().min(1),
    route: z.string().min(1),
    requiredPermission: z.string().min(1),
    actions: z.array(adminActionManifestSchema).default([]),
  })
  .strict();

export const adminNavItemManifestSchema = z
  .object({
    id: z.string().min(1),
    labelKey: z.string().min(1),
    route: z.string().min(1),
    requiredPermission: z.string().min(1),
  })
  .strict();

export const adminModuleManifestSchema = z
  .object({
    id: z.string().min(1),
    labelKey: z.string().min(1),
    basePath: z.string().min(1),
    requiredPermission: z.string().min(1),
    navItems: z.array(adminNavItemManifestSchema).default([]),
    resources: z.array(adminResourceManifestSchema).default([]),
  })
  .strict();

export type AdminModuleManifest = z.infer<typeof adminModuleManifestSchema>;
