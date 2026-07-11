import { z } from "zod";

const amountMicrosSchema = z.string().regex(/^[1-9]\d*$/);

export const ensureCreditAccountRequestSchema = z
  .object({
    ownerKind: z.enum(["user", "team"]),
    ownerId: z.string().min(1),
  })
  .strict();

// POST /credit/accounts/ensure 对外响应契约（最小面）：实际响应是完整账户对象，
// 下游（payment 等）只依赖 id；经包入口 import 本 schema 消费，不手抄形状。
export const ensureCreditAccountResponseSchema = z.object({ id: z.string().min(1) });
export type EnsureCreditAccountResponse = z.infer<typeof ensureCreditAccountResponseSchema>;

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

export const grantCreditRequestSchema = z
  .object({
    ownerKind: z.enum(["user", "team"]),
    ownerId: z.string().min(1),
    amountMicros: amountMicrosSchema,
    reason: creditReasonSchema,
  })
  .strict();

export const auditAccountParamsSchema = z
  .object({
    accountId: z.string().min(1),
  })
  .strict();

export const accountParamsSchema = z
  .object({
    accountId: z.string().min(1),
  })
  .strict();

export const pricingRuleParamsSchema = z
  .object({
    pricingRuleId: z.string().min(1),
  })
  .strict();

export const deleteRequestSchema = z
  .object({
    deletedBy: z.string().min(1),
    reason: z.string().min(1).optional(),
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

export const quoteRequestSchema = z
  .object({
    featureKey: z.string().min(1),
    labelKey: z.string().min(1).optional(),
    quantity: amountMicrosSchema.optional(),
  })
  .strict();

// run 受理冻结：调用方只报 namespace(=teamId) + pricing_ref；siteId 从 x-kokoro-site-id header 取。
export const usageHoldRequestSchema = z
  .object({
    namespace: z.string().min(1),
    featureKey: z.string().min(1),
    labelKey: z.string().min(1).optional(),
    idempotencyKey: z.string().min(1),
    modelBindingId: z.string().min(1).optional(),
    requestId: z.string().min(1).optional(),
  })
  .strict();

const tokenCountSchema = z.number().int().nonnegative();

// run 终态结算：调用方只报 token 用量，金额由 credit 按 hold 上的 pricing_ref 复算。
export const usageSettleRequestSchema = z
  .object({
    holdId: z.string().min(1),
    usage: z
      .object({
        inputTokens: tokenCountSchema,
        outputTokens: tokenCountSchema,
      })
      .strict(),
    idempotencyKey: z.string().min(1),
  })
  .strict();

export const createPricingRuleRequestSchema = z
  .object({
    featureKey: z.string().min(1),
    labelKey: z.string().min(1).optional(),
    unit: z.string().min(1),
    amountMicros: amountMicrosSchema,
    status: z.enum(["active", "disabled"]).optional(),
    effectiveFrom: z.coerce.date().optional(),
    effectiveUntil: z.coerce.date().optional(),
  })
  .strict();
