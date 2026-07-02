import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../../generated/prisma/index.js";
import { PrismaSiteRepository } from "../../src/infrastructure/prisma/prisma-site-repository.js";

// WHY: needs a real MySQL bound to DATABASE_URL_SITE; written, not run in CI without DB.
const prisma = new PrismaClient();
const repository = new PrismaSiteRepository(prisma);

async function reset(): Promise<void> {
  await prisma.siteFeatureFlag.deleteMany();
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

  it("normalizes the site key (case/whitespace) so variants map to one tenant root", async () => {
    const first = await repository.upsertSite({ key: "Acme", name: "Acme" });
    const second = await repository.upsertSite({ key: "  acme  ", name: "Acme Renamed" });
    expect(second.id).toBe(first.id);
    expect(second.key).toBe("acme");
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

describe("PrismaSiteRepository.resolveSiteActive", () => {
  it("is true only for an existing active site (false for suspended or missing)", async () => {
    const active = await repository.upsertSite({ key: "live", name: "Live", status: "active" });
    const suspended = await repository.upsertSite({ key: "down", name: "Down", status: "suspended" });
    expect(await repository.resolveSiteActive(active.id)).toBe(true);
    expect(await repository.resolveSiteActive(suspended.id)).toBe(false);
    expect(await repository.resolveSiteActive("missing-site-id")).toBe(false);
  });
});

describe("PrismaSiteRepository soft deletion", () => {
  it("soft deletes a site from default read surfaces while retaining audit fields", async () => {
    const site = await repository.upsertSite({ key: "acme", name: "Acme", status: "active" });
    await repository.upsertSiteDomain({ siteId: site.id, host: "a.com", status: "active" });

    const deleted = await repository.deleteSite({
      id: site.id,
      deletedBy: "operator-1",
      reason: "tenant closed",
    });

    expect(deleted.id).toBe(site.id);
    expect(deleted.deletedAt).toBeInstanceOf(Date);
    expect(deleted.deletedBy).toBe("operator-1");
    expect(deleted.deleteReason).toBe("tenant closed");
    expect(await repository.resolveSiteActive(site.id)).toBe(false);
    expect(await repository.resolveSiteContext({ host: "a.com" })).toBeNull();
    expect(await repository.listSites()).toEqual([]);
    expect(await repository.listAdminSites()).toEqual([]);

    const withDeleted = await repository.listAdminSites({ includeDeleted: true });
    expect(withDeleted).toHaveLength(1);
    expect(withDeleted[0]?.id).toBe(site.id);
    expect(withDeleted[0]?.deletedAt).toBeInstanceOf(Date);
  });

  it("keeps site keys reserved after soft deletion until the site is restored", async () => {
    const site = await repository.upsertSite({ key: "acme", name: "Acme", status: "active" });
    await repository.deleteSite({ id: site.id, deletedBy: "operator-1", reason: "tenant closed" });

    await expect(repository.upsertSite({ key: "acme", name: "Acme Recreated" })).rejects.toMatchObject({
      code: "site.deleted",
    });

    const restored = await repository.restoreSite({ id: site.id });
    expect(restored.deletedAt).toBeNull();
    expect(restored.deletedBy).toBeNull();
    expect(restored.deleteReason).toBeNull();
    expect(await repository.resolveSiteActive(site.id)).toBe(true);

    const renamed = await repository.upsertSite({ key: "acme", name: "Acme Restored" });
    expect(renamed.id).toBe(site.id);
    expect(renamed.name).toBe("Acme Restored");
  });

  it("soft deletes a domain without hard-deleting or reusing the host", async () => {
    const site = await repository.upsertSite({ key: "acme", name: "Acme", status: "active" });
    const domain = await repository.upsertSiteDomain({
      siteId: site.id,
      host: "A.COM",
      status: "active",
      isPrimary: true,
    });

    const deleted = await repository.deleteSiteDomain({
      id: domain.id,
      deletedBy: "operator-1",
      reason: "domain retired",
    });

    expect(deleted.id).toBe(domain.id);
    expect(deleted.deletedAt).toBeInstanceOf(Date);
    expect(deleted.deletedBy).toBe("operator-1");
    expect(deleted.deleteReason).toBe("domain retired");
    expect(await repository.resolveSiteContext({ host: "a.com" })).toBeNull();
    expect(await repository.listAdminSiteDomains()).toEqual([]);

    await expect(repository.upsertSiteDomain({ siteId: site.id, host: "a.com" })).rejects.toMatchObject({
      code: "site_domain.deleted",
    });

    const withDeleted = await repository.listAdminSiteDomains({ includeDeleted: true });
    expect(withDeleted).toHaveLength(1);
    expect(withDeleted[0]?.id).toBe(domain.id);

    const restored = await repository.restoreSiteDomain({ id: domain.id });
    expect(restored.deletedAt).toBeNull();
    expect(restored.deletedBy).toBeNull();
    expect(restored.deleteReason).toBeNull();

    const resolved = await repository.resolveSiteContext({ host: "a.com" });
    expect(resolved?.context.siteId).toBe(site.id);
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
