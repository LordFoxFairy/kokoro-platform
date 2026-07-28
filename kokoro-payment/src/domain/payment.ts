import type { DeletionAudit } from "./payment-lifecycle.js";

export type BillingInterval = "once" | "month" | "year";
export type PlanStatus = "active" | "disabled";
export type OrderStatus = "pending" | "confirming" | "paid" | "canceled" | "refunded";
export type PaymentEventStatus = "received" | "processed" | "failed";
export type SubscriptionStatus = "active" | "canceled" | "past_due";
export type RefundStatus = "pending" | "succeeded" | "failed";

export interface Plan extends DeletionAudit {
  id: string;
  siteId: string;
  key: string;
  name: string;
  currency: string;
  amountMinor: string;
  creditMicros: string;
  billingInterval: BillingInterval;
  status: PlanStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface Order {
  id: string;
  siteId: string;
  teamId: string;
  planId: string;
  amountMinor: string;
  currency: string;
  status: OrderStatus;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentEvent {
  id: string;
  provider: string;
  eventId: string;
  eventType: string;
  payload: unknown;
  status: PaymentEventStatus;
  // 最近一次处理失败的原因；processed/received 时为 null。
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Subscription {
  id: string;
  teamId: string;
  planId: string;
  status: SubscriptionStatus;
  provider: string | null;
  providerSubscriptionId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminSubscription extends Subscription {
  siteId: string;
}

export interface Refund {
  id: string;
  orderId: string;
  amountMinor: string;
  currency: string;
  status: RefundStatus;
  reason: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminRefund extends Refund {
  siteId: string;
}

// 运营台聚合总览（admin B2）：订单按状态计数 + 已支付营收按币种汇总（amountMinor 最小货币单位字符串）。
// 营收按币种分组——多币种不可直加。
export interface PaymentAdminStats {
  ordersTotal: number;
  ordersPaid: number;
  ordersPending: number;
  ordersRefunded: number;
  ordersCanceled: number;
  revenueByCurrency: { currency: string; amountMinor: string }[];
}
