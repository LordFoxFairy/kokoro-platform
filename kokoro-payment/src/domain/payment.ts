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
