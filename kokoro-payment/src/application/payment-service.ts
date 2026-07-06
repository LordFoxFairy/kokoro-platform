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
import type { Order, Refund } from "../domain/payment.js";
import { PaymentLifecycleError, type DeleteInput, type RestoreInput } from "../domain/payment-lifecycle.js";
import type {
  CreateOrderInput,
  GrantPurchaseCredits,
  PaymentRepository,
  RecordPaymentEventInput,
  ReverseCredits,
  UpsertPlanInput,
} from "../domain/repository.js";

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

    if (order.status !== "pending") {
      throw new OrderNotConfirmableError(orderId, order.status);
    }

    const plan = await this.repository.findPlanById(order.planId);
    if (!plan) {
      throw new PlanNotFoundError(order.planId);
    }
    assertPlanNotDeleted(plan);

    if (BigInt(plan.creditMicros) > 0n) {
      // WHY: 先授予再标 paid；失败时 order 仍 pending，重试用同一幂等键不会重复发积分。
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
