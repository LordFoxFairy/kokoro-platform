import { createHash, randomUUID } from "node:crypto";
import { parsePositiveBigIntString } from "@kokoro/platform-kit";
import { parseNonNegativeBigIntString } from "../domain/amount.js";
import {
  CheckoutUnavailableError,
  OrderAmountMismatchError,
  OrderNotConfirmableError,
  OrderNotFoundError,
  OrderNotRefundableError,
  PlanNotFoundError,
} from "../domain/errors.js";
import { assertSameOrderIdempotencyTarget } from "../domain/idempotency.js";
import type { Order, Plan, Refund, Subscription } from "../domain/payment.js";
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

  // 在售套餐目录（PAY-2 storefront 读面）：仅暴露本站 active 且未删除的套餐，供 web 价格页枚举，
  // web 不再硬编码价格。软删除行由 listPlans 默认排除；此处再滤 status，草稿/停售套餐不进店面。
  async listSellablePlans(siteId: string): Promise<Plan[]> {
    const plans = await this.repository.listPlans(siteId);
    return plans.filter((plan) => plan.status === "active" && !plan.deletedAt);
  }

  // 收银台意图（PAY-2）：校验套餐可售（不存在/他站/停售/已删 → 404），再向 provider 取托管收银台跳转。
  // V1 现状：无任何 provider 接入托管收银台会话创建（既有 provider 仅做 webhook 验签），故诚实返回
  // 501——web 据此渲染「支付暂未开通」禁用态（状态真来自后端，非假按钮）。provider 托管收银台落地后，
  // happy path 在此接入：建单 + 生成 provider checkout URL 返回。
  // 收银台会话：套餐可售校验后，向可用收银台 provider 取跳转 URL。
  // dev/mock 档：mock provider 已启用 → 建单 + 返回 web 模拟收银台 URL（用户在此确认支付 → mock webhook
  // → confirmOrder 到账）。真托管收银台（Stripe/支付宝/微信）在此按 provider 创建真 session 并返回其 URL。
  // 无任何可用收银台 provider → 诚实 501（web 渲染「支付暂未开通」）。
  async startCheckout(input: {
    siteId: string;
    teamId: string;
    planId: string;
  }): Promise<{ orderId: string; checkoutUrl: string }> {
    const plan = await this.repository.findPlanById(input.planId);
    assertPlanSellable(plan, input.siteId, input.planId);
    const mock = await this.repository.findProviderByKey("mock");
    if (!mock || !mock.enabled) {
      throw new CheckoutUnavailableError();
    }
    const order = await this.repository.createOrder({
      siteId: input.siteId,
      teamId: input.teamId,
      planId: input.planId,
      amountMinor: plan.amountMinor,
      currency: plan.currency,
      idempotencyKey: `checkout:${input.teamId}:${input.planId}:${randomUUID()}`,
    });
    // 相对路径（web 同源）：dev 模拟收银台页 /billing/pay/<orderId>。
    return { orderId: order.id, checkoutUrl: `/billing/pay/${order.id}` };
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

  // WHY: 管理员不走支付直接发权益：site + request 的定长哈希锁定同一订单目标；先恢复订单
  // 快照再看可变 Plan，确保套餐改价/停售/删除不破坏既有 paid 重放。
  async grantPlanToTeam(
    siteId: string,
    teamId: string,
    planId: string,
    requestId: string,
  ): Promise<Order> {
    const idempotencyKey = adminGrantIdempotencyKey(siteId, requestId);
    const existing = await this.repository.findOrderByIdempotencyKey(idempotencyKey);
    if (existing) {
      assertSameOrderIdempotencyTarget(existing, {
        siteId,
        teamId,
        planId,
        amountMinor: existing.amountMinor,
        currency: existing.currency,
        idempotencyKey,
      });
      return this.confirmOrder(existing.id, requestId);
    }

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
      idempotencyKey,
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

function adminGrantIdempotencyKey(siteId: string, requestId: string): string {
  const hash = createHash("sha256");
  for (const value of ["admin-grant", "v1", siteId, requestId]) {
    const bytes = Buffer.from(value, "utf8");
    hash.update(String(bytes.byteLength));
    hash.update(":");
    hash.update(bytes);
  }
  return `admin-grant:v1:${hash.digest("hex")}`;
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
