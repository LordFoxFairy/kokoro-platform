import { z } from "zod";

const amountMicrosSchema = z.string().regex(/^[1-9]\d*$/);

export const ensureCreditAccountRequestSchema = z
  .object({
    ownerKind: z.enum(["user", "team"]),
    ownerId: z.string().min(1),
  })
  .strict();

const creditReasonSchema = z.enum([
  "manual_adjustment",
  "subscription",
  "model_call",
  "tool_call",
  "refund",
]);

export const creditMutationRequestSchema = z
  .object({
    accountId: z.string().min(1),
    amountMicros: amountMicrosSchema,
    idempotencyKey: z.string().min(1),
    reason: creditReasonSchema,
    requestId: z.string().min(1).optional(),
  })
  .strict();

export const holdCreditRequestSchema = z
  .object({
    accountId: z.string().min(1),
    amountMicros: amountMicrosSchema,
    idempotencyKey: z.string().min(1),
    expiresAt: z.coerce.date().optional(),
  })
  .strict();

export const captureCreditRequestSchema = z
  .object({
    holdId: z.string().min(1),
    actualAmountMicros: amountMicrosSchema,
    idempotencyKey: z.string().min(1),
    reason: creditReasonSchema,
    featureKey: z.string().min(1),
    modelBindingId: z.string().min(1).optional(),
    requestId: z.string().min(1).optional(),
  })
  .strict();

export const releaseCreditRequestSchema = z
  .object({
    holdId: z.string().min(1),
    idempotencyKey: z.string().min(1),
  })
  .strict();
