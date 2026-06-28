export type BillingInterval = "once" | "month" | "year";
export type PlanStatus = "active" | "disabled";
export type OrderStatus = "pending" | "paid" | "canceled" | "refunded";
export type PaymentEventStatus = "received" | "processed" | "failed";

export interface Plan {
  id: string;
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
  createdAt: Date;
  updatedAt: Date;
}
