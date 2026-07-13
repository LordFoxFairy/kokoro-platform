import { describe, expect, it } from "vitest";
import { PaymentService } from "../../src/application/payment-service.js";
import {
  CheckoutUnavailableError,
  OrderAmountMismatchError,
  OrderNotConfirmableError,
  OrderNotFoundError,
  OrderNotRefundableError,
  PlanNotFoundError,
} from "../../src/domain/errors.js";
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
  grants: GrantPurchaseCreditsInput[];
  grantPurchaseCredits: GrantPurchaseCredits;
  reversals: ReverseCreditsInput[];
  reverseCredits: ReverseCredits;
}

interface FakeOverrides {
  order?: Order | null;
  plan?: Plan | null;
  atomicTransitioned?: boolean;
  existingRefund?: Refund | null;
  reverseThrows?: boolean;
  markPaidThrows?: boolean;
  staleConfirming?: Order[];
  plansList?: Plan[];
}

function makeFakes(overrides: FakeOverrides = {}): Fakes {
  const calls: string[] = [];
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
    markOrderConfirming: async (orderId: string) => {
      calls.push("markOrderConfirming");
      return { ...order, id: orderId, status: "confirming" };
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
      return { ...order, id: orderId, status: "paid" };
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
