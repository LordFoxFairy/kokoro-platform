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

// transitioned=false 表示 order 非 paid（已退款/被并发抢先），此时不建 Refund。
export interface RefundTransition {
  transitioned: boolean;
  refund: Refund | null;
}

export interface PaymentRepository {
  upsertPlan(input: UpsertPlanInput): Promise<Plan>;
  createOrder(input: CreateOrderInput): Promise<Order>;
  recordPaymentEvent(input: RecordPaymentEventInput): Promise<PaymentEvent>;
  findOrderById(orderId: string): Promise<Order | null>;
  findPlanById(planId: string): Promise<Plan | null>;
  markOrderPaid(orderId: string): Promise<Order>;
  // 同库原子：标 paid→refunded 与建 Refund 记录在一个事务，杜绝「标了退款却无记录」。
  refundOrderAtomically(orderId: string, refund: CreateRefundInput): Promise<RefundTransition>;
  findRefundByOrderId(orderId: string): Promise<Refund | null>;
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
