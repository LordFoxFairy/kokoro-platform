import { parsePositiveBigIntString } from "@kokoro/platform-kit";
import { z } from "zod";
import type { Prisma, PrismaClient } from "../../../generated/prisma/index.js";
import {
  assertSameOrderIdempotencyTarget,
  assertSamePaymentEventIdempotencyTarget,
} from "../../domain/idempotency.js";
import type { Order, PaymentEvent, Plan } from "../../domain/payment.js";
import type {
  CreateOrderInput,
  PaymentRepository,
  RecordPaymentEventInput,
  UpsertPlanInput,
} from "../../domain/repository.js";

export class PrismaPaymentRepository implements PaymentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async upsertPlan(input: UpsertPlanInput): Promise<Plan> {
    const amountMinor = parsePositiveBigIntString(input.amountMinor, "amountMinor");
    const plan = await this.prisma.plan.upsert({
      where: {
        key: input.key,
      },
      create: {
        key: input.key,
        name: input.name,
        currency: input.currency,
        amountMinor,
        billingInterval: input.billingInterval,
        status: "active",
      },
      update: {
        name: input.name,
        currency: input.currency,
        amountMinor,
        billingInterval: input.billingInterval,
        status: "active",
      },
    });

    return mapPlan(plan);
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
  if (value === undefined) {
    return {};
  }
  const washed: unknown = JSON.parse(JSON.stringify(value));
  return jsonValueSchema.parse(washed);
}

const jsonValueSchema: z.ZodType<Prisma.InputJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

function mapPlan(plan: {
  id: string;
  key: string;
  name: string;
  currency: string;
  amountMinor: bigint;
  billingInterval: "once" | "month" | "year";
  status: "active" | "disabled";
  createdAt: Date;
  updatedAt: Date;
}): Plan {
  return {
    id: plan.id,
    key: plan.key,
    name: plan.name,
    currency: plan.currency,
    amountMinor: plan.amountMinor.toString(),
    billingInterval: plan.billingInterval,
    status: plan.status,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

function mapOrder(order: {
  id: string;
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
