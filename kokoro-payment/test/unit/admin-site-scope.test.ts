import type { PrismaClient } from "../../generated/prisma/index.js";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { PaymentService } from "../../src/application/payment-service.js";
import type { PaymentWebhookService } from "../../src/application/webhook-service.js";
import type { PaymentRepository } from "../../src/domain/repository.js";
import { PrismaPaymentRepository } from "../../src/infrastructure/prisma/prisma-payment-repository.js";
import { registerPaymentAdminRoutes } from "../../src/interfaces/http/admin-routes.js";

describe("PrismaPaymentRepository admin Site scope", () => {
  it.each([
    ["plans", "plan", "listPlans", { siteId: "site-b" }],
    ["orders", "order", "listOrders", { siteId: "site-b" }],
  ] as const)("filters %s before take", async (_label, model, method, where) => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repository = new PrismaPaymentRepository({ [model]: { findMany } } as unknown as PrismaClient);
    if (method === "listPlans") await repository.listPlans("site-b", { includeDeleted: true });
    else await repository.listOrders("site-b");
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({ where, take: 100 });
  });

  it("filters subscriptions through plan and projects siteId", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repository = new PrismaPaymentRepository({ subscription: { findMany } } as unknown as PrismaClient);
    await repository.listSubscriptions("site-b");
    expect(findMany).toHaveBeenCalledWith({
      where: { plan: { siteId: "site-b" } },
      include: { plan: { select: { siteId: true } } },
      take: 100,
      orderBy: { createdAt: "desc" },
    });
  });

  it("filters refunds through order and projects siteId", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repository = new PrismaPaymentRepository({ refund: { findMany } } as unknown as PrismaClient);
    await repository.listRefunds("site-b");
    expect(findMany).toHaveBeenCalledWith({
      where: { order: { siteId: "site-b" } },
      include: { order: { select: { siteId: true } } },
      take: 100,
      orderBy: { createdAt: "desc" },
    });
  });

  it("returns explicit siteId projections for subscription and refund rows", async () => {
    const now = new Date("2026-07-28T00:00:00.000Z");
    const subscription = {
      id: "sub-1", teamId: "team-1", planId: "plan-1", status: "active", provider: null,
      providerSubscriptionId: null, currentPeriodStart: null, currentPeriodEnd: null, metadata: {},
      createdAt: now, updatedAt: now, plan: { siteId: "site-b" },
    };
    const refund = {
      id: "refund-1", orderId: "order-1", amountMinor: 10n, currency: "USD", status: "succeeded",
      reason: null, metadata: {}, createdAt: now, updatedAt: now, order: { siteId: "site-b" },
    };
    const repository = new PrismaPaymentRepository({
      subscription: { findMany: vi.fn().mockResolvedValue([subscription]) },
      refund: { findMany: vi.fn().mockResolvedValue([refund]) },
    } as unknown as PrismaClient);

    expect(await repository.listSubscriptions("site-b")).toEqual([
      expect.objectContaining({ id: "sub-1", siteId: "site-b" }),
    ]);
    expect(await repository.listRefunds("site-b")).toEqual([
      expect.objectContaining({ id: "refund-1", siteId: "site-b" }),
    ]);
  });

  it("filters both status and revenue groupings by siteId", async () => {
    const groupBy = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const repository = new PrismaPaymentRepository({ order: { groupBy } } as unknown as PrismaClient);
    await repository.readAdminStats("site-b");
    expect(groupBy).toHaveBeenNthCalledWith(1, { by: ["status"], where: { siteId: "site-b" }, _count: { _all: true } });
    expect(groupBy).toHaveBeenNthCalledWith(2, { by: ["currency"], where: { siteId: "site-b", status: "paid" }, _sum: { amountMinor: true } });
  });
});

describe("Payment admin Site queries", () => {
  it("strictly forwards siteId for scoped resources and requires it for stats", async () => {
    const repository = {
      listPlans: vi.fn().mockResolvedValue([]),
      listOrders: vi.fn().mockResolvedValue([]),
      listSubscriptions: vi.fn().mockResolvedValue([]),
      listRefunds: vi.fn().mockResolvedValue([]),
      listPaymentEvents: vi.fn().mockResolvedValue([]),
      listProviders: vi.fn().mockResolvedValue([]),
      readAdminStats: vi.fn().mockResolvedValue({}),
    };
    const app = Fastify();
    registerPaymentAdminRoutes(app, repository as unknown as PaymentRepository, {} as PaymentService, {} as PaymentWebhookService);
    for (const route of ["plans", "orders", "subscriptions", "refunds"]) {
      expect((await app.inject({ method: "GET", url: `/admin/payments/${route}?siteId=site-b` })).statusCode).toBe(200);
    }
    expect(repository.listPlans).toHaveBeenCalledWith("site-b", { includeDeleted: true });
    expect(repository.listOrders).toHaveBeenCalledWith("site-b");
    expect(repository.listSubscriptions).toHaveBeenCalledWith("site-b");
    expect(repository.listRefunds).toHaveBeenCalledWith("site-b");
    expect((await app.inject({ method: "GET", url: "/admin/payments/stats" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/admin/payments/stats?siteId=site-b" })).statusCode).toBe(200);
    expect(repository.readAdminStats).toHaveBeenCalledWith("site-b");
    await app.close();
  });

  it.each(["events", "providers"])("rejects Site parameters on global %s", async (resource) => {
    const repository = { listPaymentEvents: vi.fn().mockResolvedValue([]), listProviders: vi.fn().mockResolvedValue([]) };
    const app = Fastify();
    registerPaymentAdminRoutes(app, repository as unknown as PaymentRepository, {} as PaymentService, {} as PaymentWebhookService);
    expect((await app.inject({ method: "GET", url: `/admin/payments/${resource}?siteId=site-b` })).statusCode).toBe(400);
    await app.close();
  });
});
