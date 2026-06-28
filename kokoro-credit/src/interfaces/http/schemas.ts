import { z } from "zod";

const amountMicrosSchema = z.string().regex(/^[1-9]\d*$/);

export const ensureCreditAccountRequestSchema = z
  .object({
    ownerKind: z.enum(["user", "team"]),
    ownerId: z.string().min(1),
  })
  .strict();

export const creditMutationRequestSchema = z
  .object({
    accountId: z.string().min(1),
    amountMicros: amountMicrosSchema,
    idempotencyKey: z.string().min(1),
    reason: z.enum(["manual_adjustment", "subscription", "model_call", "tool_call", "refund"]),
    requestId: z.string().min(1).optional(),
  })
  .strict();
