import { parsePositiveBigIntString } from "@kokoro/platform-kit";
import { z } from "zod";
import type { Prisma, PrismaClient } from "../../../generated/prisma/index.js";
import { parseNonNegativeBigIntString } from "../../domain/amount.js";
import {
  assertSameOrderIdempotencyTarget,
  assertSamePaymentEventIdempotencyTarget,
} from "../../domain/idempotency.js";
import { OrderNotConfirmableError, OrderNotFoundError } from "../../domain/errors.js";
import type { Order, PaymentEvent, Plan, Refund, Subscription } from "../../domain/payment.js";
import type {
  CreateOrderInput,
  CreateRefundInput,
  PaymentRepository,
  RecordPaymentEventInput,
  RefundTransition,
  UpsertPlanInput,
} from "../../domain/repository.js";

export class PrismaPaymentRepository implements PaymentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async upsertPlan(input: UpsertPlanInput): Promise<Plan> {
    const amountMinor = parsePositiveBigIntString(input.amountMinor, "amountMinor");
    const creditMicros = parseNonNegativeBigIntString(input.creditMicros ?? "0", "creditMicros");
    const plan = await this.prisma.plan.upsert({
      where: {
        siteId_key: { siteId: input.siteId, key: input.key },
      },
      create: {
        siteId: input.siteId,
        key: input.key,
        name: input.name,
        currency: input.currency,
        amountMinor,
        creditMicros,
        billingInterval: input.billingInterval,
        status: "active",
      },
      update: {
        name: input.name,
        currency: input.currency,
        amountMinor,
        creditMicros,
        billingInterval: input.billingInterval,
        status: "active",
      },
    });

