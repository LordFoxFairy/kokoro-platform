import type { PrismaClient } from "../../generated/prisma/index.js";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { CreditService } from "../../src/application/credit-service.js";
import type { CreditRepository } from "../../src/domain/repository.js";
import { PrismaCreditRepository } from "../../src/infrastructure/prisma/prisma-credit-repository.js";
import { registerCreditAdminRoutes } from "../../src/interfaces/http/admin-routes.js";

describe("PrismaCreditRepository admin Site scope", () => {
  it("keeps account Site filtering in the pre-take query", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repository = new PrismaCreditRepository({ creditAccount: { findMany } } as unknown as PrismaClient);

    await repository.listAccounts("site-b", { includeDeleted: true });

    expect(findMany).toHaveBeenCalledWith({
      where: { siteId: "site-b" },
      take: 100,
      orderBy: { createdAt: "desc" },
    });
  });

  it.each([
    ["ledger", "creditLedgerEntry", "listLedgerEntries"],
    ["usage", "usageRecord", "listUsageRecords"],
  ] as const)("filters and projects Site through the account relation for %s", async (_label, model, method) => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repository = new PrismaCreditRepository({ [model]: { findMany } } as unknown as PrismaClient);

    await repository[method]("site-b");

    expect(findMany).toHaveBeenCalledWith({
      where: { account: { siteId: "site-b" } },
      include: { account: { select: { siteId: true } } },
      take: 100,
      orderBy: { createdAt: "desc" },
    });
  });

  it("returns explicit siteId projections for relational ledger and usage rows", async () => {
    const now = new Date("2026-07-28T00:00:00.000Z");
    const ledgerRow = {
      id: "ledger-1", accountId: "account-1", amountMicros: 1n, balanceAfterMicros: 2n,
      reason: "subscription", idempotencyKey: "idem-1", requestId: null, createdAt: now,
      account: { siteId: "site-b" },
    };
    const usageRow = {
      id: "usage-1", accountId: "account-1", featureKey: "chat", amountMicros: 1n,
      modelBindingId: null, requestId: null, idempotencyKey: "idem-2", status: "settled", createdAt: now,
      account: { siteId: "site-b" },
    };
    const repository = new PrismaCreditRepository({
      creditLedgerEntry: { findMany: vi.fn().mockResolvedValue([ledgerRow]) },
      usageRecord: { findMany: vi.fn().mockResolvedValue([usageRow]) },
    } as unknown as PrismaClient);

    expect(await repository.listLedgerEntries("site-b")).toEqual([
      expect.objectContaining({ id: "ledger-1", siteId: "site-b" }),
    ]);
    expect(await repository.listUsageRecords("site-b")).toEqual([
      expect.objectContaining({ id: "usage-1", siteId: "site-b" }),
    ]);
  });

  it("applies siteId to every billing aggregate", async () => {
    const count = vi.fn().mockResolvedValue(0);
    const accountAggregate = vi.fn().mockResolvedValue({ _sum: { balanceMicros: null, heldMicros: null } });
    const ledgerAggregate = vi.fn().mockResolvedValue({ _sum: { amountMicros: null } });
    const repository = new PrismaCreditRepository({
      creditAccount: { count, aggregate: accountAggregate },
      creditLedgerEntry: { aggregate: ledgerAggregate },
    } as unknown as PrismaClient);

    await repository.readAdminStats("site-b");

    expect(count).toHaveBeenNthCalledWith(1, { where: { deletedAt: null, siteId: "site-b" } });
    expect(count).toHaveBeenNthCalledWith(2, { where: { deletedAt: null, status: "active", siteId: "site-b" } });
    expect(accountAggregate).toHaveBeenCalledWith({
      where: { deletedAt: null, siteId: "site-b" },
      _sum: { balanceMicros: true, heldMicros: true },
    });
    expect(ledgerAggregate).toHaveBeenNthCalledWith(1, {
      where: { amountMicros: { gt: 0 }, account: { siteId: "site-b" } },
      _sum: { amountMicros: true },
    });
    expect(ledgerAggregate).toHaveBeenNthCalledWith(2, {
      where: { amountMicros: { lt: 0 }, account: { siteId: "site-b" } },
      _sum: { amountMicros: true },
    });
  });
});

describe("Credit admin Site queries", () => {
  it("strictly forwards optional siteId on scoped lists and requires it for stats", async () => {
    const repository = {
      listAccounts: vi.fn().mockResolvedValue([]),
      listLedgerEntries: vi.fn().mockResolvedValue([]),
      listUsageRecords: vi.fn().mockResolvedValue([]),
      listPricingRules: vi.fn().mockResolvedValue([]),
    };
    const service = { readAdminStats: vi.fn().mockResolvedValue({}) };
    const app = Fastify();
    registerCreditAdminRoutes(app, repository as unknown as CreditRepository, service as unknown as CreditService);

    for (const route of ["accounts", "ledger", "usage"]) {
      expect((await app.inject({ method: "GET", url: `/admin/credits/${route}?siteId=site-b` })).statusCode).toBe(200);
    }
    expect(repository.listAccounts).toHaveBeenCalledWith("site-b", { includeDeleted: true });
    expect(repository.listLedgerEntries).toHaveBeenCalledWith("site-b");
    expect(repository.listUsageRecords).toHaveBeenCalledWith("site-b");

    expect((await app.inject({ method: "GET", url: "/admin/credits/stats" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/admin/credits/stats?siteId=site-b" })).statusCode).toBe(200);
    expect(service.readAdminStats).toHaveBeenCalledWith("site-b");
    await app.close();
  });

  it("rejects unknown query keys and Site parameters on the global pricing resource", async () => {
    const repository = {
      listAccounts: vi.fn().mockResolvedValue([]),
      listPricingRules: vi.fn().mockResolvedValue([]),
    };
    const app = Fastify();
    registerCreditAdminRoutes(app, repository as unknown as CreditRepository, {} as CreditService);

    expect((await app.inject({ method: "GET", url: "/admin/credits/accounts?typo=1" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/admin/credits/pricing?siteId=site-b" })).statusCode).toBe(400);
    expect(repository.listAccounts).not.toHaveBeenCalled();
    expect(repository.listPricingRules).not.toHaveBeenCalled();
    await app.close();
  });
});
