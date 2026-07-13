import { randomUUID } from "node:crypto";
import { parsePositiveBigIntString } from "@kokoro/platform-kit";
import { parseNonNegativeBigIntString } from "../domain/amount.js";
import {
  OrderAmountMismatchError,
  OrderNotConfirmableError,
  OrderNotFoundError,
  OrderNotRefundableError,
  PlanNotFoundError,
} from "../domain/errors.js";
import type { Order, Refund, Subscription } from "../domain/payment.js";
import { PaymentLifecycleError, type DeleteInput, type RestoreInput } from "../domain/payment-lifecycle.js";
import type {
  CreateOrderInput,
  GrantPurchaseCredits,
  PaymentRepository,
  RecordPaymentEventInput,
  ReverseCredits,
  UpsertPlanInput,
} from "../domain/repository.js";
import type { ParsedSubscriptionEvent } from "../domain/webhook.js";

export class PaymentService {
  constructor(
    private readonly repository: PaymentRepository,
    private readonly grantPurchaseCredits: GrantPurchaseCredits,
    private readonly reverseCredits: ReverseCredits,
  ) {}

  async upsertPlan(input: UpsertPlanInput) {
    parsePositiveBigIntString(input.amountMinor, "amountMinor");
    parseNonNegativeBigIntString(input.creditMicros ?? "0", "creditMicros");
    return this.repository.upsertPlan(input);
  }

  async createOrder(input: CreateOrderInput) {
    parsePositiveBigIntString(input.amountMinor, "amountMinor");
    const plan = await this.repository.findPlanById(input.planId);
    assertPlanSellable(plan, input.siteId, input.planId);
    // 订单金额/币种必须锚定套餐定价，杜绝客户端低价下单却按套餐发整额积分。
    if (BigInt(input.amountMinor) !== BigInt(plan.amountMinor) || input.currency !== plan.currency) {
      throw new OrderAmountMismatchError(input.planId);
    }
    return this.repository.createOrder(input);
  }

  async deletePlan(input: DeleteInput) {
    return this.repository.deletePlan(input);
  }

  async restorePlan(input: RestoreInput) {
    return this.repository.restorePlan(input);
  }

  async recordPaymentEvent(input: RecordPaymentEventInput) {
    return this.repository.recordPaymentEvent(input);
  }

  async confirmOrder(orderId: string, requestId: string): Promise<Order> {
    const order = await this.repository.findOrderById(orderId);
    if (!order) {
      throw new OrderNotFoundError(orderId);
    }

    if (order.status === "paid") {
      return order;
    }

    // confirming=上次确认中途崩溃(意图已落库)，允许重入收尾；其余非 pending 拒绝。
    if (order.status !== "pending" && order.status !== "confirming") {
      throw new OrderNotConfirmableError(orderId, order.status);
    }

    const plan = await this.repository.findPlanById(order.planId);
    if (!plan) {
      throw new PlanNotFoundError(order.planId);
    }
    assertPlanNotDeleted(plan);

    // outbox 最小型：确认意图先落库(pending→confirming)，此后任何一步崩溃都由 sweep 按幂等键收尾。
    await this.repository.markOrderConfirming(orderId);

    if (BigInt(plan.creditMicros) > 0n) {
      // WHY: 先授予再标 paid；失败时 order 停在 confirming，sweep/重试用同一幂等键不会重复发积分。
      await this.grantPurchaseCredits({
        siteId: order.siteId,
        requestId,
        ownerKind: "team",
        ownerId: order.teamId,
        amountMicros: plan.creditMicros,
        idempotencyKey: `order:${orderId}`,
        reason: "subscription",
      });
    }

    return this.repository.markOrderPaid(orderId);
  }

  // 悬挂确认收尾：confirming 且早于阈值的订单(确认中途崩溃)重放 grant(幂等键=order:<id>)+标 paid。
  // 单笔失败不阻断整批;返回收尾计数供手动端点/巡检可观测。
  async sweepStaleConfirmingOrders(thresholdMs: number, requestId: string): Promise<number> {
    const before = new Date(Date.now() - thresholdMs);
    const stale = await this.repository.listStaleConfirmingOrders(before);
    let recovered = 0;
    for (const order of stale) {
      try {
        await this.confirmOrder(order.id, requestId);
        recovered += 1;
      } catch (error) {
        console.error("payment confirm sweep failed", order.id, error);
      }
    }
    return recovered;
  }

  // WHY: 管理员不走支付直接发权益：建单后立即确认，复用既有发放路径。
  async grantPlanToTeam(
    siteId: string,
    teamId: string,
    planId: string,
    requestId: string,
  ): Promise<Order> {
    const plan = await this.repository.findPlanById(planId);
    if (!plan || plan.siteId !== siteId) {
      throw new PlanNotFoundError(planId);
    }
    assertPlanSellable(plan, siteId, planId);

    const order = await this.createOrder({
      siteId,
      teamId,
      planId,
      amountMinor: plan.amountMinor,
      currency: plan.currency,
      idempotencyKey: randomUUID(),
    });

    return this.confirmOrder(order.id, requestId);
  }

