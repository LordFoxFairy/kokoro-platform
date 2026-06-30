import { randomUUID } from "node:crypto";
import { parsePositiveBigIntString } from "@kokoro/platform-kit";
import { parseNonNegativeBigIntString } from "../domain/amount.js";
import {
  OrderNotConfirmableError,
  OrderNotFoundError,
  OrderNotRefundableError,
  PlanNotFoundError,
} from "../domain/errors.js";
import type { Order, Refund } from "../domain/payment.js";
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
    return this.repository.createOrder(input);
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
    if (!plan) {
      throw new PlanNotFoundError(planId);
    }

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

    if (order.status !== "paid") {
      throw new OrderNotRefundableError(orderId, order.status);
    }

    const plan = await this.repository.findPlanById(order.planId);
    if (!plan) {
      throw new PlanNotFoundError(order.planId);
    }

    // WHY: 原子条件转移 paid→refunded；count=0 说明已处理，幂等返回当前态。
    const transitioned = await this.repository.markOrderRefunded(orderId);
    if (transitioned === 0) {
      throw new OrderNotRefundableError(orderId, order.status);
    }

    // WHY: 先标 refunded 再扣回；扣回失败抛错由管理员可见，order 已 refunded 不重复退。
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

    const refund = await this.repository.createRefund({
      orderId,
      amountMinor: order.amountMinor,
      currency: order.currency,
      status: "succeeded",
      reason: "refund",
    });

    return { order: { ...order, status: "refunded" }, refund };
  }
}
