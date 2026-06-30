import { z } from "zod";

const amountMinorSchema = z.string().regex(/^[1-9]\d*$/);
const creditMicrosSchema = z.string().regex(/^\d+$/);

export const upsertPlanRequestSchema = z
  .object({
    key: z.string().min(1),
    name: z.string().min(1),
    currency: z.string().length(3),
    amountMinor: amountMinorSchema,
    creditMicros: creditMicrosSchema.optional(),
    billingInterval: z.enum(["once", "month", "year"]),
  })
  .strict();

export const createOrderRequestSchema = z
  .object({
    teamId: z.string().min(1),
    planId: z.string().min(1),
    amountMinor: amountMinorSchema,
    currency: z.string().length(3),
    idempotencyKey: z.string().min(1),
  })
  .strict();

export const confirmOrderParamsSchema = z
  .object({
    id: z.string().min(1),
  })
  .strict();

export const refundOrderParamsSchema = z
  .object({
    id: z.string().min(1),
  })
  .strict();

export const grantPlanRequestSchema = z
  .object({
    teamId: z.string().min(1),
    planId: z.string().min(1),
  })
  .strict();

export const recordPaymentEventRequestSchema = z
  .object({
    provider: z.string().min(1),
    eventId: z.string().min(1),
    eventType: z.string().min(1),
    payload: z.unknown(),
  })
  .strict();
