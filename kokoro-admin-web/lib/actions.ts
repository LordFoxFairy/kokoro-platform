import type { OwnerKind, User360 } from "./schemas";

export type FieldType = "text" | "number" | "select";

export interface ActionField {
  name: string;
  label: string;
  required: boolean;
  type: FieldType;
  options?: readonly string[];
}

// /api/action 请求体；与网关 actionBodySchema 对齐。
export interface ActionRequestBody {
  moduleId: string;
  resourceId: string;
  actionId: string;
  siteId: string;
  params?: Record<string, string>;
  reason?: string;
  // 网关 body 是 z.unknown()，允许非字符串（金额/布尔等）。
  body?: Record<string, unknown>;
}

export interface ActionContext {
  siteId: string;
  ownerKind: OwnerKind;
  ownerId: string;
  data: User360;
  orderId?: string;
}

export interface ActionSpec {
  title: string;
  danger: boolean;
  fields: readonly ActionField[];
  build: (values: Record<string, string>, ctx: ActionContext) => ActionRequestBody;
}

const microsFromAmount = (amount: string): string => String(Math.round(Number(amount) * 1e6));

// 工作台操作集；与现有 vanilla FORMS 一致：理由一律必填(reason)。
export const ACTION_SPECS = {
  grant: {
    title: "发积分",
    danger: false,
    fields: [
      { name: "amount", label: "积分数", required: true, type: "number" },
      { name: "reason", label: "原因", required: true, type: "select", options: ["manual_adjustment", "refund", "subscription"] },
    ],
    build: (v, ctx) => ({
      moduleId: "credit",
      resourceId: "credit-accounts",
      actionId: "grant",
      siteId: ctx.siteId,
      reason: v.reason,
      body: { ownerKind: ctx.ownerKind, ownerId: ctx.ownerId, amountMicros: microsFromAmount(v.amount ?? "0"), reason: v.reason ?? "" },
    }),
  },
  grantPlan: {
    title: "授予套餐",
    danger: false,
    fields: [{ name: "planId", label: "套餐 planId", required: true, type: "text" }],
    build: (v, ctx) => ({
      moduleId: "payment",
      resourceId: "plans",
      actionId: "grant-to-team",
      siteId: ctx.siteId,
      body: { teamId: ctx.ownerId, planId: v.planId ?? "" },
    }),
  },
  refund: {
    title: "退款",
    danger: true,
    fields: [{ name: "reason", label: "退款原因", required: true, type: "text" }],
    build: (v, ctx) => ({
      moduleId: "payment",
      resourceId: "orders",
      actionId: "refund",
      siteId: ctx.siteId,
      params: { id: ctx.orderId ?? "" },
      reason: v.reason,
      body: {},
    }),
  },
  disableUser: {
    title: "禁用用户",
    danger: true,
    fields: [{ name: "reason", label: "禁用原因", required: true, type: "text" }],
    build: (v, ctx) => ({
      moduleId: "user",
      resourceId: "users",
      actionId: "disable",
      siteId: ctx.siteId,
      params: { id: ctx.data.identity?.id ?? "" },
      reason: v.reason,
      body: {},
    }),
  },
  enableUser: {
    title: "启用用户",
    danger: false,
    fields: [],
    build: (_v, ctx) => ({
      moduleId: "user",
      resourceId: "users",
      actionId: "enable",
      siteId: ctx.siteId,
      params: { id: ctx.data.identity?.id ?? "" },
      body: {},
    }),
  },
} satisfies Record<string, ActionSpec>;

export type ActionKey = keyof typeof ACTION_SPECS;
