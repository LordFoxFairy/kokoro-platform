import type { PrismaClient } from "@prisma/client";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { UserService } from "../../src/application/user-service.js";
import type { UserRepository } from "../../src/domain/repository.js";
import { PrismaUserRepository } from "../../src/infrastructure/prisma/prisma-user-repository.js";
import { registerUserAdminRoutes } from "../../src/interfaces/http/admin-routes.js";

describe("PrismaUserRepository admin Site scope", () => {
  it.each([
    ["users", "user", "listUsers"],
    ["teams", "team", "listTeams"],
  ] as const)("filters %s before take", async (_label, model, method) => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repository = new PrismaUserRepository({ [model]: { findMany } } as unknown as PrismaClient);
    await repository[method]("site-b", { includeDeleted: true });
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({ where: { siteId: "site-b" }, take: 100 });
  });

  it("filters memberships through team and includes the projection source", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repository = new PrismaUserRepository({ membership: { findMany } } as unknown as PrismaClient);
    await repository.listMemberships("site-b", { includeDeleted: true });
    expect(findMany).toHaveBeenCalledWith({
      where: { team: { siteId: "site-b" } },
      include: { team: { select: { siteId: true } } },
      take: 100,
      orderBy: { createdAt: "desc" },
    });
  });

  it("filters service accounts through team or owner user before take", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repository = new PrismaUserRepository({ serviceAccount: { findMany } } as unknown as PrismaClient);
    await repository.listServiceAccounts("site-b", { includeDeleted: true });
    expect(findMany).toHaveBeenCalledWith({
      where: { OR: [{ team: { siteId: "site-b" } }, { ownerUser: { siteId: "site-b" } }] },
      include: {
        team: { select: { siteId: true } },
        ownerUser: { select: { siteId: true } },
      },
      take: 100,
      orderBy: { createdAt: "desc" },
    });
  });

  it("returns explicit queried-site projections for memberships and service accounts", async () => {
    const now = new Date("2026-07-28T00:00:00.000Z");
    const deletion = { deletedAt: null, deletedBy: null, deleteReason: null };
    const membership = {
      id: "membership-1", teamId: "team-1", userId: "user-1", role: "member", status: "active",
      ...deletion, createdAt: now, updatedAt: now, team: { siteId: "site-b" },
    };
    const serviceAccount = {
      id: "sa-1", teamId: null, ownerUserId: "user-1", name: "bot", tokenPrefix: "tok",
      status: "active", lastUsedAt: null, ...deletion, createdAt: now, updatedAt: now,
      team: null, ownerUser: { siteId: "site-b" },
    };
    const repository = new PrismaUserRepository({
      membership: { findMany: vi.fn().mockResolvedValue([membership]) },
      serviceAccount: { findMany: vi.fn().mockResolvedValue([serviceAccount]) },
    } as unknown as PrismaClient);

    expect(await repository.listMemberships("site-b", { includeDeleted: true })).toEqual([
      expect.objectContaining({ id: "membership-1", siteId: "site-b" }),
    ]);
    expect(await repository.listServiceAccounts("site-b", { includeDeleted: true })).toEqual([
      expect.objectContaining({ id: "sa-1", siteId: "site-b" }),
    ]);
  });
});

describe("User admin Site queries", () => {
  it("strictly forwards siteId for every resource", async () => {
    const repository = {
      listUsers: vi.fn().mockResolvedValue([]),
      listTeams: vi.fn().mockResolvedValue([]),
      listMemberships: vi.fn().mockResolvedValue([]),
      listServiceAccounts: vi.fn().mockResolvedValue([]),
    };
    const app = Fastify();
    registerUserAdminRoutes(app, repository as unknown as UserRepository, {} as UserService);

    for (const route of ["users", "teams", "memberships", "service-accounts"]) {
      expect((await app.inject({ method: "GET", url: `/admin/${route}?siteId=site-b` })).statusCode).toBe(200);
    }
    expect(repository.listUsers).toHaveBeenCalledWith("site-b", { includeDeleted: true });
    expect(repository.listTeams).toHaveBeenCalledWith("site-b", { includeDeleted: true });
    expect(repository.listMemberships).toHaveBeenCalledWith("site-b", { includeDeleted: true });
    expect(repository.listServiceAccounts).toHaveBeenCalledWith("site-b", { includeDeleted: true });
    await app.close();
  });

  it("rejects malformed or unknown query fields instead of falling back to an unscoped list", async () => {
    const listUsers = vi.fn().mockResolvedValue([]);
    const app = Fastify();
    registerUserAdminRoutes(app, { listUsers } as unknown as UserRepository, {} as UserService);

    expect((await app.inject({ method: "GET", url: "/admin/users?siteId=%20" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/admin/users?typo=site-b" })).statusCode).toBe(400);
    expect(listUsers).not.toHaveBeenCalled();
    await app.close();
  });
});
