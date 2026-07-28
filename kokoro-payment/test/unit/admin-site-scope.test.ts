import type { PrismaClient } from "../../generated/prisma/index.js";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
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
  it.each([
    ["missing", ""],
    ["blank", "?siteId=%20"],
  ])("fails closed with a stable code for %s Site scope and performs no repository read", async (_case, suffix) => {
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
    registerPaymentAdminRoutes(app, repository as unknown as PaymentRepository);
    try {
      for (const route of ["plans", "orders", "subscriptions", "refunds"]) {
        const response = await app.inject({ method: "GET", url: `/admin/payments/${route}${suffix}` });
        expect(response.statusCode, route).toBe(400);
        expect(response.json(), route).toMatchObject({ error: { code: "payment.site_required" } });
      }
      expect(repository.listPlans).not.toHaveBeenCalled();
      expect(repository.listOrders).not.toHaveBeenCalled();
      expect(repository.listSubscriptions).not.toHaveBeenCalled();
      expect(repository.listRefunds).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

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
    registerPaymentAdminRoutes(app, repository as unknown as PaymentRepository);
    for (const route of ["plans", "orders", "subscriptions", "refunds"]) {
      expect((await app.inject({ method: "GET", url: `/admin/payments/${route}?siteId=site-b` })).statusCode).toBe(200);
    }
    expect(repository.listPlans).toHaveBeenCalledWith("site-b", { includeDeleted: true });
    expect(repository.listOrders).toHaveBeenCalledWith("site-b");
    expect(repository.listSubscriptions).toHaveBeenCalledWith("site-b");
    expect(repository.listRefunds).toHaveBeenCalledWith("site-b");
    const missingStats = await app.inject({ method: "GET", url: "/admin/payments/stats" });
    expect(missingStats.statusCode).toBe(400);
    expect(missingStats.json()).toMatchObject({ error: { code: "payment.site_required" } });
    expect(repository.readAdminStats).not.toHaveBeenCalled();
    expect((await app.inject({ method: "GET", url: "/admin/payments/stats?siteId=site-b" })).statusCode).toBe(200);
    expect(repository.readAdminStats).toHaveBeenCalledWith("site-b");
    await app.close();
  });

  it.each(["events", "providers"])("rejects Site parameters on global %s", async (resource) => {
    const repository = { listPaymentEvents: vi.fn().mockResolvedValue([]), listProviders: vi.fn().mockResolvedValue([]) };
    const app = Fastify();
    registerPaymentAdminRoutes(app, repository as unknown as PaymentRepository);
    expect((await app.inject({ method: "GET", url: `/admin/payments/${resource}?siteId=site-b` })).statusCode).toBe(400);
    await app.close();
  });

  it("keeps a scoped runtime read on the requested Site boundary", async () => {
    const repository = {
      listPlans: vi.fn(async (siteId: string) => [{ id: `plan-${siteId}`, siteId }]),
    };
    const app = Fastify();
    registerPaymentAdminRoutes(app, repository as unknown as PaymentRepository);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/admin/payments/plans?siteId=site-a",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual([{ id: "plan-site-a", siteId: "site-a" }]);
      expect(repository.listPlans).toHaveBeenCalledWith("site-a", { includeDeleted: true });
      expect(repository.listPlans).not.toHaveBeenCalledWith("site-b", expect.anything());
    } finally {
      await app.close();
    }
  });
});
