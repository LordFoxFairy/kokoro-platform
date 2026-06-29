import { describe, expect, it } from "vitest";
import { PaymentService } from "../../src/application/payment-service.js";
import {
  OrderNotConfirmableError,
  OrderNotFoundError,
  PlanNotFoundError,
} from "../../src/domain/errors.js";
import type { Order, PaymentEvent, Plan } from "../../src/domain/payment.js";
import type {
  CreateOrderInput,
  GrantPurchaseCredits,
  GrantPurchaseCreditsInput,
  PaymentRepository,
  RecordPaymentEventInput,
  UpsertPlanInput,
} from "../../src/domain/repository.js";

const plan: Plan = {
  id: "plan_1",
  key: "studio",
  name: "Studio",
  currency: "USD",
  amountMinor: "4900",
  creditMicros: "1000000",
  billingInterval: "month",
  status: "active",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const order: Order = {
  id: "order_1",
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
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

interface Fakes {
  repo: PaymentRepository;
  calls: string[];
  grants: GrantPurchaseCreditsInput[];
  grantPurchaseCredits: GrantPurchaseCredits;
}

interface FakeOverrides {
  order?: Order | null;
  plan?: Plan | null;
}

function makeFakes(overrides: FakeOverrides = {}): Fakes {
  const calls: string[] = [];
  const grants: GrantPurchaseCreditsInput[] = [];
  const grantPurchaseCredits: GrantPurchaseCredits = async (input) => {
    grants.push(input);
  };
  const repo: PaymentRepository = {
    upsertPlan: async (_input: UpsertPlanInput) => {
      calls.push("upsertPlan");
      return plan;
    },
    createOrder: async (_input: CreateOrderInput) => {
      calls.push("createOrder");
      return order;
    },
    recordPaymentEvent: async (_input: RecordPaymentEventInput) => {
      calls.push("recordPaymentEvent");
      return event;
    },
    findOrderById: async (_orderId: string) => {
      calls.push("findOrderById");
      return overrides.order === undefined ? order : overrides.order;
    },
    findPlanById: async (_planId: string) => {
      calls.push("findPlanById");
      return overrides.plan === undefined ? plan : overrides.plan;
    },
    markOrderPaid: async (orderId: string) => {
      calls.push("markOrderPaid");
      return { ...order, id: orderId, status: "paid" };
    },
    listPlans: async () => {
      calls.push("listPlans");
      return [plan];
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
  };
  return { repo, calls, grants, grantPurchaseCredits };
}

function service(fakes: Fakes) {
  return new PaymentService(fakes.repo, fakes.grantPurchaseCredits);
}

describe("PaymentService positive-amount guard", () => {
  it.each(["0", "-1", ""])("upsertPlan rejects %j before repository", async (amountMinor) => {
    const fakes = makeFakes();
    await expect(
      service(fakes).upsertPlan({
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
      teamId: "team_1",
      planId: "plan_1",
      amountMinor: "4900",
      currency: "USD",
      idempotencyKey: "k1",
    });
    expect(fakes.calls).toContain("createOrder");
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
    const result = await service(fakes).confirmOrder("order_1");
    expect(fakes.grants).toEqual([
      {
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
    const result = await service(fakes).confirmOrder("order_1");
    expect(fakes.grants).toEqual([]);
    expect(fakes.calls).not.toContain("markOrderPaid");
    expect(result.status).toBe("paid");
  });

  it("marks paid without granting when plan creditMicros is 0", async () => {
    const fakes = makeFakes({ plan: { ...plan, creditMicros: "0" } });
    const result = await service(fakes).confirmOrder("order_1");
    expect(fakes.grants).toEqual([]);
    expect(fakes.calls).toContain("markOrderPaid");
    expect(result.status).toBe("paid");
  });

  it("throws OrderNotFoundError when order is missing", async () => {
    const fakes = makeFakes({ order: null });
    await expect(service(fakes).confirmOrder("missing")).rejects.toBeInstanceOf(OrderNotFoundError);
    expect(fakes.calls).not.toContain("markOrderPaid");
  });

  it("throws OrderNotConfirmableError for non-pending non-paid order", async () => {
    const fakes = makeFakes({ order: { ...order, status: "canceled" } });
    await expect(service(fakes).confirmOrder("order_1")).rejects.toBeInstanceOf(
      OrderNotConfirmableError,
    );
    expect(fakes.grants).toEqual([]);
    expect(fakes.calls).not.toContain("markOrderPaid");
  });

  it("throws PlanNotFoundError when plan is missing", async () => {
    const fakes = makeFakes({ plan: null });
    await expect(service(fakes).confirmOrder("order_1")).rejects.toBeInstanceOf(PlanNotFoundError);
    expect(fakes.grants).toEqual([]);
    expect(fakes.calls).not.toContain("markOrderPaid");
  });
});
