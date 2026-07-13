import { beforeEach, describe, expect, it } from "vitest";
import { PaymentService } from "../../src/application/payment-service.js";
import { PaymentWebhookService } from "../../src/application/webhook-service.js";
import { PaymentEventNotFoundError } from "../../src/domain/errors.js";
import type {
  Order,
  PaymentEvent,
  PaymentEventStatus,
  Plan,
  Refund,
  Subscription,
} from "../../src/domain/payment.js";
import type { PaymentProviderConfig } from "../../src/domain/provider.js";
import { WEBHOOK_EVENT, WebhookError } from "../../src/domain/webhook.js";
import type {
  CreateOrderInput,
  CreateRefundInput,
  GrantPurchaseCreditsInput,
  PaymentRepository,
  RecordPaymentEventInput,
  RefundTransition,
  UpsertPlanInput,
  UpsertProviderInput,
  UpsertSubscriptionInput,
} from "../../src/domain/repository.js";
import type { DeleteInput, RestoreInput } from "../../src/domain/payment-lifecycle.js";
import {
  MOCK_WEBHOOK_SIGNATURE_HEADER,
  signMockWebhook,
} from "../../src/infrastructure/webhook/mock-webhook-provider.js";
import { createWebhookProviderRegistry } from "../../src/infrastructure/webhook/webhook-provider-registry.js";

const SECRET_ENV = "KOKORO_PAYMENT_WEBHOOK_SECRET_MOCK";
const SECRET = "example-token";

