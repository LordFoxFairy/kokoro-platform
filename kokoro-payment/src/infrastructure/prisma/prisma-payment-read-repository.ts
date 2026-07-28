import type { Prisma, PrismaClient } from "../../../generated/prisma/index.js";
import type { ListOptions } from "../../domain/payment-lifecycle.js";
import type {
  Order,
  PaymentAdminStats,
  PaymentEvent,
  Plan,
  Refund,
  Subscription,
} from "../../domain/payment.js";
import type {
  PaymentAdminRepository,
  PaymentReadCapabilities,
} from "../../domain/read-repository.js";
import type { PaymentProviderConfig } from "../../domain/provider.js";
import { createPrismaClient } from "./prisma-client.js";

export class PrismaPaymentReadRepository implements PaymentAdminRepository {
  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.#prisma = prisma;
  }

  async listPlans(siteId?: string, options?: ListOptions): Promise<Plan[]> {
    const plans = await this.#prisma.plan.findMany({
      where: {
        ...(siteId === undefined ? {} : { siteId }),
        ...visibleRows(options),
      },
      take: 100,
      orderBy: { createdAt: "desc" },
    });
    return plans.map(mapPlan);
  }

  async listOrders(siteId?: string): Promise<Order[]> {
    const orders = await this.#prisma.order.findMany({
      ...(siteId === undefined ? {} : { where: { siteId } }),
      take: 100,
      orderBy: { createdAt: "desc" },
    });
    return orders.map(mapOrder);
  }

  async listSubscriptions(siteId?: string) {
    const subscriptions = await this.#prisma.subscription.findMany({
      where: siteId === undefined ? {} : { plan: { siteId } },
      include: { plan: { select: { siteId: true } } },
      take: 100,
      orderBy: { createdAt: "desc" },
    });
    return subscriptions.map((subscription) => ({
      ...mapSubscription(subscription),
      siteId: subscription.plan.siteId,
    }));
  }

  async readAdminStats(siteId: string): Promise<PaymentAdminStats> {
    const [byStatus, byCurrency] = await Promise.all([
      this.#prisma.order.groupBy({ by: ["status"], where: { siteId }, _count: { _all: true } }),
      this.#prisma.order.groupBy({
        by: ["currency"],
        where: { siteId, status: "paid" },
        _sum: { amountMinor: true },
      }),
    ]);
    const count = (status: string): number =>
      byStatus.find((row) => row.status === status)?._count._all ?? 0;
    return {
      ordersTotal: byStatus.reduce((sum, row) => sum + row._count._all, 0),
      ordersPaid: count("paid"),
      ordersPending: count("pending") + count("confirming"),
      ordersRefunded: count("refunded"),
      ordersCanceled: count("canceled"),
      revenueByCurrency: byCurrency.map((row) => ({
        currency: row.currency,
        amountMinor: (row._sum.amountMinor ?? BigInt(0)).toString(),
      })),
    };
  }

  async listPaymentEvents(): Promise<PaymentEvent[]> {
    const events = await this.#prisma.paymentEvent.findMany({
      take: 100,
      orderBy: { createdAt: "desc" },
    });
    return events.map(mapPaymentEvent);
  }

  async listRefunds(siteId?: string) {
    const refunds = await this.#prisma.refund.findMany({
      where: siteId === undefined ? {} : { order: { siteId } },
      include: { order: { select: { siteId: true } } },
      take: 100,
      orderBy: { createdAt: "desc" },
    });
    return refunds.map((refund) => ({ ...mapRefund(refund), siteId: refund.order.siteId }));
  }

  async listProviders(): Promise<PaymentProviderConfig[]> {
    const providers = await this.#prisma.paymentProvider.findMany({
      take: 100,
      orderBy: { createdAt: "desc" },
    });
    return providers.map(mapProvider);
  }
}

export interface PrismaPaymentReadStore {
  readonly capabilities: PaymentReadCapabilities;
  readonly close: () => Promise<void>;
}

export function createPrismaPaymentReadCapabilities(prisma: PrismaClient): PaymentReadCapabilities {
  const repository = new PrismaPaymentReadRepository(prisma);
  const listPlans = freezeCapability(repository.listPlans.bind(repository));
  const catalog = Object.freeze({ listPlans });
  const admin = Object.freeze({
    listOrders: freezeCapability(repository.listOrders.bind(repository)),
    listPaymentEvents: freezeCapability(repository.listPaymentEvents.bind(repository)),
    listPlans,
    listProviders: freezeCapability(repository.listProviders.bind(repository)),
    listRefunds: freezeCapability(repository.listRefunds.bind(repository)),
    listSubscriptions: freezeCapability(repository.listSubscriptions.bind(repository)),
    readAdminStats: freezeCapability(repository.readAdminStats.bind(repository)),
  });
  return Object.freeze({ catalog, admin });
}

export function openPrismaPaymentReadStore(databaseUrl: string): PrismaPaymentReadStore {
  const prisma = createPrismaClient(databaseUrl);
  const capabilities = createPrismaPaymentReadCapabilities(prisma);
  return Object.freeze({
    capabilities,
    close: freezeCapability(() => prisma.$disconnect()),
  });
}

function freezeCapability<T extends (...args: never[]) => unknown>(capability: T): T {
  return Object.freeze(capability);
}

function visibleRows(options: ListOptions | undefined): { deletedAt: null } | Record<string, never> {
  return options?.includeDeleted === true ? {} : { deletedAt: null };
}

export function mapPlan(plan: {
  id: string;
  siteId: string;
  key: string;
  name: string;
  currency: string;
  amountMinor: bigint;
  creditMicros: bigint;
  billingInterval: "once" | "month" | "year";
  status: "active" | "disabled";
  deletedAt: Date | null;
  deletedBy: string | null;
  deleteReason: string | null;
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
    deletedAt: plan.deletedAt,
    deletedBy: plan.deletedBy,
    deleteReason: plan.deleteReason,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

export function mapOrder(order: {
  id: string;
  siteId: string;
  teamId: string;
  planId: string;
  amountMinor: bigint;
  currency: string;
  status: "pending" | "confirming" | "paid" | "canceled" | "refunded";
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

export function mapPaymentEvent(event: {
  id: string;
  provider: string;
  eventId: string;
  eventType: string;
  payload: Prisma.JsonValue;
  status: "received" | "processed" | "failed";
  lastError: string | null;
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
    lastError: event.lastError,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

export function mapProvider(provider: {
  id: string;
  key: string;
  kind: "stripe" | "alipay" | "wechat" | "mock";
  webhookSecretRef: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}): PaymentProviderConfig {
  return {
    id: provider.id,
    key: provider.key,
    kind: provider.kind,
    webhookSecretRef: provider.webhookSecretRef,
    enabled: provider.enabled,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

export function mapSubscription(subscription: {
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

export function mapRefund(refund: {
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
