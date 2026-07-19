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
  "welcome",
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

// 重置余额到目标值（运营/测试）：targetMicros 非负（允许 0 清零）。
const targetMicrosSchema = z.string().regex(/^\d+$/);
export const resetCreditRequestSchema = z
  .object({
    ownerKind: z.enum(["user", "team"]),
    ownerId: z.string().min(1),
    targetMicros: targetMicrosSchema,
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

// 组织级配额设置：quotaMicros=null 清除（回退不限）；非空须正整数微单位字符串。周期 V1 仅 monthly，默认之。
export const setAccountQuotaRequestSchema = z
  .object({
    quotaMicros: amountMicrosSchema.nullable(),
    quotaPeriod: z.enum(["monthly"]).optional(),
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

// run 计费面只读窄读：账户从 namespace 派生 team 账户（同 usage/hold），siteId 从 header 取。
// 无账户→零额空流水（只读不建账）。query 默认 strip 未知键。
export const usageSummaryQuerySchema = z.object({
  namespace: z.string().min(1),
});

export const usageLedgerQuerySchema = z.object({
  namespace: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  // 不透明游标（credit 生成，(createdAt,id) base64url）：结构非法由 route decode 判 400。
  cursor: z.string().min(1).optional(),
});

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

// 定价编辑（admin 治理）：仅可变字段，皆可选（缺省不动）；身份键（featureKey/labelKey/unit）不在此，不可变。
// effectiveUntil 可显式传 null 清除截止。
export const updatePricingRuleRequestSchema = z
  .object({
    amountMicros: amountMicrosSchema.optional(),
    status: z.enum(["active", "disabled"]).optional(),
    effectiveFrom: z.coerce.date().optional(),
    effectiveUntil: z.coerce.date().nullable().optional(),
  })
  .strict();
