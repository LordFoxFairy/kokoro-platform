import { parsePositiveBigIntString } from "@kokoro/platform-kit";
import { parseNonNegativeBigIntString } from "../domain/amount.js";
import {
  OrderNotConfirmableError,
  OrderNotFoundError,
  PlanNotFoundError,
} from "../domain/errors.js";
import type { Order } from "../domain/payment.js";
import type {
  CreateOrderInput,
  GrantPurchaseCredits,
  PaymentRepository,
  RecordPaymentEventInput,
  UpsertPlanInput,
} from "../domain/repository.js";

export class PaymentService {
  constructor(
    private readonly repository: PaymentRepository,
    private readonly grantPurchaseCredits: GrantPurchaseCredits,
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

  async confirmOrder(orderId: string): Promise<Order> {
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
        ownerKind: "team",
        ownerId: order.teamId,
        amountMicros: plan.creditMicros,
        idempotencyKey: `order:${orderId}`,
        reason: "subscription",
      });
    }

    return this.repository.markOrderPaid(orderId);
  }
}
