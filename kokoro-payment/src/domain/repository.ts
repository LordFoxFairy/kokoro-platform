import type {
  BillingInterval,
  Order,
  PaymentEvent,
  Plan,
  Refund,
  RefundStatus,
  Subscription,
} from "./payment.js";

export interface UpsertPlanInput {
  siteId: string;
  key: string;
  name: string;
  currency: string;
  amountMinor: string;
  creditMicros?: string | undefined;
  billingInterval: BillingInterval;
}

export interface CreateOrderInput {
  siteId: string;
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

export interface CreateRefundInput {
  orderId: string;
  amountMinor: string;
  currency: string;
  status: RefundStatus;
  reason?: string | undefined;
}

export interface PaymentRepository {
  upsertPlan(input: UpsertPlanInput): Promise<Plan>;
  createOrder(input: CreateOrderInput): Promise<Order>;
  recordPaymentEvent(input: RecordPaymentEventInput): Promise<PaymentEvent>;
  findOrderById(orderId: string): Promise<Order | null>;
  findPlanById(planId: string): Promise<Plan | null>;
  markOrderPaid(orderId: string): Promise<Order>;
  markOrderRefunded(orderId: string): Promise<number>;
  createRefund(input: CreateRefundInput): Promise<Refund>;
  listPlans(siteId?: string): Promise<Plan[]>;
  listOrders(siteId?: string): Promise<Order[]>;
  listSubscriptions(): Promise<Subscription[]>;
  listPaymentEvents(): Promise<PaymentEvent[]>;
  listRefunds(): Promise<Refund[]>;
}

export interface GrantPurchaseCreditsInput {
  siteId: string;
  requestId: string;
  ownerKind: "team";
  ownerId: string;
  amountMicros: string;
  idempotencyKey: string;
  reason: "subscription";
}

export type GrantPurchaseCredits = (input: GrantPurchaseCreditsInput) => Promise<void>;

export interface ReverseCreditsInput {
  siteId: string;
  requestId: string;
  ownerKind: "team";
  ownerId: string;
  amountMicros: string;
  idempotencyKey: string;
  reason: "refund";
}

export type ReverseCredits = (input: ReverseCreditsInput) => Promise<void>;
