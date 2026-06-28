import { describe, expect, it } from "vitest";
import { PaymentService } from "../../src/application/payment-service.js";
import type { Order, PaymentEvent, Plan } from "../../src/domain/payment.js";
import type {
  CreateOrderInput,
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

function trackingRepo(): { repo: PaymentRepository; calls: string[] } {
  const calls: string[] = [];
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
  };
  return { repo, calls };
}

describe("PaymentService positive-amount guard", () => {
  it.each(["0", "-1", ""])("upsertPlan rejects %j before repository", async (amountMinor) => {
    const { repo, calls } = trackingRepo();
    const service = new PaymentService(repo);
    await expect(
      service.upsertPlan({
        key: "studio",
        name: "Studio",
        currency: "USD",
        amountMinor,
        billingInterval: "month",
      }),
    ).rejects.toThrow("amountMinor must be positive");
    expect(calls).not.toContain("upsertPlan");
  });

  it.each(["0", "-1", ""])("createOrder rejects %j before repository", async (amountMinor) => {
    const { repo, calls } = trackingRepo();
    const service = new PaymentService(repo);
    await expect(
      service.createOrder({
        teamId: "team_1",
        planId: "plan_1",
        amountMinor,
        currency: "USD",
        idempotencyKey: "k1",
      }),
    ).rejects.toThrow("amountMinor must be positive");
    expect(calls).not.toContain("createOrder");
  });

  it("passes valid amount through to repository", async () => {
    const { repo, calls } = trackingRepo();
    const service = new PaymentService(repo);
    await service.createOrder({
      teamId: "team_1",
      planId: "plan_1",
      amountMinor: "4900",
      currency: "USD",
      idempotencyKey: "k1",
    });
    expect(calls).toContain("createOrder");
  });

  it("records payment events without amount guard", async () => {
    const { repo, calls } = trackingRepo();
    const service = new PaymentService(repo);
    await service.recordPaymentEvent({
      provider: "stripe",
      eventId: "ext_1",
      eventType: "invoice.paid",
      payload: { subscription: "sub_1" },
    });
    expect(calls).toContain("recordPaymentEvent");
  });
});
