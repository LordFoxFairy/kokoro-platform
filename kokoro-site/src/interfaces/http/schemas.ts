import { z } from "zod";

const metadataSchema = z.record(z.unknown()).optional();
const jsonObjectSchema = z.record(z.unknown());

export const siteSurfaceSchema = z.enum(["general", "studio", "api", "admin", "public_seo"]);

export const upsertSiteRequestSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(["draft", "sandbox", "beta", "active", "suspended", "archived"]).optional(),
  defaultLocale: z.string().min(2).optional(),
  timezone: z.string().min(1).optional(),
  metadata: metadataSchema,
});

export const upsertSiteDomainRequestSchema = z.object({
  siteId: z.string().min(1),
  host: z.string().min(1),
  status: z.enum(["active", "disabled", "pending_verification"]).optional(),
  isPrimary: z.boolean().optional(),
  canonicalHost: z.string().min(1).optional(),
  metadata: metadataSchema,
});

export const upsertSiteAppRequestSchema = z.object({
  siteId: z.string().min(1),
  appKey: z.string().min(1),
  surface: siteSurfaceSchema,
  status: z.enum(["active", "disabled"]).optional(),
  defaultRoute: z.string().min(1).optional(),
  metadata: metadataSchema,
});

export const upsertSitePolicyRequestSchema = z.object({
  siteId: z.string().min(1),
  key: z.string().min(1),
  value: jsonObjectSchema,
  status: z.enum(["active", "disabled"]).optional(),
});

export const resolveSiteQuerySchema = z.object({
  host: z.string().min(1),
  appKey: z.string().min(1).optional(),
  surface: siteSurfaceSchema.optional(),
});
