import type { BillingInterval, Order, PaymentEvent, Plan } from "./payment.js";

export interface UpsertPlanInput {
  key: string;
  name: string;
  currency: string;
  amountMinor: string;
  billingInterval: BillingInterval;
}

export interface CreateOrderInput {
  teamId: string;
  planId: string;
  amountMinor: string;
  currency: string;
  idempotencyKey: string;
}

export interface RecordPaymentEventInput {
  provider: string;
  eventId: string;
  eventType: string;
  payload?: unknown;
}

export interface PaymentRepository {
  upsertPlan(input: UpsertPlanInput): Promise<Plan>;
  createOrder(input: CreateOrderInput): Promise<Order>;
  recordPaymentEvent(input: RecordPaymentEventInput): Promise<PaymentEvent>;
}
