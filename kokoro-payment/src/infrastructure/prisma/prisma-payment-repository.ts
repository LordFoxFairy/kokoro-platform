import { parsePositiveBigIntString } from "@kokoro/platform-kit";
import { z } from "zod";
import type { Prisma, PrismaClient } from "../../../generated/prisma/index.js";
import { parseNonNegativeBigIntString } from "../../domain/amount.js";
import {
  assertSameOrderIdempotencyTarget,
  assertSamePaymentEventIdempotencyTarget,
} from "../../domain/idempotency.js";
import {
  OrderNotConfirmableError,
  OrderNotFoundError,
  PaymentProviderNotFoundError,
} from "../../domain/errors.js";
import {
  PaymentLifecycleError,
  type DeleteInput,
  type RestoreInput,
} from "../../domain/payment-lifecycle.js";
import type {
  Order,
  PaymentEvent,
  PaymentEventStatus,
  Plan,
  Refund,
  Subscription,
} from "../../domain/payment.js";
import type { PaymentProviderConfig } from "../../domain/provider.js";
import type {
  CreateOrderInput,
  CreateRefundInput,
  PaymentRepository,
  RecordPaymentEventInput,
  RefundTransition,
  UpsertPlanInput,
  UpsertProviderInput,
  UpsertSubscriptionInput,
} from "../../domain/repository.js";
import {
  mapOrder,
  mapPaymentEvent,
  mapPlan,
  mapProvider,
  mapRefund,
  mapSubscription,
  PrismaPaymentReadRepository,
} from "./prisma-payment-read-repository.js";

export class PrismaPaymentRepository extends PrismaPaymentReadRepository implements PaymentRepository {
  constructor(private readonly prisma: PrismaClient) {
    super(prisma);
  }

  async upsertPlan(input: UpsertPlanInput): Promise<Plan> {
    const amountMinor = parsePositiveBigIntString(input.amountMinor, "amountMinor");
    const creditMicros = parseNonNegativeBigIntString(input.creditMicros ?? "0", "creditMicros");
    const existing = await this.prisma.plan.findUnique({
      where: {
        siteId_key: { siteId: input.siteId, key: input.key },
      },
    });
    if (existing?.deletedAt) {
      throw lifecycleError("payment.plan.deleted", `payment plan deleted: ${existing.id}`, 409);
    }

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

  async findOrderByIdempotencyKey(idempotencyKey: string): Promise<Order | null> {
    const order = await this.prisma.order.findUnique({ where: { idempotencyKey } });
    return order ? mapOrder(order) : null;
  }

  async findPlanById(planId: string): Promise<Plan | null> {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    return plan ? mapPlan(plan) : null;
  }

  async markOrderConfirming(orderId: string): Promise<Order> {
    // 确认意图先落库：pending→confirming 条件转移；已 confirming(重试)/已 paid(幂等)直接返回。
    await this.prisma.order.updateMany({
      where: { id: orderId, status: "pending" },
      data: { status: "confirming" },
    });
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new OrderNotFoundError(orderId);
    }
    if (order.status !== "confirming" && order.status !== "paid") {
      throw new OrderNotConfirmableError(orderId, order.status);
    }
    return mapOrder(order);
  }

  async listStaleConfirmingOrders(before: Date): Promise<Order[]> {
    const rows = await this.prisma.order.findMany({
      where: { status: "confirming", updatedAt: { lt: before } },
      orderBy: { updatedAt: "asc" },
    });
    return rows.map(mapOrder);
  }

