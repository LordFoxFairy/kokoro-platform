import { describe, expect, it } from "vitest";
import { PaymentService } from "../../src/application/payment-service.js";
import {
  OrderNotConfirmableError,
  OrderNotFoundError,
  OrderNotRefundableError,
  PlanNotFoundError,
} from "../../src/domain/errors.js";
import type { Order, PaymentEvent, Plan, Refund } from "../../src/domain/payment.js";
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
  grants: GrantPurchaseCreditsInput[];
  grantPurchaseCredits: GrantPurchaseCredits;
  reversals: ReverseCreditsInput[];
  reverseCredits: ReverseCredits;
}

interface FakeOverrides {
  order?: Order | null;
  plan?: Plan | null;
  refundedCount?: number;
  reverseThrows?: boolean;
}

function makeFakes(overrides: FakeOverrides = {}): Fakes {
  const calls: string[] = [];
  const grants: GrantPurchaseCreditsInput[] = [];
  const grantPurchaseCredits: GrantPurchaseCredits = async (input) => {
    grants.push(input);
  };
  const reversals: ReverseCreditsInput[] = [];
  const reverseCredits: ReverseCredits = async (input) => {
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
    markOrderRefunded: async (_orderId: string) => {
      calls.push("markOrderRefunded");
      return overrides.refundedCount ?? 1;
    },
    createRefund: async (_input: CreateRefundInput) => {
      calls.push("createRefund");
      return refund;
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
  return { repo, calls, grants, grantPurchaseCredits, reversals, reverseCredits };
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
});

describe("PaymentService refundOrder", () => {
  it("marks refunded, reverses credits, then records a succeeded refund", async () => {
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
    expect(fakes.calls.indexOf("markOrderRefunded")).toBeLessThan(
      fakes.calls.indexOf("createRefund"),
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
    expect(fakes.calls).toContain("createRefund");
  });

  it("throws OrderNotFoundError when order is missing", async () => {
    const fakes = makeFakes({ order: null });
    await expect(service(fakes).refundOrder("missing", "req_1")).rejects.toBeInstanceOf(OrderNotFoundError);
    expect(fakes.calls).not.toContain("markOrderRefunded");
  });

  it.each(["pending", "canceled", "refunded"] as const)(
    "throws OrderNotRefundableError for %s order",
    async (status) => {
      const fakes = makeFakes({ order: { ...order, status } });
      await expect(service(fakes).refundOrder("order_1", "req_1")).rejects.toBeInstanceOf(
        OrderNotRefundableError,
      );
      expect(fakes.calls).not.toContain("markOrderRefunded");
    },
  );

  it("is idempotent: lost the paid→refunded race throws OrderNotRefundableError", async () => {
    const fakes = makeFakes({ order: { ...order, status: "paid" }, refundedCount: 0 });
    await expect(service(fakes).refundOrder("order_1", "req_1")).rejects.toBeInstanceOf(
      OrderNotRefundableError,
    );
    expect(fakes.reversals).toEqual([]);
    expect(fakes.calls).not.toContain("createRefund");
  });

  it("propagates reverseCredits failure after marking refunded, without recording a refund", async () => {
    const fakes = makeFakes({ order: { ...order, status: "paid" }, reverseThrows: true });
    await expect(service(fakes).refundOrder("order_1", "req_1")).rejects.toThrow("insufficient credit");
    expect(fakes.calls).toContain("markOrderRefunded");
    expect(fakes.calls).not.toContain("createRefund");
  });
});