  // 订阅事件写路径：幂等 upsert 订阅行(active/past_due/canceled)，激活/续期时发放本周期积分。
  // 周期驱动:V1 靠事件(不做本地定时续费)。grant 幂等键含 providerSubscriptionId + 周期起点,
  // 同周期重复事件不重复发放，新周期(续期)产生新键触发新发放。
  async applySubscriptionEvent(
    provider: string,
    event: ParsedSubscriptionEvent,
    requestId: string,
  ): Promise<Subscription> {
    const plan = await this.repository.findPlanById(event.planId);
    if (!plan) {
      throw new PlanNotFoundError(event.planId);
    }
    assertPlanNotDeleted(plan);

    const subscription = await this.repository.upsertSubscription({
      provider,
      providerSubscriptionId: event.providerSubscriptionId,
      teamId: event.teamId,
      planId: event.planId,
      status: event.status,
      currentPeriodStart: event.currentPeriodStart,
      currentPeriodEnd: event.currentPeriodEnd,
    });

    if (event.grantCredits && BigInt(plan.creditMicros) > 0n) {
      const periodKey = event.currentPeriodStart
        ? event.currentPeriodStart.toISOString()
        : subscription.id;
      await this.grantPurchaseCredits({
        siteId: plan.siteId,
        requestId,
        ownerKind: "team",
        ownerId: event.teamId,
        amountMicros: plan.creditMicros,
        idempotencyKey: `subscription:${provider}:${event.providerSubscriptionId}:${periodKey}`,
        reason: "subscription",
      });
    }

    return subscription;
  }

  async refundOrder(orderId: string, requestId: string): Promise<{ order: Order; refund: Refund }> {
    const order = await this.repository.findOrderById(orderId);
    if (!order) {
      throw new OrderNotFoundError(orderId);
    }

    // 幂等：已退款则返回既有 Refund，不重复扣回。
    if (order.status === "refunded") {
      const existing = await this.repository.findRefundByOrderId(orderId);
      if (existing) {
        return { order, refund: existing };
      }
      throw new OrderNotRefundableError(orderId, order.status);
    }
    if (order.status !== "paid") {
      throw new OrderNotRefundableError(orderId, order.status);
    }

    const plan = await this.repository.findPlanById(order.planId);
    if (!plan) {
      throw new PlanNotFoundError(order.planId);
    }

    // 1) 先做幂等的跨服务补偿——此刻 order 仍 paid；reverse 失败则 order 不变、可重试，
    //    绝不出现「已标退款却没扣回积分」的不可自愈状态(跨库无分布式事务，靠顺序+幂等收敛)。
    if (BigInt(plan.creditMicros) > 0n) {
      await this.reverseCredits({
        siteId: order.siteId,
        requestId,
        ownerKind: "team",
        ownerId: order.teamId,
        amountMicros: plan.creditMicros,
        idempotencyKey: `order-refund:${orderId}`,
        reason: "refund",
      });
    }

    // 2) payment 同库原子：标 refunded + 记 Refund(要么都成要么都不成)。
    const result = await this.repository.refundOrderAtomically(orderId, {
      orderId,
      amountMinor: order.amountMinor,
      currency: order.currency,
      status: "succeeded",
      reason: "refund",
    });
    if (!result.transitioned || !result.refund) {
      // 并发败者：order 已被另一并发退款；reverse 幂等保证只扣一次，返回既有 Refund。
      const existing = await this.repository.findRefundByOrderId(orderId);
      if (existing) {
        return { order: { ...order, status: "refunded" }, refund: existing };
      }
      throw new OrderNotRefundableError(orderId, "refunded");
    }

    return { order: { ...order, status: "refunded" }, refund: result.refund };
  }
}

function assertPlanSellable(
  plan: Awaited<ReturnType<PaymentRepository["findPlanById"]>>,
  siteId: string,
  planId: string,
): asserts plan is NonNullable<typeof plan> {
  if (!plan || plan.siteId !== siteId) {
    // 套餐不存在或不属本站（不泄露他站套餐存在）。
    throw new PlanNotFoundError(planId);
  }
  assertPlanNotDeleted(plan);
  if (plan.status !== "active") {
    throw new PlanNotFoundError(planId);
  }
}

function assertPlanNotDeleted(plan: NonNullable<Awaited<ReturnType<PaymentRepository["findPlanById"]>>>): void {
  if (plan.deletedAt) {
    throw new PaymentLifecycleError("payment.plan.deleted", `payment plan deleted: ${plan.id}`, 409);
  }
}
