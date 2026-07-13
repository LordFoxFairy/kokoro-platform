import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../../generated/prisma/index.js";
import { createPrismaClient } from "../../src/infrastructure/prisma/prisma-client.js";
import { createSiteServer } from "../../src/interfaces/http/server.js";

// WHY: needs a real MySQL bound to DATABASE_URL_SITE; exercises routes.ts + site-service.ts over real HTTP.
function createTestPrismaClient(): PrismaClient {
  if (!process.env.DATABASE_URL_SITE) {
    throw new Error("DATABASE_URL_SITE is required for integration tests");
  }

  return createPrismaClient(process.env.DATABASE_URL_SITE);
}

async function reset(prisma: PrismaClient): Promise<void> {
  await prisma.siteFeatureFlag.deleteMany();
  await prisma.sitePolicy.deleteMany();
  await prisma.siteApp.deleteMany();
  await prisma.siteDomain.deleteMany();
  await prisma.site.deleteMany();
}

const prisma = createTestPrismaClient();
const app = createSiteServer({ prisma });

async function upsertSite(payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/sites/upsert", payload });
}

describe("site HTTP API", () => {
  beforeEach(async () => {
    await reset(prisma);
  });

  afterAll(async () => {
    await reset(prisma);
    await app.close();
    await prisma.$disconnect();
  });

  it("exposes site active over HTTP (true for active, false for suspended/missing)", async () => {
    const active = await upsertSite({ key: "live", name: "Live", status: "active" });
    const activeId = active.json().data.id as string;
    const activeRes = await app.inject({ method: "GET", url: `/sites/${activeId}/active` });
    expect(activeRes.statusCode).toBe(200);
    expect(activeRes.json().data).toEqual({ active: true });

    const suspended = await upsertSite({ key: "down", name: "Down", status: "suspended" });
    const suspendedId = suspended.json().data.id as string;
    const suspendedRes = await app.inject({ method: "GET", url: `/sites/${suspendedId}/active` });
    expect(suspendedRes.json().data).toEqual({ active: false });

    const missing = await app.inject({ method: "GET", url: "/sites/missing-id/active" });
    expect(missing.json().data).toEqual({ active: false });
  });

  it("upserts a site and lists it back", async () => {
    const created = await upsertSite({ key: "acme", name: "Acme", status: "active" });
    expect(created.statusCode).toBe(200);
    expect(created.json().data.key).toBe("acme");
    expect(created.json().data.status).toBe("active");
    const siteId = created.json().data.id as string;

    const renamed = await upsertSite({ key: "acme", name: "Acme Renamed" });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().data.id).toBe(siteId);
    expect(renamed.json().data.name).toBe("Acme Renamed");

    const list = await app.inject({ method: "GET", url: "/sites" });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0].id).toBe(siteId);
  });

  it("deletes and restores a site through HTTP without reusing its key", async () => {
    const site = await upsertSite({ key: "acme", name: "Acme", status: "active" });
    const siteId = site.json().data.id as string;
    await app.inject({
      method: "POST",
      url: "/site-domains/upsert",
      payload: { siteId, host: "a.com", status: "active" },
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/sites/${siteId}`,
      payload: { deletedBy: "operator-1", reason: "tenant closed" },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().data.id).toBe(siteId);
    expect(deleted.json().data.deletedAt).toEqual(expect.any(String));
    expect(deleted.json().data.deletedBy).toBe("operator-1");

    const active = await app.inject({ method: "GET", url: `/sites/${siteId}/active` });
    expect(active.json().data).toEqual({ active: false });

    const list = await app.inject({ method: "GET", url: "/sites" });
    expect(list.json().data).toEqual([]);

    const resolved = await app.inject({ method: "GET", url: "/site-context/resolve", query: { host: "a.com" } });
    expect(resolved.statusCode).toBe(404);

    const duplicated = await upsertSite({ key: "acme", name: "Acme Recreated" });
    expect(duplicated.statusCode).toBe(409);
    expect(duplicated.json().error.code).toBe("site.deleted");

    const restored = await app.inject({ method: "POST", url: `/sites/${siteId}/restore` });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().data.deletedAt).toBeNull();

    const renamed = await upsertSite({ key: "acme", name: "Acme Restored" });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().data.id).toBe(siteId);
  });

  it("upserts domain, app and policy under a site", async () => {
    const site = await upsertSite({ key: "acme", name: "Acme", status: "active" });
    const siteId = site.json().data.id as string;

    const domain = await app.inject({
      method: "POST",
      url: "/site-domains/upsert",
      payload: { siteId, host: "Acme.COM", status: "active", isPrimary: true },
    });
    expect(domain.statusCode).toBe(200);
    expect(domain.json().data.host).toBe("acme.com");
    expect(domain.json().data.isPrimary).toBe(true);

    const siteApp = await app.inject({
      method: "POST",
      url: "/site-apps/upsert",
      payload: { siteId, appKey: "web", surface: "general", status: "active", defaultRoute: "/" },
    });
    expect(siteApp.statusCode).toBe(200);
    expect(siteApp.json().data.appKey).toBe("web");
    expect(siteApp.json().data.surface).toBe("general");

    const policy = await app.inject({
      method: "POST",
      url: "/site-policies/upsert",
      payload: { siteId, key: "rate", value: { rpm: 60, burst: [1, null] } },
    });
    expect(policy.statusCode).toBe(200);
    expect(policy.json().data.key).toBe("rate");
    expect(policy.json().data.value).toEqual({ rpm: 60, burst: [1, null] });
  });

  it("deletes and restores a site domain through HTTP without reusing its host", async () => {
    const site = await upsertSite({ key: "acme", name: "Acme", status: "active" });
    const siteId = site.json().data.id as string;
    const domain = await app.inject({
      method: "POST",
      url: "/site-domains/upsert",
      payload: { siteId, host: "A.COM", status: "active", isPrimary: true },
    });
    const domainId = domain.json().data.id as string;

    const deleted = await app.inject({
      method: "DELETE",
      url: `/site-domains/${domainId}`,
      payload: { deletedBy: "operator-1", reason: "domain retired" },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().data.deletedAt).toEqual(expect.any(String));
    expect(deleted.json().data.deleteReason).toBe("domain retired");

    const resolved = await app.inject({ method: "GET", url: "/site-context/resolve", query: { host: "a.com" } });
    expect(resolved.statusCode).toBe(404);

    const duplicated = await app.inject({
      method: "POST",
      url: "/site-domains/upsert",
      payload: { siteId, host: "a.com" },
    });
    expect(duplicated.statusCode).toBe(409);
    expect(duplicated.json().error.code).toBe("site_domain.deleted");

    const restored = await app.inject({ method: "POST", url: `/site-domains/${domainId}/restore` });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().data.deletedAt).toBeNull();

    const resolvedAgain = await app.inject({ method: "GET", url: "/site-context/resolve", query: { host: "a.com" } });
    expect(resolvedAgain.statusCode).toBe(200);
    expect(resolvedAgain.json().data.context.siteId).toBe(siteId);
  });

  it("resolves site context for an active domain on an active site (200)", async () => {
    const site = await upsertSite({ key: "acme", name: "Acme", status: "active" });
    const siteId = site.json().data.id as string;
    await app.inject({
      method: "POST",
      url: "/site-domains/upsert",
      payload: { siteId, host: "a.com", status: "active" },
    });
    await app.inject({
      method: "POST",
      url: "/site-apps/upsert",
      payload: { siteId, appKey: "web", surface: "general", status: "active" },
    });

    const resolved = await app.inject({
      method: "GET",
      url: "/site-context/resolve",
      query: { host: "A.com", appKey: "web", surface: "general" },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().data.context.siteKey).toBe("acme");
    expect(resolved.json().data.context.host).toBe("a.com");
    expect(resolved.json().data.app.appKey).toBe("web");
  });

  it("marks a local domain verified over HTTP and exposes brand in resolve", async () => {
    const site = await upsertSite({
      key: "brandco",
      name: "Brand Co",
      status: "active",
      brandThemeColor: "#ff5722",
    });
    const siteId = site.json().data.id as string;

    const domain = await app.inject({
      method: "POST",
      url: "/site-domains/upsert",
      payload: { siteId, host: "localhost", status: "pending_verification" },
    });
    const domainId = domain.json().data.id as string;
    expect(domain.json().data.verificationToken).toMatch(/^kokoro-site-verification=/);

    // pending 域名不解析。
    const beforeMark = await app.inject({ method: "GET", url: "/site-context/resolve", query: { host: "localhost" } });
    expect(beforeMark.statusCode).toBe(404);

    const marked = await app.inject({ method: "POST", url: `/site-domains/${domainId}/mark-verified` });
    expect(marked.statusCode).toBe(200);
    expect(marked.json().data.status).toBe("active");
    expect(marked.json().data.verifiedAt).toEqual(expect.any(String));

    const resolved = await app.inject({ method: "GET", url: "/site-context/resolve", query: { host: "localhost" } });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().data.context.brand).toEqual({
      name: "Brand Co",
      logoUrl: null,
      themeColor: "#ff5722",
    });
  });

  it("rejects mark-verified on a public host with a 400", async () => {
    const site = await upsertSite({ key: "acme", name: "Acme", status: "active" });
    const siteId = site.json().data.id as string;
    const domain = await app.inject({
      method: "POST",
      url: "/site-domains/upsert",
      payload: { siteId, host: "public.com", status: "pending_verification" },
    });
    const domainId = domain.json().data.id as string;

    const marked = await app.inject({ method: "POST", url: `/site-domains/${domainId}/mark-verified` });
    expect(marked.statusCode).toBe(400);
    expect(marked.json().error.code).toBe("site_domain.not_local");
  });

  it("returns verified=false with a reason when DNS verification finds no TXT record", async () => {
    const site = await upsertSite({ key: "acme", name: "Acme", status: "active" });
    const siteId = site.json().data.id as string;
    const domain = await app.inject({
      method: "POST",
      url: "/site-domains/upsert",
      payload: { siteId, host: "no-such-domain.invalid", status: "pending_verification" },
    });
    const domainId = domain.json().data.id as string;

    const verify = await app.inject({ method: "POST", url: `/site-domains/${domainId}/verify` });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().data.verified).toBe(false);
    expect(verify.json().data.reason).toBe("txt_record_not_found");
  });

  it("returns 404 when host is not bound to any site", async () => {
    const resolved = await app.inject({
      method: "GET",
      url: "/site-context/resolve",
      query: { host: "unbound.com" },
    });
    expect(resolved.statusCode).toBe(404);
    expect(resolved.json().error.code).toBe("site_context.not_found");
  });

  it("rejects unknown fields on upsert with a 400 (.strict)", async () => {
    const response = await upsertSite({ key: "acme", name: "Acme", bogus: "x" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("request.invalid");
  });

  it("rejects a missing required field on resolve with a 400", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/site-context/resolve",
      query: { appKey: "web" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("request.invalid");
  });
});