const plan: Plan = {
  id: "plan_1",
  siteId: "site_1",
  key: "studio",
  name: "Studio",
  currency: "USD",
  amountMinor: "4900",
  creditMicros: "1000000",
  billingInterval: "month",
  status: "active",
  deletedAt: null,
  deletedBy: null,
  deleteReason: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

// 事件/provider/订单聚焦的内存假仓；webhook 链路未触达的方法显式抛错，误用即炸。
class InMemoryWebhookRepository implements PaymentRepository {
  providers = new Map<string, PaymentProviderConfig>();
  events = new Map<string, PaymentEvent>();
  orders = new Map<string, Order>();
  subscriptions = new Map<string, Subscription>();
  refunds = new Map<string, Refund>();
  private sequence = 0;

  async upsertProvider(input: UpsertProviderInput): Promise<PaymentProviderConfig> {
    const existing = this.providers.get(input.key);
    const config: PaymentProviderConfig = {
      id: existing?.id ?? `prov_${(this.sequence += 1)}`,
      ...input,
      createdAt: existing?.createdAt ?? new Date(0),
      updatedAt: new Date(0),
    };
    this.providers.set(input.key, config);
    return config;
  }

  async findProviderByKey(key: string): Promise<PaymentProviderConfig | null> {
    return this.providers.get(key) ?? null;
  }

  async deleteProvider(key: string): Promise<PaymentProviderConfig> {
    const existing = this.providers.get(key);
    if (!existing) {
      throw new Error(`provider missing: ${key}`);
    }
    this.providers.delete(key);
    return existing;
  }

  async listProviders(): Promise<PaymentProviderConfig[]> {
    return [...this.providers.values()];
  }

  async recordPaymentEvent(input: RecordPaymentEventInput): Promise<PaymentEvent> {
    const dedupeKey = `${input.provider}:${input.eventId}`;
    const existing = this.events.get(dedupeKey);
    if (existing) {
      return existing;
    }
    const event: PaymentEvent = {
      id: `evt_db_${(this.sequence += 1)}`,
      provider: input.provider,
      eventId: input.eventId,
      eventType: input.eventType,
      payload: input.payload ?? {},
      status: "received",
      lastError: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    this.events.set(dedupeKey, event);
    return event;
  }

  async findPaymentEventById(id: string): Promise<PaymentEvent | null> {
    return [...this.events.values()].find((event) => event.id === id) ?? null;
  }

  async transitionPaymentEventStatus(
    id: string,
    from: PaymentEventStatus[],
    to: PaymentEventStatus,
    lastError: string | null,
  ): Promise<PaymentEvent | null> {
    const entry = [...this.events.entries()].find(([, event]) => event.id === id);
    if (!entry || !from.includes(entry[1].status)) {
      return null;
    }
    const updated: PaymentEvent = { ...entry[1], status: to, lastError };
    this.events.set(entry[0], updated);
    return updated;
  }

  async findOrderById(orderId: string): Promise<Order | null> {
    return this.orders.get(orderId) ?? null;
  }

  async findPlanById(planId: string): Promise<Plan | null> {
    return planId === plan.id ? plan : null;
  }

  async markOrderConfirming(orderId: string): Promise<Order> {
    return this.setOrderStatus(orderId, "confirming");
  }

  async markOrderPaid(orderId: string): Promise<Order> {
    return this.setOrderStatus(orderId, "paid");
  }

  private setOrderStatus(orderId: string, status: Order["status"]): Order {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new Error(`order missing: ${orderId}`);
    }
    const updated = { ...order, status };
    this.orders.set(orderId, updated);
    return updated;
  }

  async upsertSubscription(input: UpsertSubscriptionInput): Promise<Subscription> {
    const key = `${input.provider}:${input.providerSubscriptionId}`;
    const existing = this.subscriptions.get(key);
    const subscription: Subscription = {
      id: existing?.id ?? `sub_${(this.sequence += 1)}`,
      teamId: input.teamId,
      planId: input.planId,
      status: input.status,
      provider: input.provider,
      providerSubscriptionId: input.providerSubscriptionId,
      currentPeriodStart: input.currentPeriodStart,
      currentPeriodEnd: input.currentPeriodEnd,
      metadata: null,
      createdAt: existing?.createdAt ?? new Date(0),
      updatedAt: new Date(0),
    };
    this.subscriptions.set(key, subscription);
    return subscription;
  }

  async refundOrderAtomically(orderId: string, input: CreateRefundInput): Promise<RefundTransition> {
    const order = this.orders.get(orderId);
    if (!order || order.status !== "paid") {
      return { transitioned: false, refund: null };
    }
    this.orders.set(orderId, { ...order, status: "refunded" });
    const refund: Refund = {
      id: `refund_${(this.sequence += 1)}`,
      orderId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: input.status,
      reason: input.reason ?? null,
      metadata: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    this.refunds.set(orderId, refund);
    return { transitioned: true, refund };
  }

  async findRefundByOrderId(orderId: string): Promise<Refund | null> {
    return this.refunds.get(orderId) ?? null;
  }

  async upsertPlan(_input: UpsertPlanInput): Promise<Plan> {
    throw new Error("not used in webhook tests");
  }
  async createOrder(_input: CreateOrderInput): Promise<Order> {
    throw new Error("not used in webhook tests");
  }
  async listStaleConfirmingOrders(_before: Date): Promise<Order[]> {
    throw new Error("not used in webhook tests");
  }
  async deletePlan(_input: DeleteInput): Promise<Plan> {
    throw new Error("not used in webhook tests");
  }
  async restorePlan(_input: RestoreInput): Promise<Plan> {
    throw new Error("not used in webhook tests");
  }
  async listPlans(): Promise<Plan[]> {
    throw new Error("not used in webhook tests");
  }
  async listOrders(): Promise<Order[]> {
    throw new Error("not used in webhook tests");
  }
  async listSubscriptions(): Promise<never[]> {
    throw new Error("not used in webhook tests");
  }
  async listPaymentEvents(): Promise<PaymentEvent[]> {
    throw new Error("not used in webhook tests");
  }
  async listRefunds(): Promise<never[]> {
    throw new Error("not used in webhook tests");
  }
}

interface Harness {
  repo: InMemoryWebhookRepository;
  service: PaymentWebhookService;
  grants: GrantPurchaseCreditsInput[];
  secrets: Record<string, string>;
}

function makeHarness(): Harness {
  const repo = new InMemoryWebhookRepository();
  const grants: GrantPurchaseCreditsInput[] = [];
  const paymentService = new PaymentService(
    repo,
    async (input) => {
      grants.push(input);
    },
    async () => {},
  );
  const secrets: Record<string, string> = { [SECRET_ENV]: SECRET };
  const service = new PaymentWebhookService(
    repo,
    paymentService,
    createWebhookProviderRegistry(),
    (secretRef) => secrets[secretRef],
  );
  return { repo, service, grants, secrets };
}

function seedOrder(repo: InMemoryWebhookRepository, id = "order_1"): Order {
  const order: Order = {
    id,
    siteId: "site_1",
    teamId: "team_1",
    planId: plan.id,
    amountMinor: "4900",
    currency: "USD",
    status: "pending",
    idempotencyKey: `key_${id}`,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  repo.orders.set(id, order);
  return order;
}

function webhookBody(eventId: string, eventType: string, orderId?: string): Buffer {
  return Buffer.from(
    JSON.stringify({ eventId, eventType, ...(orderId ? { data: { orderId } } : {}) }),
  );
}

function signedHeaders(body: Buffer, secret = SECRET): Record<string, string> {
  return { [MOCK_WEBHOOK_SIGNATURE_HEADER]: signMockWebhook(body, secret) };
}

let harness: Harness;

beforeEach(async () => {
  harness = makeHarness();
  await harness.repo.upsertProvider({
    key: "mockpay",
    kind: "mock",
    webhookSecretRef: SECRET_ENV,
    enabled: true,
  });
});

describe("PaymentWebhookService receiveWebhook guards", () => {
  it("rejects an unknown provider with 404", async () => {
    const body = webhookBody("evt_1", "ping");
    await expect(
      harness.service.receiveWebhook("nope", signedHeaders(body), body, "req_1"),
    ).rejects.toMatchObject({ statusCode: 404, code: "payment.webhook_provider_unknown" });
  });

  it("rejects a disabled provider with 404 without recording an event", async () => {
    await harness.repo.upsertProvider({
      key: "mockpay",
      kind: "mock",
      webhookSecretRef: SECRET_ENV,
      enabled: false,
    });
    const body = webhookBody("evt_1", "ping");
    await expect(
      harness.service.receiveWebhook("mockpay", signedHeaders(body), body, "req_1"),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(harness.repo.events.size).toBe(0);
  });

  it("rejects a provider kind without an implemented verifier with 501", async () => {
    await harness.repo.upsertProvider({
      key: "stripe_main",
      kind: "stripe",
      webhookSecretRef: SECRET_ENV,
      enabled: true,
    });
    const body = webhookBody("evt_1", "ping");
    await expect(
      harness.service.receiveWebhook("stripe_main", signedHeaders(body), body, "req_1"),
    ).rejects.toMatchObject({ statusCode: 501, code: "payment.webhook_provider_not_implemented" });
  });

  it("fails closed with 500 when the secret env ref is dangling", async () => {
    delete harness.secrets[SECRET_ENV];
    const body = webhookBody("evt_1", "ping");
    await expect(
      harness.service.receiveWebhook("mockpay", signedHeaders(body), body, "req_1"),
    ).rejects.toMatchObject({ statusCode: 500, code: "payment.webhook_secret_unavailable" });
  });

  it("rejects a bad signature with 401 and records nothing", async () => {
    const body = webhookBody("evt_1", "ping");
    await expect(
      harness.service.receiveWebhook("mockpay", signedHeaders(body, "wrong"), body, "req_1"),
    ).rejects.toMatchObject({ statusCode: 401, code: "payment.webhook_signature_invalid" });
    expect(harness.repo.events.size).toBe(0);
  });

  it("rejects a missing signature header with 401", async () => {
    const body = webhookBody("evt_1", "ping");
    await expect(harness.service.receiveWebhook("mockpay", {}, body, "req_1")).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it("rejects a signed non-JSON body with 400", async () => {
    const body = Buffer.from("not json");
    await expect(
      harness.service.receiveWebhook("mockpay", signedHeaders(body), body, "req_1"),
    ).rejects.toMatchObject({ statusCode: 400, code: "payment.webhook_payload_invalid" });
  });

  it("rejects a signed JSON body missing the envelope with 400", async () => {
    const body = Buffer.from(JSON.stringify({ hello: "world" }));
    await expect(
      harness.service.receiveWebhook("mockpay", signedHeaders(body), body, "req_1"),
    ).rejects.toBeInstanceOf(WebhookError);
  });
});

describe("PaymentWebhookService state machine", () => {
  it("payment_succeeded drives confirmOrder and lands processed", async () => {
    const order = seedOrder(harness.repo);
    const body = webhookBody("evt_ok", "payment_succeeded", order.id);
    const receipt = await harness.service.receiveWebhook("mockpay", signedHeaders(body), body, "req_1");
    expect(receipt.duplicate).toBe(false);
    expect(receipt.event.status).toBe("processed");
    expect(receipt.event.lastError).toBeNull();
    expect(harness.repo.orders.get(order.id)?.status).toBe("paid");
    expect(harness.grants).toHaveLength(1);
    expect(harness.grants[0]?.idempotencyKey).toBe(`order:${order.id}`);
  });

  it("acks event types without order linkage as processed (no side effects)", async () => {
    const body = webhookBody("evt_ping", "ping");
    const receipt = await harness.service.receiveWebhook("mockpay", signedHeaders(body), body, "req_1");
    expect(receipt.event.status).toBe("processed");
    expect(harness.grants).toHaveLength(0);
  });

  it("marks the event failed with lastError when processing fails", async () => {
    const body = webhookBody("evt_fail", "payment_succeeded", "order_missing");
    const receipt = await harness.service.receiveWebhook("mockpay", signedHeaders(body), body, "req_1");
    expect(receipt.duplicate).toBe(false);
    expect(receipt.event.status).toBe("failed");
    expect(receipt.event.lastError).toContain("order_missing");
  });

  it("marks payment_succeeded without orderId as failed", async () => {
    const body = webhookBody("evt_noorder", "payment_succeeded");
    const receipt = await harness.service.receiveWebhook("mockpay", signedHeaders(body), body, "req_1");
    expect(receipt.event.status).toBe("failed");
    expect(receipt.event.lastError).toContain("orderId");
  });

  it("is replay-safe: a duplicate webhook returns 200-idempotent without reprocessing", async () => {
    const order = seedOrder(harness.repo);
    const body = webhookBody("evt_dup", "payment_succeeded", order.id);
    const first = await harness.service.receiveWebhook("mockpay", signedHeaders(body), body, "req_1");
    const second = await harness.service.receiveWebhook("mockpay", signedHeaders(body), body, "req_2");
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.event.id).toBe(first.event.id);
    expect(harness.grants).toHaveLength(1);
    expect(harness.repo.events.size).toBe(1);
  });

  it("does not reprocess a duplicate of a failed event (manual replay owns retries)", async () => {
    const body = webhookBody("evt_dupfail", "payment_succeeded", "order_missing");
    await harness.service.receiveWebhook("mockpay", signedHeaders(body), body, "req_1");
    const second = await harness.service.receiveWebhook("mockpay", signedHeaders(body), body, "req_2");
    expect(second.duplicate).toBe(true);
    expect(second.event.status).toBe("failed");
  });
});

function subscriptionBody(
  eventId: string,
  subscription: {
    providerSubscriptionId: string;
    teamId: string;
    planId: string;
    status: "active" | "past_due" | "canceled";
    currentPeriodStart?: string;
  },
): Buffer {
  return Buffer.from(
    JSON.stringify({
      eventId,
      eventType: WEBHOOK_EVENT.subscriptionUpdated,
      data: { subscription },
    }),
  );
}

describe("PaymentWebhookService refund events", () => {
  function seedPaidOrder(repo: InMemoryWebhookRepository, id = "order_paid"): Order {
    const order = seedOrder(repo, id);
    repo.orders.set(id, { ...order, status: "paid" });
    return repo.orders.get(id) as Order;
  }

  it("refund_succeeded reverses a paid order and lands processed", async () => {
    seedPaidOrder(harness.repo);
    const body = webhookBody("evt_refund", WEBHOOK_EVENT.refundSucceeded, "order_paid");
    const receipt = await harness.service.receiveWebhook("mockpay", signedHeaders(body), body, "req_1");
    expect(receipt.event.status).toBe("processed");
    expect(harness.repo.orders.get("order_paid")?.status).toBe("refunded");
    expect(harness.repo.refunds.get("order_paid")).toBeDefined();
  });

  it("marks refund_succeeded without orderId as failed", async () => {
    const body = webhookBody("evt_refund_noorder", WEBHOOK_EVENT.refundSucceeded);
    const receipt = await harness.service.receiveWebhook("mockpay", signedHeaders(body), body, "req_1");
    expect(receipt.event.status).toBe("failed");
    expect(receipt.event.lastError).toContain("orderId");
  });

  it("is idempotent on replay: refund event replays without a second reversal", async () => {
    seedPaidOrder(harness.repo);
    const body = webhookBody("evt_refund_dup", WEBHOOK_EVENT.refundSucceeded, "order_paid");
    const first = await harness.service.receiveWebhook("mockpay", signedHeaders(body), body, "req_1");
    const replayed = await harness.service.replayEvent(first.event.id, "req_2");
    expect(replayed.status).toBe("processed");
    // 仍只有一条退款记录（order-refund:<id> 幂等 + refunded 幂等返回既有 Refund）。
    expect(harness.repo.refunds.size).toBe(1);
  });
});

describe("PaymentWebhookService subscription events", () => {
  it("subscription_updated active upserts the subscription and grants period credits", async () => {
    const body = subscriptionBody("evt_sub", {
      providerSubscriptionId: "psub_1",
      teamId: "team_1",
      planId: plan.id,
      status: "active",
      currentPeriodStart: "2026-07-01T00:00:00.000Z",
    });
    const receipt = await harness.service.receiveWebhook("mockpay", signedHeaders(body), body, "req_1");
    expect(receipt.event.status).toBe("processed");
    const sub = harness.repo.subscriptions.get("mockpay:psub_1");
    expect(sub?.status).toBe("active");
    expect(harness.grants).toHaveLength(1);
    expect(harness.grants[0]?.idempotencyKey).toBe(
      "subscription:mockpay:psub_1:2026-07-01T00:00:00.000Z",
    );
    expect(harness.grants[0]?.reason).toBe("subscription");
  });

  it("subscription_updated past_due推状态但不发放积分", async () => {
    const body = subscriptionBody("evt_sub_pd", {
      providerSubscriptionId: "psub_2",
      teamId: "team_1",
      planId: plan.id,
      status: "past_due",
    });
    const receipt = await harness.service.receiveWebhook("mockpay", signedHeaders(body), body, "req_1");
    expect(receipt.event.status).toBe("processed");
    expect(harness.repo.subscriptions.get("mockpay:psub_2")?.status).toBe("past_due");
    expect(harness.grants).toHaveLength(0);
  });

  it("续期新周期产生新的幂等键触发再次发放", async () => {
    const first = subscriptionBody("evt_sub_p1", {
      providerSubscriptionId: "psub_3",
      teamId: "team_1",
      planId: plan.id,
      status: "active",
      currentPeriodStart: "2026-07-01T00:00:00.000Z",
    });
    const second = subscriptionBody("evt_sub_p2", {
      providerSubscriptionId: "psub_3",
      teamId: "team_1",
      planId: plan.id,
      status: "active",
      currentPeriodStart: "2026-08-01T00:00:00.000Z",
    });
    await harness.service.receiveWebhook("mockpay", signedHeaders(first), first, "req_1");
    await harness.service.receiveWebhook("mockpay", signedHeaders(second), second, "req_2");
    expect(harness.grants.map((grant) => grant.idempotencyKey)).toEqual([
      "subscription:mockpay:psub_3:2026-07-01T00:00:00.000Z",
      "subscription:mockpay:psub_3:2026-08-01T00:00:00.000Z",
    ]);
    // 同一订阅行被更新而非重建。
    expect(harness.repo.subscriptions.size).toBe(1);
  });
});

describe("PaymentWebhookService replayEvent", () => {
  it("throws PaymentEventNotFoundError for an unknown event id", async () => {
    await expect(harness.service.replayEvent("evt_missing", "req_1")).rejects.toBeInstanceOf(
      PaymentEventNotFoundError,
    );
  });

  it("returns a processed event as-is (idempotent)", async () => {
    const order = seedOrder(harness.repo);
    const body = webhookBody("evt_done", "payment_succeeded", order.id);
    const receipt = await harness.service.receiveWebhook("mockpay", signedHeaders(body), body, "req_1");
    const replayed = await harness.service.replayEvent(receipt.event.id, "req_2");
    expect(replayed.status).toBe("processed");
    expect(harness.grants).toHaveLength(1);
  });

  it("retries a failed event to processed once the blocker is gone", async () => {
    const body = webhookBody("evt_retry", "payment_succeeded", "order_late");
    const failed = await harness.service.receiveWebhook("mockpay", signedHeaders(body), body, "req_1");
    expect(failed.event.status).toBe("failed");

    seedOrder(harness.repo, "order_late");
    const replayed = await harness.service.replayEvent(failed.event.id, "req_2");
    expect(replayed.status).toBe("processed");
    expect(replayed.lastError).toBeNull();
    expect(harness.repo.orders.get("order_late")?.status).toBe("paid");
  });

  it("keeps a still-broken failed event in failed with a fresh lastError", async () => {
    const body = webhookBody("evt_stillbad", "payment_succeeded", "order_never");
    const failed = await harness.service.receiveWebhook("mockpay", signedHeaders(body), body, "req_1");
    const replayed = await harness.service.replayEvent(failed.event.id, "req_2");
    expect(replayed.status).toBe("failed");
    expect(replayed.lastError).toContain("order_never");
  });

  it("throws 404 when the provider config behind the event was deleted", async () => {
    const body = webhookBody("evt_orphan", "payment_succeeded", "order_missing");
    const failed = await harness.service.receiveWebhook("mockpay", signedHeaders(body), body, "req_1");
    await harness.repo.deleteProvider("mockpay");
    await expect(harness.service.replayEvent(failed.event.id, "req_2")).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe("PaymentWebhookService provider config passthrough", () => {
  it("upserts, lists and deletes provider configs", async () => {
    const created = await harness.service.upsertProvider({
      key: "mockpay2",
      kind: "mock",
      webhookSecretRef: SECRET_ENV,
      enabled: false,
    });
    expect(created.enabled).toBe(false);
    const listed = await harness.service.listProviders();
    expect(listed.map((provider) => provider.key).sort()).toEqual(["mockpay", "mockpay2"]);
    const deleted = await harness.service.deleteProvider("mockpay2");
    expect(deleted.key).toBe("mockpay2");
    expect(await harness.service.listProviders()).toHaveLength(1);
  });
});