  async markOrderPaid(orderId: string): Promise<Order> {
    // WHY: 抢占式条件转移 pending|confirming→paid，并发确认只一方生效；已 paid 幂等返回，其余拒绝。
    const transition = await this.prisma.order.updateMany({
      where: { id: orderId, status: { in: ["pending", "confirming"] } },
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

  async upsertSubscription(input: UpsertSubscriptionInput): Promise<Subscription> {
    // 幂等键 (provider, providerSubscriptionId)：续期只推状态与周期，不重建行。
    const subscription = await this.prisma.subscription.upsert({
      where: {
        provider_providerSubscriptionId: {
          provider: input.provider,
          providerSubscriptionId: input.providerSubscriptionId,
        },
      },
      create: {
        provider: input.provider,
        providerSubscriptionId: input.providerSubscriptionId,
        teamId: input.teamId,
        planId: input.planId,
        status: input.status,
        currentPeriodStart: input.currentPeriodStart,
        currentPeriodEnd: input.currentPeriodEnd,
      },
      update: {
        status: input.status,
        currentPeriodStart: input.currentPeriodStart,
        currentPeriodEnd: input.currentPeriodEnd,
      },
    });
    return mapSubscription(subscription);
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

  async upsertProvider(input: UpsertProviderInput): Promise<PaymentProviderConfig> {
    const provider = await this.prisma.paymentProvider.upsert({
      where: { key: input.key },
      create: {
        key: input.key,
        kind: input.kind,
        webhookSecretRef: input.webhookSecretRef,
        enabled: input.enabled,
      },
      update: {
        kind: input.kind,
        webhookSecretRef: input.webhookSecretRef,
        enabled: input.enabled,
      },
    });
    return mapProvider(provider);
  }

  async findProviderByKey(key: string): Promise<PaymentProviderConfig | null> {
    const provider = await this.prisma.paymentProvider.findUnique({ where: { key } });
    return provider ? mapProvider(provider) : null;
  }

  async deleteProvider(key: string): Promise<PaymentProviderConfig> {
    const existing = await this.prisma.paymentProvider.findUnique({ where: { key } });
    if (!existing) {
      throw new PaymentProviderNotFoundError(key);
    }
    const deleted = await this.prisma.paymentProvider.delete({ where: { key } });
    return mapProvider(deleted);
  }

  async findPaymentEventById(id: string): Promise<PaymentEvent | null> {
    const event = await this.prisma.paymentEvent.findUnique({ where: { id } });
    return event ? mapPaymentEvent(event) : null;
  }

  async transitionPaymentEventStatus(
    id: string,
    from: PaymentEventStatus[],
    to: PaymentEventStatus,
    lastError: string | null,
  ): Promise<PaymentEvent | null> {
    // 条件转移：并发处理同一事件时只一方生效，败者拿 null 不覆盖赢家结果。
    const transition = await this.prisma.paymentEvent.updateMany({
      where: { id, status: { in: from } },
      data: { status: to, lastError },
    });
    if (transition.count === 0) {
      return null;
    }
    const event = await this.prisma.paymentEvent.findUniqueOrThrow({ where: { id } });
    return mapPaymentEvent(event);
  }

  async findRefundByOrderId(orderId: string): Promise<Refund | null> {
    const refund = await this.prisma.refund.findFirst({
      where: { orderId },
      orderBy: { createdAt: "desc" },
    });
    return refund ? mapRefund(refund) : null;
  }

  async deletePlan(input: DeleteInput): Promise<Plan> {
    const existing = await this.prisma.plan.findUnique({ where: { id: input.id } });
    if (!existing) {
      throw lifecycleError("payment.plan.not_found", `payment plan not found: ${input.id}`, 404);
    }
    if (existing.deletedAt) {
      return mapPlan(existing);
    }
    const deleted = await this.prisma.plan.update({
      where: { id: input.id },
      data: deletionData(input),
    });
    return mapPlan(deleted);
  }

  async restorePlan(input: RestoreInput): Promise<Plan> {
    const existing = await this.prisma.plan.findUnique({ where: { id: input.id } });
    if (!existing) {
      throw lifecycleError("payment.plan.not_found", `payment plan not found: ${input.id}`, 404);
    }
    if (!existing.deletedAt) {
      return mapPlan(existing);
    }
    const restored = await this.prisma.plan.update({
      where: { id: input.id },
      data: restoreData(),
    });
    return mapPlan(restored);
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
          siteId: existing.siteId,
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
          siteId: existing.siteId,
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

function deletionData(input: DeleteInput): {
  deletedAt: Date;
  deletedBy: string;
  deleteReason: string | null;
} {
  return {
    deletedAt: new Date(),
    deletedBy: input.deletedBy,
    deleteReason: input.reason ?? null,
  };
}

function restoreData(): {
  deletedAt: null;
  deletedBy: null;
  deleteReason: null;
} {
  return {
    deletedAt: null,
    deletedBy: null,
    deleteReason: null,
  };
}

function lifecycleError(
  code: ConstructorParameters<typeof PaymentLifecycleError>[0],
  message: string,
  statusCode: number,
): PaymentLifecycleError {
  return new PaymentLifecycleError(code, message, statusCode);
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
