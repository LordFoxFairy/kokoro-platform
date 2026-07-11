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

export const planParamsSchema = z
  .object({
    planId: z.string().min(1),
  })
  .strict();

export const deleteRequestSchema = z
  .object({
    deletedBy: z.string().min(1),
    reason: z.string().min(1).optional(),
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

export const upsertProviderRequestSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_-]*$/, "provider key 只允许小写字母/数字/_-，且以字母开头"),
    kind: z.enum(["stripe", "alipay", "wechat", "mock"]),
    // 只收 env 变量名引用（大写蛇形）；形如密钥明文的值直接拒绝，保证密钥不落库。
    webhookSecretRef: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, "webhookSecretRef 必须是 env 变量名引用，不接受密钥明文"),
    enabled: z.boolean().default(true),
  })
  .strict();

export const providerParamsSchema = z
  .object({
    key: z.string().min(1),
  })
  .strict();

export const webhookProviderParamsSchema = z
  .object({
    provider: z.string().min(1),
  })
  .strict();

export const replayPaymentEventParamsSchema = z
  .object({
    id: z.string().min(1),
  })
  .strict();