    return mapPlan(plan);
  }

  async findOrderById(orderId: string): Promise<Order | null> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    return order ? mapOrder(order) : null;
  }

  async findPlanById(planId: string): Promise<Plan | null> {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    return plan ? mapPlan(plan) : null;
  }

  async markOrderPaid(orderId: string): Promise<Order> {
    // WHY: 抢占式条件转移 pending→paid，并发确认只一方生效；已 paid 幂等返回，非 pending 拒绝。
    const transition = await this.prisma.order.updateMany({
      where: { id: orderId, status: "pending" },
      data: { status: "paid" },
    });
    if (transition.count === 0) {
      const order = await this.prisma.order.findUnique({ where: { id: orderId } });
      if (!order) {
        throw new OrderNotFoundError(orderId);
      }
      if (order.status !== "paid") {
        throw new OrderNotConfirmableError(orderId, order.status);
      }
      return mapOrder(order);
    }
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    return mapOrder(order);
  }

  async refundOrderAtomically(orderId: string, input: CreateRefundInput): Promise<RefundTransition> {
    const amountMinor = parsePositiveBigIntString(input.amountMinor, "amountMinor");
    // WHY: 条件转移 paid→refunded 与建 Refund 同一事务原子；count=0(已退款/被并发抢先)则不建记录。
    return this.prisma.$transaction(async (tx) => {
      const transition = await tx.order.updateMany({
        where: { id: orderId, status: "paid" },
        data: { status: "refunded" },
      });
      if (transition.count === 0) {
        return { transitioned: false, refund: null };
      }
      const refund = await tx.refund.create({
        data: {
          orderId: input.orderId,
          amountMinor,
          currency: input.currency,
          status: input.status,
          reason: input.reason ?? null,
        },
      });
      return { transitioned: true, refund: mapRefund(refund) };
    });
  }

  async findRefundByOrderId(orderId: string): Promise<Refund | null> {
    const refund = await this.prisma.refund.findFirst({
      where: { orderId },
      orderBy: { createdAt: "desc" },
    });
    return refund ? mapRefund(refund) : null;
  }

  async listPlans(siteId?: string): Promise<Plan[]> {
    const plans = await this.prisma.plan.findMany({
      ...(siteId === undefined ? {} : { where: { siteId } }),
      take: 100,
      orderBy: { createdAt: "desc" },
    });
    return plans.map(mapPlan);
  }

  async listOrders(siteId?: string): Promise<Order[]> {
    const orders = await this.prisma.order.findMany({
      ...(siteId === undefined ? {} : { where: { siteId } }),
      take: 100,
      orderBy: { createdAt: "desc" },
    });
    return orders.map(mapOrder);
  }

  async listSubscriptions(): Promise<Subscription[]> {
    const subscriptions = await this.prisma.subscription.findMany({
      take: 100,
      orderBy: { createdAt: "desc" },
    });
    return subscriptions.map(mapSubscription);
  }

  async listPaymentEvents(): Promise<PaymentEvent[]> {
    const events = await this.prisma.paymentEvent.findMany({
      take: 100,
      orderBy: { createdAt: "desc" },
    });
    return events.map(mapPaymentEvent);
  }

  async listRefunds(): Promise<Refund[]> {
    const refunds = await this.prisma.refund.findMany({
      take: 100,
      orderBy: { createdAt: "desc" },
    });
    return refunds.map(mapRefund);
  }

  async createOrder(input: CreateOrderInput): Promise<Order> {
    const existing = await this.prisma.order.findUnique({
      where: {
        idempotencyKey: input.idempotencyKey,
      },
    });

    if (existing) {
      assertSameOrderIdempotencyTarget(
        {
          teamId: existing.teamId,
          planId: existing.planId,
          amountMinor: existing.amountMinor.toString(),
          currency: existing.currency,
          idempotencyKey: existing.idempotencyKey,
        },
        input,
      );

      return mapOrder(existing);
    }

    const order = await this.createOrderOrReadExisting(input);

    return mapOrder(order);
  }

  async recordPaymentEvent(input: RecordPaymentEventInput): Promise<PaymentEvent> {
    const existing = await this.prisma.paymentEvent.findUnique({
      where: {
        provider_eventId: {
          provider: input.provider,
          eventId: input.eventId,
        },
      },
    });

    if (existing) {
      assertSamePaymentEventIdempotencyTarget(
        {
          provider: existing.provider,
          eventId: existing.eventId,
          eventType: existing.eventType,
          payload: existing.payload,
        },
        input,
      );

      return mapPaymentEvent(existing);
    }

    const event = await this.createPaymentEventOrReadExisting(input);

    return mapPaymentEvent(event);
  }

  private async createOrderOrReadExisting(input: CreateOrderInput) {
    try {
      return await this.prisma.order.create({
        data: {
          siteId: input.siteId,
          teamId: input.teamId,
          planId: input.planId,
          amountMinor: parsePositiveBigIntString(input.amountMinor, "amountMinor"),
          currency: input.currency,
          idempotencyKey: input.idempotencyKey,
          status: "pending",
        },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      const existing = await this.prisma.order.findUniqueOrThrow({
        where: {
          idempotencyKey: input.idempotencyKey,
        },
      });

      assertSameOrderIdempotencyTarget(
        {
          teamId: existing.teamId,
          planId: existing.planId,
          amountMinor: existing.amountMinor.toString(),
          currency: existing.currency,
          idempotencyKey: existing.idempotencyKey,
        },
        input,
      );

      return existing;
    }
  }

  private async createPaymentEventOrReadExisting(input: RecordPaymentEventInput) {
    try {
      return await this.prisma.paymentEvent.create({
        data: {
          provider: input.provider,
          eventId: input.eventId,
          eventType: input.eventType,
          payload: toJson(input.payload),
          status: "received",
        },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      const existing = await this.prisma.paymentEvent.findUniqueOrThrow({
        where: {
          provider_eventId: {
            provider: input.provider,
            eventId: input.eventId,
          },
        },
      });

      assertSamePaymentEventIdempotencyTarget(
        {
          provider: existing.provider,
          eventId: existing.eventId,
          eventType: existing.eventType,
          payload: existing.payload,
        },
        input,
      );

      return existing;
    }
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

// WHY: 序列化再回读，把不可信 payload 洗成纯 JSON 值，避免 InputJsonValue 断言。
function toJson(value: unknown): Prisma.InputJsonValue {
  if (value === undefined || value === null) {
    return {};
  }
  const washed: unknown = JSON.parse(JSON.stringify(value));
  return jsonValueSchema.parse(washed);
}

// WHY: 容器内允许 JSON null（Prisma InputJsonObject/Array 的元素为 InputJsonValue | null）。
const jsonValueSchema: z.ZodType<Prisma.InputJsonValue> = z.lazy(() => {
  const nullableValue = z.union([jsonValueSchema, z.null()]);
  return z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(nullableValue),
    z.record(nullableValue),
  ]);
});

function mapPlan(plan: {
  id: string;
  siteId: string;
  key: string;
  name: string;
  currency: string;
  amountMinor: bigint;
  creditMicros: bigint;
  billingInterval: "once" | "month" | "year";
  status: "active" | "disabled";
  createdAt: Date;
  updatedAt: Date;
}): Plan {
  return {
    id: plan.id,
    siteId: plan.siteId,
    key: plan.key,
    name: plan.name,
    currency: plan.currency,
    amountMinor: plan.amountMinor.toString(),
    creditMicros: plan.creditMicros.toString(),
    billingInterval: plan.billingInterval,
    status: plan.status,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

function mapOrder(order: {
  id: string;
  siteId: string;
  teamId: string;
  planId: string;
  amountMinor: bigint;
  currency: string;
  status: "pending" | "paid" | "canceled" | "refunded";
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
}): Order {
  return {
    id: order.id,
    siteId: order.siteId,
    teamId: order.teamId,
    planId: order.planId,
    amountMinor: order.amountMinor.toString(),
    currency: order.currency,
    status: order.status,
    idempotencyKey: order.idempotencyKey,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

function mapPaymentEvent(event: {
  id: string;
  provider: string;
  eventId: string;
  eventType: string;
  payload: Prisma.JsonValue;
  status: "received" | "processed" | "failed";
  createdAt: Date;
  updatedAt: Date;
}): PaymentEvent {
  return {
    id: event.id,
    provider: event.provider,
    eventId: event.eventId,
    eventType: event.eventType,
    payload: event.payload,
    status: event.status,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

function mapSubscription(subscription: {
  id: string;
  teamId: string;
  planId: string;
  status: "active" | "canceled" | "past_due";
  provider: string | null;
  providerSubscriptionId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  metadata: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}): Subscription {
  return {
    id: subscription.id,
    teamId: subscription.teamId,
    planId: subscription.planId,
    status: subscription.status,
    provider: subscription.provider,
    providerSubscriptionId: subscription.providerSubscriptionId,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    metadata: subscription.metadata,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
  };
}

function mapRefund(refund: {
  id: string;
  orderId: string;
  amountMinor: bigint;
  currency: string;
  status: "pending" | "succeeded" | "failed";
  reason: string | null;
  metadata: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}): Refund {
  return {
    id: refund.id,
    orderId: refund.orderId,
    amountMinor: refund.amountMinor.toString(),
    currency: refund.currency,
    status: refund.status,
    reason: refund.reason,
    metadata: refund.metadata,
    createdAt: refund.createdAt,
    updatedAt: refund.updatedAt,
  };
}
