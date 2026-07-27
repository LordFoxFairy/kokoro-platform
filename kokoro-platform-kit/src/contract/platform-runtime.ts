// GENERATED — DO NOT EDIT. Source: contract/spec/platform-runtime.yaml
// Regenerate: python3 contract/generate.py
import { z } from "zod"

export const modelTransportKindSchema = z.enum(["litellm", "direct", "internal"])

export const usageHoldRequestSchema = z
  .object({
    siteId: z.string().min(1),
    namespace: z.string().min(1),
    featureKey: z.string().min(1),
    labelKey: z.string().min(1).optional(),
    idempotencyKey: z.string().min(1),
    modelBindingId: z.string().min(1).optional(),
    requestId: z.string().min(1).optional(),
  })
  .strict()
export type UsageHoldRequest = z.infer<typeof usageHoldRequestSchema>

export const usageSettleUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  })
  .strict()
export type UsageSettleUsage = z.infer<typeof usageSettleUsageSchema>

export const usageSettleRequestSchema = z
  .object({
    siteId: z.string().min(1),
    holdId: z.string().min(1),
    usage: usageSettleUsageSchema,
    idempotencyKey: z.string().min(1),
  })
  .strict()
export type UsageSettleRequest = z.infer<typeof usageSettleRequestSchema>

export const releaseCreditRequestSchema = z
  .object({
    siteId: z.string().min(1),
    holdId: z.string().min(1),
    idempotencyKey: z.string().min(1),
  })
  .strict()
export type ReleaseCreditRequest = z.infer<typeof releaseCreditRequestSchema>

export const resolveModelBindingsQuerySchema = z
  .object({
    featureKey: z.string().min(1),
    labelKey: z.string().min(1).optional(),
    transportKind: z.enum(["litellm", "direct", "internal"]).optional(),
  })
  .strict()
export type ResolveModelBindingsQuery = z.infer<typeof resolveModelBindingsQuerySchema>

export const listModelLabelsQuerySchema = z
  .object({
    featureKey: z.string().min(1).optional(),
  })
  .strict()
export type ListModelLabelsQuery = z.infer<typeof listModelLabelsQuerySchema>

export const resolvedModelBindingSchema = z
  .object({
    id: z.string().min(1),
    transportKind: z.enum(["litellm", "direct", "internal"]),
    gatewayModelName: z.string().min(1).nullable(),
  })
  .strict()
export type ResolvedModelBinding = z.infer<typeof resolvedModelBindingSchema>

export const modelLabelCatalogItemSchema = z
  .object({
    key: z.string().min(1),
    displayName: z.string().min(1),
  })
  .strict()
export type ModelLabelCatalogItem = z.infer<typeof modelLabelCatalogItemSchema>
