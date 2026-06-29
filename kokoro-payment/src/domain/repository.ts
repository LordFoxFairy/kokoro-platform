import type {
  BillingInterval,
  Order,
  PaymentEvent,
  Plan,
  Refund,
  Subscription,
} from "./payment.js";

export interface UpsertPlanInput {
  key: string;
  name: string;
  currency: string;
  amountMinor: string;
  creditMicros?: string | undefined;
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
  findOrderById(orderId: string): Promise<Order | null>;
  findPlanById(planId: string): Promise<Plan | null>;
  markOrderPaid(orderId: string): Promise<Order>;
  listPlans(): Promise<Plan[]>;
  listOrders(): Promise<Order[]>;
  listSubscriptions(): Promise<Subscription[]>;
  listPaymentEvents(): Promise<PaymentEvent[]>;
  listRefunds(): Promise<Refund[]>;
}

export interface GrantPurchaseCreditsInput {
  ownerKind: "team";
  ownerId: string;
  amountMicros: string;
  idempotencyKey: string;
  reason: "subscription";
}

export type GrantPurchaseCredits = (input: GrantPurchaseCreditsInput) => Promise<void>;
