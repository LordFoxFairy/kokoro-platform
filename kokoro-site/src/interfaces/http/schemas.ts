import { z } from "zod";
import type { JsonObject, JsonValue } from "../../domain/json.js";

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), jsonObjectSchema]),
);
const jsonObjectSchema: z.ZodType<JsonObject> = z.lazy(() => z.record(jsonValueSchema));
const metadataSchema = jsonObjectSchema.optional();

export const siteSurfaceSchema = z.enum(["general", "studio", "api", "admin", "public_seo"]);

export const siteActiveParamsSchema = z.object({ siteId: z.string().min(1) }).strict();

export const siteParamsSchema = z.object({ siteId: z.string().min(1) }).strict();

export const siteDomainParamsSchema = z.object({ domainId: z.string().min(1) }).strict();

export const deleteRequestSchema = z
  .object({
    deletedBy: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
  })
  .strict();

export const upsertSiteRequestSchema = z
  .object({
    key: z.string().min(1),
    name: z.string().min(1),
    status: z.enum(["draft", "sandbox", "beta", "active", "suspended", "archived"]).optional(),
    defaultLocale: z.string().min(2).optional(),
    timezone: z.string().min(1).optional(),
    metadata: metadataSchema,
  })
  .strict();

export const upsertSiteDomainRequestSchema = z
  .object({
    siteId: z.string().min(1),
    host: z.string().min(1),
    status: z.enum(["active", "disabled", "pending_verification"]).optional(),
    isPrimary: z.boolean().optional(),
    canonicalHost: z.string().min(1).optional(),
    metadata: metadataSchema,
  })
  .strict();

export const upsertSiteAppRequestSchema = z
  .object({
    siteId: z.string().min(1),
    appKey: z.string().min(1),
    surface: siteSurfaceSchema,
    status: z.enum(["active", "disabled"]).optional(),
    defaultRoute: z.string().min(1).optional(),
    metadata: metadataSchema,
  })
  .strict();

export const upsertSitePolicyRequestSchema = z
  .object({
    siteId: z.string().min(1),
    key: z.string().min(1),
    value: jsonObjectSchema,
    status: z.enum(["active", "disabled"]).optional(),
  })
  .strict();

export const upsertSiteFeatureFlagRequestSchema = z
  .object({
    siteId: z.string().min(1),
    key: z.string().min(1),
    enabled: z.boolean(),
    metadata: metadataSchema,
  })
  .strict();

export const listSiteFeatureFlagsQuerySchema = z
  .object({
    siteId: z.string().min(1),
  })
  .strict();

export const resolveSiteQuerySchema = z
  .object({
    host: z.string().min(1),
    appKey: z.string().min(1).optional(),
    surface: siteSurfaceSchema.optional(),
  })
  .strict();
