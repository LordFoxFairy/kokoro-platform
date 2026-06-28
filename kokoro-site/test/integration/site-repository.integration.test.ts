import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../../generated/prisma/index.js";
import { PrismaSiteRepository } from "../../src/infrastructure/prisma/prisma-site-repository.js";

// WHY: needs a real MySQL bound to DATABASE_URL_SITE; written, not run in CI without DB.
const prisma = new PrismaClient();
const repository = new PrismaSiteRepository(prisma);

async function reset(): Promise<void> {
  await prisma.sitePolicy.deleteMany();
  await prisma.siteApp.deleteMany();
  await prisma.siteDomain.deleteMany();
  await prisma.site.deleteMany();
}

beforeEach(reset);
afterAll(async () => {
  await reset();
  await prisma.$disconnect();
});

describe("PrismaSiteRepository upsert idempotency", () => {
  it("re-upserting the same site key updates in place (no duplicate)", async () => {
    const first = await repository.upsertSite({ key: "acme", name: "Acme" });
    const second = await repository.upsertSite({ key: "acme", name: "Acme Renamed" });

    expect(second.id).toBe(first.id);
    expect(second.name).toBe("Acme Renamed");
    expect(await repository.listSites()).toHaveLength(1);
  });

  it("re-upserting the same domain host updates in place", async () => {
    const site = await repository.upsertSite({ key: "acme", name: "Acme" });
    const first = await repository.upsertSiteDomain({ siteId: site.id, host: "Acme.COM" });
    const second = await repository.upsertSiteDomain({ siteId: site.id, host: "acme.com", isPrimary: true });

    expect(second.id).toBe(first.id);
    expect(second.host).toBe("acme.com");
    expect(second.isPrimary).toBe(true);
  });

  it("persists JSON policy value verbatim and updates on re-upsert", async () => {
    const site = await repository.upsertSite({ key: "acme", name: "Acme" });
    await repository.upsertSitePolicy({ siteId: site.id, key: "rate", value: { rpm: 60 } });
    const updated = await repository.upsertSitePolicy({
      siteId: site.id,
      key: "rate",
      value: { rpm: 120, burst: [1, null] },
    });

    expect(updated.value).toEqual({ rpm: 120, burst: [1, null] });
  });
});

describe("PrismaSiteRepository.resolveSiteContext guards", () => {
  it("returns null when the host is not bound", async () => {
    expect(await repository.resolveSiteContext({ host: "unbound.com" })).toBeNull();
  });

  it("returns null when the domain is not active", async () => {
    const site = await repository.upsertSite({ key: "acme", name: "Acme", status: "active" });
    await repository.upsertSiteDomain({ siteId: site.id, host: "a.com", status: "disabled" });

    expect(await repository.resolveSiteContext({ host: "a.com" })).toBeNull();
  });

  it("returns null when the site is not active", async () => {
    const site = await repository.upsertSite({ key: "acme", name: "Acme", status: "suspended" });
    await repository.upsertSiteDomain({ siteId: site.id, host: "a.com", status: "active" });

    expect(await repository.resolveSiteContext({ host: "a.com" })).toBeNull();
  });

  it("resolves context for an active domain on an active site", async () => {
    const site = await repository.upsertSite({ key: "acme", name: "Acme", status: "active" });
    await repository.upsertSiteDomain({ siteId: site.id, host: "a.com", status: "active" });
    await repository.upsertSiteApp({ siteId: site.id, appKey: "web", surface: "general", status: "active" });

    const resolved = await repository.resolveSiteContext({ host: "A.com", appKey: "web", surface: "general" });

    expect(resolved).not.toBeNull();
    expect(resolved?.context.siteKey).toBe("acme");
    expect(resolved?.context.host).toBe("a.com");
    expect(resolved?.app?.appKey).toBe("web");
  });
});
