import type {
  BillingInterval,
  Order,
  PaymentAdminStats,
  PaymentEvent,
  PaymentEventStatus,
  Plan,
  Refund,
  RefundStatus,
  Subscription,
  SubscriptionStatus,
} from "./payment.js";
import type { DeleteInput, ListOptions, RestoreInput } from "./payment-lifecycle.js";
import type { PaymentProviderConfig, PaymentProviderKind } from "./provider.js";

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

export interface UpsertProviderInput {
  key: string;
  kind: PaymentProviderKind;
  // env 变量名引用；不接受密钥明文。
  webhookSecretRef: string;
  enabled: boolean;
}

// 订阅写路径入参：按 (provider, providerSubscriptionId) 幂等 upsert，续期只推状态与周期。
export interface UpsertSubscriptionInput {
  provider: string;
  providerSubscriptionId: string;
  teamId: string;
  planId: string;
  status: SubscriptionStatus;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
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
  // 管理发放在读取可变 Plan 前按最终键恢复既有订单快照。
  findOrderByIdempotencyKey(idempotencyKey: string): Promise<Order | null>;
  // 确认意图落库(outbox 最小型):pending→confirming 条件转移;confirming/paid 幂等返回,其余拒绝。
  markOrderConfirming(orderId: string): Promise<Order>;
  // confirming 且 updatedAt 早于阈值的悬挂单(确认中途崩溃),交 sweep 收尾。
  listStaleConfirmingOrders(before: Date): Promise<Order[]>;
  findPlanById(planId: string): Promise<Plan | null>;
  markOrderPaid(orderId: string): Promise<Order>;
  // 订阅事件写路径：按 (provider, providerSubscriptionId) 幂等 upsert（续期只推状态/周期）。
  upsertSubscription(input: UpsertSubscriptionInput): Promise<Subscription>;
  // 同库原子：标 paid→refunded 与建 Refund 记录在一个事务，杜绝「标了退款却无记录」。
  refundOrderAtomically(orderId: string, refund: CreateRefundInput): Promise<RefundTransition>;
  findRefundByOrderId(orderId: string): Promise<Refund | null>;
  upsertProvider(input: UpsertProviderInput): Promise<PaymentProviderConfig>;
  findProviderByKey(key: string): Promise<PaymentProviderConfig | null>;
  deleteProvider(key: string): Promise<PaymentProviderConfig>;
  listProviders(): Promise<PaymentProviderConfig[]>;
  findPaymentEventById(id: string): Promise<PaymentEvent | null>;
  // 状态机条件转移：仅当当前状态 ∈ from 时推进到 to；并发败者拿到 null（勿覆盖赢家结果）。
  transitionPaymentEventStatus(
    id: string,
    from: PaymentEventStatus[],
    to: PaymentEventStatus,
    lastError: string | null,
  ): Promise<PaymentEvent | null>;
  deletePlan(input: DeleteInput): Promise<Plan>;
  restorePlan(input: RestoreInput): Promise<Plan>;
  listPlans(siteId?: string, options?: ListOptions): Promise<Plan[]>;
  listOrders(siteId?: string): Promise<Order[]>;
  listSubscriptions(): Promise<Subscription[]>;
  listPaymentEvents(): Promise<PaymentEvent[]>;
  listRefunds(): Promise<Refund[]>;
  // 运营台聚合总览（admin B2）：订单按状态计数 + 已支付营收按币种。
  readAdminStats(): Promise<PaymentAdminStats>;
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
