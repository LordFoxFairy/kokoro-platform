import { z } from "zod";

export const modelTransportKindSchema = z.enum(["litellm", "direct", "internal"]);

export const ensureProviderAccountRequestSchema = z
  .object({
    provider: z.string().min(1),
    key: z.string().min(1),
    label: z.string().min(1),
    secretRef: z.string().min(1),
    priority: z.number().int().min(0).optional(),
    transportKind: modelTransportKindSchema,
  })
  .strict();

export const ensureModelBindingRequestSchema = z
  .object({
    providerAccountId: z.string().min(1),
    modelName: z.string().min(1),
    displayName: z.string().min(1),
    featureKey: z.string().min(1),
    labelKeys: z.array(z.string().min(1)).default([]),
    inputModalities: z.array(z.string().min(1)).default([]),
    outputModalities: z.array(z.string().min(1)).default([]),
    transportKind: modelTransportKindSchema,
    gatewayModelName: z.string().min(1).optional(),
    contextWindow: z.number().int().positive().optional(),
    priority: z.number().int().min(0).optional(),
  })
  .strict();

export const listModelBindingsQuerySchema = z
  .object({
    featureKey: z.string().min(1).optional(),
    labelKey: z.string().min(1).optional(),
  })
  .strict();

export const resolveModelBindingsQuerySchema = z
  .object({
    featureKey: z.string().min(1),
    labelKey: z.string().min(1).optional(),
    transportKind: modelTransportKindSchema.optional(),
  })
  .strict();
