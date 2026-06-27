import { z } from "zod";

export const adminActionManifestSchema = z.object({
  id: z.string().min(1),
  labelKey: z.string().min(1),
  kind: z.enum(["link", "mutation", "dangerMutation"]),
  requiredPermission: z.string().min(1),
});

export const adminResourceManifestSchema = z.object({
  id: z.string().min(1),
  labelKey: z.string().min(1),
  route: z.string().min(1),
  requiredPermission: z.string().min(1),
  actions: z.array(adminActionManifestSchema).default([]),
});

export const adminNavItemManifestSchema = z.object({
  id: z.string().min(1),
  labelKey: z.string().min(1),
  route: z.string().min(1),
  requiredPermission: z.string().min(1),
});

export const adminModuleManifestSchema = z.object({
  id: z.string().min(1),
  labelKey: z.string().min(1),
  basePath: z.string().min(1),
  requiredPermission: z.string().min(1),
  navItems: z.array(adminNavItemManifestSchema).default([]),
  resources: z.array(adminResourceManifestSchema).default([]),
});

export type AdminModuleManifest = z.infer<typeof adminModuleManifestSchema>;
