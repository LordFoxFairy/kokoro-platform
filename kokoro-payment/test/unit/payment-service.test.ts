import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { PaymentService } from "../../src/application/payment-service.js";
import {
  CheckoutUnavailableError,
  OrderAmountMismatchError,
  OrderNotConfirmableError,
  OrderNotFoundError,
  OrderNotRefundableError,
  PaymentIdempotencyConflictError,
  PlanNotFoundError,
} from "../../src/domain/errors.js";
import { assertSameOrderIdempotencyTarget } from "../../src/domain/idempotency.js";
import type { Order, PaymentEvent, Plan, Refund } from "../../src/domain/payment.js";
import type { DeleteInput, RestoreInput } from "../../src/domain/payment-lifecycle.js";
import type {
  CreateOrderInput,
  CreateRefundInput,
  GrantPurchaseCredits,
  GrantPurchaseCreditsInput,
  PaymentRepository,
  RecordPaymentEventInput,
  ReverseCredits,
  ReverseCreditsInput,
  UpsertPlanInput,
} from "../../src/domain/repository.js";
import { registerPaymentAdminRoutes } from "../../src/interfaces/http/admin-routes.js";

const deletionAudit = {
  deletedAt: null,
  deletedBy: null,
  deleteReason: null,
};

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
  ...deletionAudit,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const order: Order = {
  id: "order_1",
  siteId: "site_1",
  teamId: "team_1",
  planId: "plan_1",
  amountMinor: "4900",
  currency: "USD",
  status: "pending",
  idempotencyKey: "k1",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const event: PaymentEvent = {
  id: "evt_1",
  provider: "stripe",
  eventId: "ext_1",
  eventType: "invoice.paid",
  payload: { subscription: "sub_1" },
  status: "received",
  lastError: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const refund: Refund = {
  id: "refund_1",
  orderId: "order_1",
  amountMinor: "4900",
  currency: "USD",
  status: "succeeded",
  reason: "refund",
  metadata: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

interface Fakes {
  repo: PaymentRepository;
  calls: string[];
  createdOrders: Order[];
  grants: GrantPurchaseCreditsInput[];
  grantPurchaseCredits: GrantPurchaseCredits;
  reversals: ReverseCreditsInput[];
  reverseCredits: ReverseCredits;
}

interface FakeOverrides {
  order?: Order | null;
  plan?: Plan | null;
  plans?: Plan[];
  atomicTransitioned?: boolean;
  existingRefund?: Refund | null;
  reverseThrows?: boolean;
  markPaidThrows?: boolean;
  staleConfirming?: Order[];
  plansList?: Plan[];
}

function makeFakes(overrides: FakeOverrides = {}): Fakes {
  const calls: string[] = [];
  const createdOrders: Order[] = [];
  const ordersById = new Map<string, Order>();
  const ordersByIdempotencyKey = new Map<string, Order>();
  const mysqlIdempotencyKey = (key: string) => {
    if (Buffer.byteLength(key, "utf8") > 191) {
      throw new Error("payment_orders.idempotencyKey exceeds VARCHAR(191)");
    }
    return key.toLowerCase();
  };
  const grants: GrantPurchaseCreditsInput[] = [];
  const grantPurchaseCredits: GrantPurchaseCredits = async (input) => {
    grants.push(input);
  };
  const reversals: ReverseCreditsInput[] = [];
  const reverseCredits: ReverseCredits = async (input) => {
    calls.push("reverseCredits");
    if (overrides.reverseThrows) {
      throw new Error("insufficient credit");
    }
    reversals.push(input);
  };
  const repo: PaymentRepository = {
    upsertPlan: async (_input: UpsertPlanInput) => {
      calls.push("upsertPlan");
      return plan;
    },
    createOrder: async (input: CreateOrderInput) => {
      calls.push("createOrder");
      const storageKey = mysqlIdempotencyKey(input.idempotencyKey);
      const existing = ordersByIdempotencyKey.get(storageKey);
      if (existing) {
        assertSameOrderIdempotencyTarget(existing, input);
        return existing;
      }
      const created: Order = {
        id: `order_${createdOrders.length + 1}`,
        ...input,
        status: "pending",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
      createdOrders.push(created);
      ordersById.set(created.id, created);
      ordersByIdempotencyKey.set(storageKey, created);
      return created;
    },
    recordPaymentEvent: async (_input: RecordPaymentEventInput) => {
      calls.push("recordPaymentEvent");
      return event;
    },
    findOrderById: async (orderId: string) => {
      calls.push("findOrderById");
      return overrides.order === undefined ? (ordersById.get(orderId) ?? order) : overrides.order;
    },
    findOrderByIdempotencyKey: async (idempotencyKey: string) => {
      calls.push("findOrderByIdempotencyKey");
      return ordersByIdempotencyKey.get(mysqlIdempotencyKey(idempotencyKey)) ?? null;
    },
    findPlanById: async (planId: string) => {
      calls.push("findPlanById");
      if (overrides.plan !== undefined) {
        return overrides.plan;
      }
      return overrides.plans?.find((candidate) => candidate.id === planId) ?? plan;
    },
    markOrderConfirming: async (orderId: string) => {
      calls.push("markOrderConfirming");
      const confirming = { ...(ordersById.get(orderId) ?? order), id: orderId, status: "confirming" as const };
      ordersById.set(orderId, confirming);
      ordersByIdempotencyKey.set(mysqlIdempotencyKey(confirming.idempotencyKey), confirming);
      return confirming;
    },
    listStaleConfirmingOrders: async (_before: Date) => {
      calls.push("listStaleConfirmingOrders");
      return overrides.staleConfirming ?? [];
    },
    markOrderPaid: async (orderId: string) => {
      calls.push("markOrderPaid");
      if (overrides.markPaidThrows) {
        throw new Error("db down");
      }
      const paid = { ...(ordersById.get(orderId) ?? order), id: orderId, status: "paid" as const };
      ordersById.set(orderId, paid);
      ordersByIdempotencyKey.set(mysqlIdempotencyKey(paid.idempotencyKey), paid);
      return paid;
    },
    upsertSubscription: async (input) => {
      calls.push("upsertSubscription");
      return {
        id: "sub_1",
        teamId: input.teamId,
        planId: input.planId,
        status: input.status,
        provider: input.provider,
        providerSubscriptionId: input.providerSubscriptionId,
        currentPeriodStart: input.currentPeriodStart,
        currentPeriodEnd: input.currentPeriodEnd,
        metadata: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
    },
    refundOrderAtomically: async (_orderId: string, _input: CreateRefundInput) => {
      calls.push("refundOrderAtomically");
      const transitioned = overrides.atomicTransitioned ?? true;
      return { transitioned, refund: transitioned ? refund : null };
    },
    findRefundByOrderId: async (_orderId: string) => {
      calls.push("findRefundByOrderId");
      return overrides.existingRefund ?? null;
    },
    deletePlan: async (input: DeleteInput) => {
      calls.push("deletePlan");
      return {
        ...plan,
        id: input.id,
        deletedAt: new Date(1),
        deletedBy: input.deletedBy,
        deleteReason: input.reason ?? null,
      };
    },
    restorePlan: async (input: RestoreInput) => {
      calls.push("restorePlan");
      return { ...plan, id: input.id };
    },
    listPlans: async () => {
      calls.push("listPlans");
      return overrides.plansList ?? [plan];
    },
    listOrders: async () => {
      calls.push("listOrders");
      return [order];
    },
    listSubscriptions: async () => {
      calls.push("listSubscriptions");
      return [];
    },
    listPaymentEvents: async () => {
      calls.push("listPaymentEvents");
      return [event];
    },
    listRefunds: async () => {
      calls.push("listRefunds");
      return [];
    },
    readAdminStats: async () => {
      calls.push("readAdminStats");
      return {
        ordersTotal: 0,
        ordersPaid: 0,
        ordersPending: 0,
        ordersRefunded: 0,
        ordersCanceled: 0,
        revenueByCurrency: [],
      };
    },
    upsertProvider: async (input) => {
      calls.push("upsertProvider");
      return { id: "prov_1", ...input, createdAt: new Date(0), updatedAt: new Date(0) };
    },
    findProviderByKey: async (_key: string) => {
      calls.push("findProviderByKey");
      return null;
    },
    deleteProvider: async (key: string) => {
      calls.push("deleteProvider");
      return {
        id: "prov_1",
        key,
        kind: "mock",
        webhookSecretRef: "KOKORO_PAYMENT_WEBHOOK_SECRET_MOCK",
        enabled: true,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
    },
    listProviders: async () => {
      calls.push("listProviders");
      return [];
    },
    findPaymentEventById: async (_id: string) => {
      calls.push("findPaymentEventById");
      return event;
    },
    transitionPaymentEventStatus: async (_id, _from, to, lastError) => {
      calls.push("transitionPaymentEventStatus");
      return { ...event, status: to, lastError };
    },
  };
  return { repo, calls, createdOrders, grants, grantPurchaseCredits, reversals, reverseCredits };
}

function service(fakes: Fakes) {
  return new PaymentService(fakes.repo, fakes.grantPurchaseCredits, fakes.reverseCredits);
}

describe("PaymentService positive-amount guard", () => {
  it.each(["0", "-1", ""])("upsertPlan rejects %j before repository", async (amountMinor) => {
    const fakes = makeFakes();
    await expect(
      service(fakes).upsertPlan({
        siteId: "site_1",
        key: "studio",
        name: "Studio",
        currency: "USD",
        amountMinor,
        billingInterval: "month",
      }),
    ).rejects.toThrow();
    expect(fakes.calls).not.toContain("upsertPlan");
  });

  it.each(["0", "-1", ""])("createOrder rejects %j before repository", async (amountMinor) => {
    const fakes = makeFakes();
    await expect(
      service(fakes).createOrder({
        siteId: "site_1",
        teamId: "team_1",
        planId: "plan_1",
        amountMinor,
        currency: "USD",
        idempotencyKey: "k1",
      }),
    ).rejects.toThrow();
    expect(fakes.calls).not.toContain("createOrder");
  });

  it("passes valid amount through to repository", async () => {
    const fakes = makeFakes();
    await service(fakes).createOrder({
      siteId: "site_1",
      teamId: "team_1",
      planId: "plan_1",
      amountMinor: "4900",
      currency: "USD",
      idempotencyKey: "k1",
    });
    expect(fakes.calls).toContain("createOrder");
  });

  it("rejects an order amount that does not match plan pricing (anchored pricing)", async () => {
    const fakes = makeFakes();
    await expect(
      service(fakes).createOrder({
        siteId: "site_1",
        teamId: "team_1",
        planId: "plan_1",
        amountMinor: "100",
        currency: "USD",
        idempotencyKey: "k1",
      }),
    ).rejects.toBeInstanceOf(OrderAmountMismatchError);
    expect(fakes.calls).not.toContain("createOrder");
  });

  it("rejects an order referencing a plan from another site", async () => {
    const fakes = makeFakes({ plan: { ...plan, siteId: "site_2" } });
    await expect(
      service(fakes).createOrder({
        siteId: "site_1",
        teamId: "team_1",
        planId: "plan_1",
        amountMinor: "4900",
        currency: "USD",
        idempotencyKey: "k1",
      }),
    ).rejects.toBeInstanceOf(PlanNotFoundError);
    expect(fakes.calls).not.toContain("createOrder");
  });

  it.each([
    ["disabled", { ...plan, status: "disabled" as const }],
    [
      "deleted",
      { ...plan, deletedAt: new Date(1), deletedBy: "operator-1", deleteReason: "retired" },
    ],
  ])("rejects an order referencing a %s plan", async (_label, guardedPlan) => {
    const fakes = makeFakes({ plan: guardedPlan });
    await expect(
      service(fakes).createOrder({
        siteId: "site_1",
        teamId: "team_1",
        planId: "plan_1",
        amountMinor: "4900",
        currency: "USD",
        idempotencyKey: "k1",
      }),
    ).rejects.toThrow();
    expect(fakes.calls).not.toContain("createOrder");
  });

  it("records payment events without amount guard", async () => {
    const fakes = makeFakes();
    await service(fakes).recordPaymentEvent({
      provider: "stripe",
      eventId: "ext_1",
      eventType: "invoice.paid",
      payload: { subscription: "sub_1" },
    });
    expect(fakes.calls).toContain("recordPaymentEvent");
  });
});

describe("PaymentService upsertPlan creditMicros guard", () => {
  it.each(["-1", "1.5", "abc", "01x"])(
    "rejects invalid creditMicros %j before repository",
    async (creditMicros) => {
      const fakes = makeFakes();
      await expect(
        service(fakes).upsertPlan({
          siteId: "site_1",
          key: "studio",
          name: "Studio",
          currency: "USD",
          amountMinor: "4900",
          creditMicros,
          billingInterval: "month",
        }),
      ).rejects.toThrow("creditMicros must be a non-negative integer");
      expect(fakes.calls).not.toContain("upsertPlan");
    },
  );

  it.each(["0", "1000000"])("accepts non-negative creditMicros %j", async (creditMicros) => {
    const fakes = makeFakes();
    await service(fakes).upsertPlan({
      siteId: "site_1",
      key: "studio",
      name: "Studio",
      currency: "USD",
      amountMinor: "4900",
      creditMicros,
      billingInterval: "month",
    });
    expect(fakes.calls).toContain("upsertPlan");
  });
});

describe("PaymentService confirmOrder", () => {
  it("grants credits then marks order paid for pending order", async () => {
    const fakes = makeFakes();
    const result = await service(fakes).confirmOrder("order_1", "req_1");
    expect(fakes.grants).toEqual([
      {
        siteId: "site_1",
        requestId: "req_1",
        ownerKind: "team",
        ownerId: "team_1",
        amountMicros: "1000000",
        idempotencyKey: "order:order_1",
        reason: "subscription",
      },
    ]);
    expect(fakes.calls.indexOf("findPlanById")).toBeLessThan(fakes.calls.indexOf("markOrderPaid"));
    expect(result.status).toBe("paid");
  });

  it("is idempotent: already-paid order does not re-grant or re-mark", async () => {
    const fakes = makeFakes({ order: { ...order, status: "paid" } });
    const result = await service(fakes).confirmOrder("order_1", "req_1");
    expect(fakes.grants).toEqual([]);
    expect(fakes.calls).not.toContain("markOrderPaid");
    expect(result.status).toBe("paid");
  });

  it("marks paid without granting when plan creditMicros is 0", async () => {
    const fakes = makeFakes({ plan: { ...plan, creditMicros: "0" } });
    const result = await service(fakes).confirmOrder("order_1", "req_1");
    expect(fakes.grants).toEqual([]);
    expect(fakes.calls).toContain("markOrderPaid");
    expect(result.status).toBe("paid");
  });

  it("throws OrderNotFoundError when order is missing", async () => {
    const fakes = makeFakes({ order: null });
    await expect(service(fakes).confirmOrder("missing", "req_1")).rejects.toBeInstanceOf(OrderNotFoundError);
    expect(fakes.calls).not.toContain("markOrderPaid");
  });

  it("throws OrderNotConfirmableError for non-pending non-paid order", async () => {
    const fakes = makeFakes({ order: { ...order, status: "canceled" } });
    await expect(service(fakes).confirmOrder("order_1", "req_1")).rejects.toBeInstanceOf(
      OrderNotConfirmableError,
    );
    expect(fakes.grants).toEqual([]);
    expect(fakes.calls).not.toContain("markOrderPaid");
  });

  it("throws PlanNotFoundError when plan is missing", async () => {
    const fakes = makeFakes({ plan: null });
    await expect(service(fakes).confirmOrder("order_1", "req_1")).rejects.toBeInstanceOf(PlanNotFoundError);
    expect(fakes.grants).toEqual([]);
    expect(fakes.calls).not.toContain("markOrderPaid");
  });
});

describe("PaymentService grantPlanToTeam", () => {
  it("creates an order from the plan then confirms it to paid", async () => {
    const fakes = makeFakes();
    const result = await service(fakes).grantPlanToTeam("site_1", "team_1", "plan_1", "req_1");
    expect(result.status).toBe("paid");
    expect(fakes.calls).toContain("createOrder");
    expect(fakes.calls).toContain("markOrderPaid");
    expect(fakes.grants).toHaveLength(1);
  });

  it("throws PlanNotFoundError without creating an order when plan is missing", async () => {
    const fakes = makeFakes({ plan: null });
    await expect(service(fakes).grantPlanToTeam("site_1", "team_1", "missing", "req_1")).rejects.toBeInstanceOf(
      PlanNotFoundError,
    );
    expect(fakes.calls).not.toContain("createOrder");
  });

  it("rejects a plan from another site before creating an order", async () => {
    const fakes = makeFakes({ plan: { ...plan, siteId: "site_2" } });
    await expect(service(fakes).grantPlanToTeam("site_1", "team_1", "plan_1", "req_1")).rejects.toBeInstanceOf(
      PlanNotFoundError,
    );
    expect(fakes.calls).not.toContain("createOrder");
  });

  it("replays the same site request against one paid order and one credit grant", async () => {
    const fakes = makeFakes();
    const payment = service(fakes);

    const first = await payment.grantPlanToTeam("site_1", "team_1", "plan_1", "req_same");
    const replay = await payment.grantPlanToTeam("site_1", "team_1", "plan_1", "req_same");

    expect(replay.id).toBe(first.id);
    expect(fakes.createdOrders).toHaveLength(1);
    expect(fakes.createdOrders[0]?.idempotencyKey).toMatch(/^admin-grant:v1:[0-9a-f]{64}$/);
    expect(fakes.createdOrders[0]?.idempotencyKey).not.toContain("site_1");
    expect(fakes.createdOrders[0]?.idempotencyKey).not.toContain("req_same");
    expect(fakes.grants).toHaveLength(1);
  });

  it.each([
    ["repriced", (current: Plan) => Object.assign(current, { amountMinor: "9900" })],
    ["disabled", (current: Plan) => Object.assign(current, { status: "disabled" as const })],
    ["deleted", (current: Plan) => Object.assign(current, { deletedAt: new Date(1) })],
  ])("replays the original paid order after the plan is %s", async (_state, mutatePlan) => {
    const currentPlan = { ...plan };
    const fakes = makeFakes({ plan: currentPlan });
    const payment = service(fakes);
    const first = await payment.grantPlanToTeam("site_1", "team_1", "plan_1", "req_snapshot");
    mutatePlan(currentPlan);

    const replay = await payment.grantPlanToTeam("site_1", "team_1", "plan_1", "req_snapshot");

    expect(replay.id).toBe(first.id);
    expect(replay.amountMinor).toBe("4900");
    expect(fakes.createdOrders).toHaveLength(1);
    expect(fakes.grants).toHaveLength(1);
  });

  it("replays the original paid order after the plan is no longer readable", async () => {
    const overrides: FakeOverrides = { plan };
    const fakes = makeFakes(overrides);
    const payment = service(fakes);
    const first = await payment.grantPlanToTeam("site_1", "team_1", "plan_1", "req_missing_plan");
    overrides.plan = null;

    const replay = await payment.grantPlanToTeam("site_1", "team_1", "plan_1", "req_missing_plan");

    expect(replay.id).toBe(first.id);
    expect(fakes.grants).toHaveLength(1);
  });

  it.each([
    ["team_2", "plan_1"],
    ["team_1", "plan_2"],
  ])("rejects request reuse for a different target (%s, %s)", async (teamId, planId) => {
    const fakes = makeFakes();
    const payment = service(fakes);
    await payment.grantPlanToTeam("site_1", "team_1", "plan_1", "req_conflict");

    await expect(
      payment.grantPlanToTeam("site_1", teamId, planId, "req_conflict"),
    ).rejects.toBeInstanceOf(PaymentIdempotencyConflictError);
    expect(fakes.createdOrders).toHaveLength(1);
    expect(fakes.grants).toHaveLength(1);
  });

  it("creates independent orders and grants for different request IDs", async () => {
    const fakes = makeFakes();
    const payment = service(fakes);

    const first = await payment.grantPlanToTeam("site_1", "team_1", "plan_1", "req_1");
    const second = await payment.grantPlanToTeam("site_1", "team_1", "plan_1", "req_2");

    expect(second.id).not.toBe(first.id);
    const keys = fakes.createdOrders.map((created) => created.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^admin-grant:v1:[0-9a-f]{64}$/);
    expect(keys[1]).toMatch(/^admin-grant:v1:[0-9a-f]{64}$/);
    expect(keys[1]).not.toBe(keys[0]);
    expect(fakes.grants).toHaveLength(2);
  });

  it("preserves case-sensitive opaque request identity on a case-insensitive store", async () => {
    const fakes = makeFakes();
    const payment = service(fakes);

    await payment.grantPlanToTeam("site_1", "team_1", "plan_1", "CaseSensitive");
    await payment.grantPlanToTeam("site_1", "team_1", "plan_1", "casesensitive");

    expect(fakes.createdOrders).toHaveLength(2);
    expect(fakes.createdOrders[1]?.idempotencyKey).not.toBe(fakes.createdOrders[0]?.idempotencyKey);
    expect(fakes.grants).toHaveLength(2);
  });

  it("maps oversized opaque IDs to a fixed ASCII key without leaking raw values", async () => {
    const longSiteId = `site_${"S".repeat(500)}`;
    const longRequestId = `request_${"R".repeat(5_000)}`;
    const longSitePlan = { ...plan, siteId: longSiteId };
    const fakes = makeFakes({ plan: longSitePlan });

    await service(fakes).grantPlanToTeam(longSiteId, "team_1", "plan_1", longRequestId);

    const key = fakes.createdOrders[0]?.idempotencyKey ?? "";
    expect(key).toMatch(/^admin-grant:v1:[0-9a-f]{64}$/);
    expect(Buffer.byteLength(key, "ascii")).toBe(79);
    expect(key).not.toContain(longSiteId);
    expect(key).not.toContain(longRequestId);
  });

  it("scopes the same request ID to each site", async () => {
    const siteTwoPlan = { ...plan, id: "plan_2", siteId: "site_2" };
    const fakes = makeFakes({ plans: [plan, siteTwoPlan] });
    const payment = service(fakes);

    await payment.grantPlanToTeam("site_1", "team_1", "plan_1", "req_shared");
    await payment.grantPlanToTeam("site_2", "team_2", "plan_2", "req_shared");

    const keys = fakes.createdOrders.map((created) => created.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^admin-grant:v1:[0-9a-f]{64}$/);
    expect(keys[1]).toMatch(/^admin-grant:v1:[0-9a-f]{64}$/);
    expect(keys[1]).not.toBe(keys[0]);
    expect(fakes.grants).toHaveLength(2);
  });
});

describe("POST /admin/payments/grant-plan", () => {
  async function createAdminApp(fakes: Fakes) {
    const app = Fastify();
    registerPaymentAdminRoutes(app, fakes.repo);
    await app.ready();
    return app;
  }

  it.each([
    [{ teamId: "team_1", planId: "plan_1" }, "req_supplied"],
    [{ teamId: "team_1", planId: "plan_1" }, undefined],
    [{ teamId: "team_2", planId: "plan_1" }, "req_conflict"],
    [{ teamId: "team_1" }, "req_invalid"],
    [{ teamId: "team_1", planId: "missing" }, "req_missing"],
  ])("is structurally absent for payload %j without order or credit effects", async (payload, requestId) => {
    const fakes = makeFakes();
    const app = await createAdminApp(fakes);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/admin/payments/grant-plan",
        headers: {
          "x-kokoro-site-id": "site_1",
          ...(requestId === undefined ? {} : { "x-kokoro-request-id": requestId }),
        },
        payload,
      });

      expect(response.statusCode).toBe(404);
      expect(fakes.createdOrders).toEqual([]);
      expect(fakes.grants).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe("PaymentService plan lifecycle", () => {
  it("delegates deletePlan and restorePlan to repository", async () => {
    const fakes = makeFakes();

    await service(fakes).deletePlan({ id: "plan_1", deletedBy: "operator-1", reason: "retired" });
    await service(fakes).restorePlan({ id: "plan_1" });

    expect(fakes.calls).toEqual(["deletePlan", "restorePlan"]);
  });
});

describe("PaymentService refundOrder", () => {
  it("reverses credits first, then atomically marks refunded and records the refund", async () => {
    const fakes = makeFakes({ order: { ...order, status: "paid" } });
    const result = await service(fakes).refundOrder("order_1", "req_1");
    expect(result.order.status).toBe("refunded");
    expect(result.refund.status).toBe("succeeded");
    expect(fakes.reversals).toEqual([
      {
        siteId: "site_1",
        requestId: "req_1",
        ownerKind: "team",
        ownerId: "team_1",
        amountMicros: "1000000",
        idempotencyKey: "order-refund:order_1",
        reason: "refund",
      },
    ]);
    // 跨服务补偿(reverse)在同库提交(refundOrderAtomically)之前——保证「标退款」前积分已扣回。
    expect(fakes.calls.indexOf("reverseCredits")).toBeLessThan(
      fakes.calls.indexOf("refundOrderAtomically"),
    );
  });

  it("skips reverseCredits when plan creditMicros is 0", async () => {
    const fakes = makeFakes({
      order: { ...order, status: "paid" },
      plan: { ...plan, creditMicros: "0" },
    });
    const result = await service(fakes).refundOrder("order_1", "req_1");
    expect(result.order.status).toBe("refunded");
    expect(fakes.reversals).toEqual([]);
    expect(fakes.calls).toContain("refundOrderAtomically");
  });

  it("throws OrderNotFoundError when order is missing", async () => {
    const fakes = makeFakes({ order: null });
    await expect(service(fakes).refundOrder("missing", "req_1")).rejects.toBeInstanceOf(OrderNotFoundError);
    expect(fakes.calls).not.toContain("refundOrderAtomically");
  });

  it.each(["pending", "canceled"] as const)(
    "throws OrderNotRefundableError for %s order without touching credits",
    async (status) => {
      const fakes = makeFakes({ order: { ...order, status } });
      await expect(service(fakes).refundOrder("order_1", "req_1")).rejects.toBeInstanceOf(
        OrderNotRefundableError,
      );
      expect(fakes.calls).not.toContain("reverseCredits");
      expect(fakes.calls).not.toContain("refundOrderAtomically");
    },
  );

  it("is idempotent: an already-refunded order returns the existing refund without re-reversing", async () => {
    const fakes = makeFakes({ order: { ...order, status: "refunded" }, existingRefund: refund });
    const result = await service(fakes).refundOrder("order_1", "req_1");
    expect(result.refund.id).toBe("refund_1");
    expect(fakes.reversals).toEqual([]);
    expect(fakes.calls).not.toContain("refundOrderAtomically");
  });

  it("on a lost paid→refunded race, returns the existing refund (reverse stays idempotent)", async () => {
    const fakes = makeFakes({
      order: { ...order, status: "paid" },
      atomicTransitioned: false,
      existingRefund: refund,
    });
    const result = await service(fakes).refundOrder("order_1", "req_1");
    expect(result.refund.id).toBe("refund_1");
    // reverse 仍在 atomic 之前执行，但同一幂等键保证只扣一次。
    expect(fakes.reversals).toHaveLength(1);
  });

  it("propagates reverseCredits failure WITHOUT marking the order refunded (retryable)", async () => {
    const fakes = makeFakes({ order: { ...order, status: "paid" }, reverseThrows: true });
    await expect(service(fakes).refundOrder("order_1", "req_1")).rejects.toThrow("insufficient credit");
    // 关键修复：reverse 失败时 order 未标退款、未建记录，可安全重试，不再卡死在不一致态。
    expect(fakes.calls).not.toContain("refundOrderAtomically");
  });
});

describe("PaymentService confirm outbox(确认意图落库+sweep 收尾)", () => {
  it("confirmOrder 先落 confirming 再发放再标 paid(顺序断言)", async () => {
    const fakes = makeFakes();
    await service(fakes).confirmOrder("order_1", "req_1");
    expect(fakes.calls.indexOf("markOrderConfirming")).toBeGreaterThan(-1);
    expect(fakes.calls.indexOf("markOrderConfirming")).toBeLessThan(fakes.calls.indexOf("markOrderPaid"));
  });

  it("markPaid 崩溃时订单停在 confirming(grant 已发,幂等键不变)", async () => {
    const fakes = makeFakes({ markPaidThrows: true });
    await expect(service(fakes).confirmOrder("order_1", "req_1")).rejects.toThrow("db down");
    expect(fakes.grants).toHaveLength(1);
    expect(fakes.grants[0]?.idempotencyKey).toBe("order:order_1");
  });

  it("sweep 收尾悬挂 confirming:重放同幂等键 grant+标 paid,计数返回", async () => {
    const stale = { ...order, id: "order_9", status: "confirming" as const };
    const fakes = makeFakes({ staleConfirming: [stale], order: stale });
    const recovered = await service(fakes).sweepStaleConfirmingOrders(1000, "req_sweep");
    expect(recovered).toBe(1);
    expect(fakes.grants).toHaveLength(1);
    expect(fakes.grants[0]?.idempotencyKey).toBe("order:order_9");
    expect(fakes.calls).toContain("markOrderPaid");
  });

  it("sweep 单笔失败不阻断整批", async () => {
    const bad = { ...order, id: "order_bad", status: "confirming" as const };
    const fakes = makeFakes({ staleConfirming: [bad], order: bad, markPaidThrows: true });
    const recovered = await service(fakes).sweepStaleConfirmingOrders(1000, "req_sweep");
    expect(recovered).toBe(0);
  });
});

describe("PaymentService listSellablePlans（storefront 目录）", () => {
  const disabled: Plan = { ...plan, id: "plan_disabled", status: "disabled" };
  const deleted: Plan = { ...plan, id: "plan_deleted", deletedAt: new Date(1), deletedBy: "op", deleteReason: "retired" };
  const active2: Plan = { ...plan, id: "plan_2", key: "pro" };

  it("按站点透传并只保留 active 未删套餐（草稿/停售/软删不进店面）", async () => {
    const fakes = makeFakes({ plansList: [plan, disabled, deleted, active2] });
    const result = await service(fakes).listSellablePlans("site_1");
    expect(result.map((p) => p.id)).toEqual(["plan_1", "plan_2"]);
    expect(fakes.calls).toContain("listPlans");
  });

  it("无在售套餐 → 空目录", async () => {
    const fakes = makeFakes({ plansList: [disabled, deleted] });
    expect(await service(fakes).listSellablePlans("site_1")).toEqual([]);
  });
});

describe("PaymentService startCheckout（诚实态：V1 未接入托管收银台 → 501）", () => {
  it("套餐可售 → 抛 CheckoutUnavailableError（不建单）", async () => {
    const fakes = makeFakes();
    await expect(
      service(fakes).startCheckout({ siteId: "site_1", teamId: "team_1", planId: "plan_1" }),
    ).rejects.toBeInstanceOf(CheckoutUnavailableError);
    expect(fakes.calls).not.toContain("createOrder");
  });

  it("mock provider 已启用 → 建单 + 返回模拟收银台 checkoutUrl", async () => {
    const fakes = makeFakes();
    // dev mock 收银台可用：findProviderByKey('mock') 返回启用行。
    fakes.repo.findProviderByKey = async () => ({
      id: "prov_mock",
      key: "mock",
      kind: "mock",
      webhookSecretRef: "KOKORO_PAYMENT_MOCK_WEBHOOK_SECRET",
      enabled: true,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    const result = await service(fakes).startCheckout({ siteId: "site_1", teamId: "team_1", planId: "plan_1" });
    expect(result.orderId).toBe(order.id);
    expect(result.checkoutUrl).toBe(`/billing/pay/${order.id}`);
    expect(fakes.calls).toContain("createOrder");
  });

  it("套餐不存在 → PlanNotFoundError（先校验，不进收银台）", async () => {
    const fakes = makeFakes({ plan: null });
    await expect(
      service(fakes).startCheckout({ siteId: "site_1", teamId: "team_1", planId: "missing" }),
    ).rejects.toBeInstanceOf(PlanNotFoundError);
  });

  it("他站套餐不可伪造 → PlanNotFoundError（不泄露他站套餐存在）", async () => {
    const fakes = makeFakes({ plan: { ...plan, siteId: "site_2" } });
    await expect(
      service(fakes).startCheckout({ siteId: "site_1", teamId: "team_1", planId: "plan_1" }),
    ).rejects.toBeInstanceOf(PlanNotFoundError);
  });

  it.each([
    ["disabled", { ...plan, status: "disabled" as const }],
    ["deleted", { ...plan, deletedAt: new Date(1), deletedBy: "op", deleteReason: "retired" }],
  ])("停售/软删套餐 %s → 不可结账", async (_label, guarded) => {
    const fakes = makeFakes({ plan: guarded });
    await expect(
      service(fakes).startCheckout({ siteId: "site_1", teamId: "team_1", planId: "plan_1" }),
    ).rejects.toThrow();
    expect(fakes.calls).not.toContain("createOrder");
  });
});
