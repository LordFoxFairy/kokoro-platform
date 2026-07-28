import type { PrismaClient } from "../../generated/prisma/index.js";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { SiteRepository } from "../../src/domain/repository.js";
import { PrismaSiteRepository } from "../../src/infrastructure/prisma/prisma-site-repository.js";
import { siteAdminManifest } from "../../src/interfaces/admin/manifest.js";
import { registerSiteAdminRoutes } from "../../src/interfaces/http/admin-routes.js";

describe("PrismaSiteRepository admin Site scope", () => {
  it("pushes the Site id into the same pre-take query for the sites resource", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repository = new PrismaSiteRepository({ site: { findMany } } as unknown as PrismaClient);

    await repository.listAdminSites({ includeDeleted: true, siteId: "site-b" });

    expect(findMany).toHaveBeenCalledWith({
      where: { id: "site-b" },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  });

  it.each([
    ["domains", "siteDomain", "listAdminSiteDomains"],
    ["apps", "siteApp", "listAdminSiteApps"],
    ["policies", "sitePolicy", "listAdminSitePolicies"],
    ["feature flags", "siteFeatureFlag", "listAdminSiteFeatureFlags"],
  ] as const)("pushes siteId into the pre-take query for %s", async (_label, model, method) => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repository = new PrismaSiteRepository({ [model]: { findMany } } as unknown as PrismaClient);

    await repository[method]({ includeDeleted: true, siteId: "site-b" });

    expect(findMany).toHaveBeenCalledWith({
      where: { siteId: "site-b" },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  });
});

describe("Site admin list query", () => {
  it("strictly parses and forwards siteId for every resource", async () => {
    const methods = {
      listAdminSites: vi.fn().mockResolvedValue([]),
      listAdminSiteDomains: vi.fn().mockResolvedValue([]),
      listAdminSiteApps: vi.fn().mockResolvedValue([]),
      listAdminSitePolicies: vi.fn().mockResolvedValue([]),
      listAdminSiteFeatureFlags: vi.fn().mockResolvedValue([]),
    };
    const app = Fastify();
    registerSiteAdminRoutes(app, methods as unknown as SiteRepository);

    for (const resource of siteAdminManifest.resources) {
      const response = await app.inject({ method: "GET", url: `${resource.route}?siteId=site-b` });
      expect(response.statusCode).toBe(200);
    }

    for (const method of Object.values(methods)) {
      expect(method).toHaveBeenCalledWith({ includeDeleted: true, siteId: "site-b" });
    }
    await app.close();
  });

  it("rejects a wildcard Site selector before reaching the repository", async () => {
    const listAdminSites = vi.fn().mockResolvedValue([]);
    const app = Fastify();
    registerSiteAdminRoutes(app, { listAdminSites } as unknown as SiteRepository);

    const response = await app.inject({ method: "GET", url: "/admin/sites?siteId=*" });

    expect(response.statusCode).toBe(400);
    expect(listAdminSites).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects unknown query keys without reaching the repository", async () => {
    const listAdminSites = vi.fn().mockResolvedValue([]);
    const app = Fastify();
    registerSiteAdminRoutes(app, { listAdminSites } as unknown as SiteRepository);

    const response = await app.inject({ method: "GET", url: "/admin/sites?siteId=site-b&typo=1" });

    expect(response.statusCode).toBe(400);
    expect(listAdminSites).not.toHaveBeenCalled();
    await app.close();
  });
});
