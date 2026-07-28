import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { ModelRepository } from "../../src/domain/repository.js";
import { registerModelAdminRoutes } from "../../src/interfaces/http/admin-routes.js";

describe("Model admin Site queries", () => {
  it("strictly forwards siteId to the Site policy repository query", async () => {
    const listSiteModelPolicies = vi.fn().mockResolvedValue([]);
    const app = Fastify();
    registerModelAdminRoutes(app, { listSiteModelPolicies } as unknown as ModelRepository);

    const response = await app.inject({ method: "GET", url: "/admin/models/site-policies?siteId=site-b" });

    expect(response.statusCode).toBe(200);
    expect(listSiteModelPolicies).toHaveBeenCalledWith("site-b");
    expect((await app.inject({ method: "GET", url: "/admin/models/site-policies?siteId=site-b&typo=1" })).statusCode).toBe(400);
    await app.close();
  });

  it.each([
    ["provider-accounts", "listProviderAccounts"],
    ["bindings", "listAllModelBindings"],
    ["labels", "listModelLabels"],
  ] as const)("rejects Site parameters on global %s", async (resource, method) => {
    const list = vi.fn().mockResolvedValue([]);
    const app = Fastify();
    registerModelAdminRoutes(app, { [method]: list } as unknown as ModelRepository);

    expect((await app.inject({ method: "GET", url: `/admin/models/${resource}?siteId=site-b` })).statusCode).toBe(400);
    expect(list).not.toHaveBeenCalled();
    await app.close();
  });
});
