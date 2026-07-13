import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../../generated/prisma/index.js";
import type { DomainVerifier } from "../../src/domain/domain-verifier.js";
import { SiteService } from "../../src/application/site-service.js";
import { PrismaSiteRepository } from "../../src/infrastructure/prisma/prisma-site-repository.js";

// WHY: needs a real MySQL bound to DATABASE_URL_SITE; exercises domain verification + brand over the repository.
const prisma = new PrismaClient();
const repository = new PrismaSiteRepository(prisma);

// 可编程 TXT 查询假件：按 host 返回预置记录，模拟 DNS 命中/未命中，不打真实网络。
class StubVerifier implements DomainVerifier {
  constructor(private readonly records: Record<string, string[]> = {}) {}
  async lookupTxt(host: string): Promise<string[]> {
    return this.records[host] ?? [];
  }
}

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

describe("site brand round-trip", () => {
  it("persists brand logo/theme and projects them into resolve context", async () => {
    const service = new SiteService(repository, new StubVerifier());
    const site = await repository.upsertSite({
      key: "brandco",
      name: "Brand Co",
      status: "active",
      brandLogoUrl: "https://cdn.example.com/brandco.svg",
      brandThemeColor: "#ff5722",
    });
    expect(site.brandLogoUrl).toBe("https://cdn.example.com/brandco.svg");
    expect(site.brandThemeColor).toBe("#ff5722");

    await repository.upsertSiteDomain({ siteId: site.id, host: "brandco.com", status: "active" });
    const resolved = await service.resolveSiteContext({ host: "brandco.com" });
    expect(resolved?.context.brand).toEqual({
      name: "Brand Co",
      logoUrl: "https://cdn.example.com/brandco.svg",
      themeColor: "#ff5722",
    });
  });

  it("defaults brand logo/theme to null when unset", async () => {
    const site = await repository.upsertSite({ key: "plain", name: "Plain", status: "active" });
    expect(site.brandLogoUrl).toBeNull();
    expect(site.brandThemeColor).toBeNull();
  });
});

describe("site domain verification", () => {
  it("generates a verification token on create", async () => {
    const site = await repository.upsertSite({ key: "acme", name: "Acme", status: "active" });
    const domain = await repository.upsertSiteDomain({
      siteId: site.id,
      host: "acme.com",
      status: "pending_verification",
    });
    expect(domain.verificationToken).toMatch(/^kokoro-site-verification=/);
    expect(domain.verifiedAt).toBeNull();
  });

  it("does not resolve a pending domain, then resolves once DNS verification succeeds", async () => {
    const site = await repository.upsertSite({ key: "acme", name: "Acme", status: "active" });
    const domain = await repository.upsertSiteDomain({
      siteId: site.id,
      host: "acme.com",
      status: "pending_verification",
    });
    expect(await repository.resolveSiteContext({ host: "acme.com" })).toBeNull();

    const token = domain.verificationToken!;
    const service = new SiteService(repository, new StubVerifier({ "acme.com": ["unrelated", token] }));

    const result = await service.verifySiteDomain(domain.id);
    expect(result.verified).toBe(true);
    if (result.verified) {
      expect(result.domain.status).toBe("active");
      expect(result.domain.verifiedAt).toBeInstanceOf(Date);
    }

    const resolved = await repository.resolveSiteContext({ host: "acme.com" });
    expect(resolved?.context.siteId).toBe(site.id);
  });

  it("keeps a domain pending with a reason when the TXT record is missing", async () => {
    const site = await repository.upsertSite({ key: "acme", name: "Acme", status: "active" });
    const domain = await repository.upsertSiteDomain({
      siteId: site.id,
      host: "acme.com",
      status: "pending_verification",
    });

    const service = new SiteService(repository, new StubVerifier({ "acme.com": ["wrong-value"] }));
    const result = await service.verifySiteDomain(domain.id);

    expect(result.verified).toBe(false);
    if (!result.verified) {
      expect(result.reason).toBe("txt_record_not_found");
    }
    const still = await repository.getSiteDomainById(domain.id);
    expect(still?.status).toBe("pending_verification");
    expect(still?.verifiedAt).toBeNull();
  });

  it("allows a local host to be marked verified directly, but rejects a public host", async () => {
    const site = await repository.upsertSite({ key: "dev", name: "Dev", status: "active" });
    const local = await repository.upsertSiteDomain({
      siteId: site.id,
      host: "localhost",
      status: "pending_verification",
    });
    const publicDomain = await repository.upsertSiteDomain({
      siteId: site.id,
      host: "public.com",
      status: "pending_verification",
    });

    const service = new SiteService(repository, new StubVerifier());
    const marked = await service.markSiteDomainVerified(local.id);
    expect(marked.status).toBe("active");
    expect(marked.verifiedAt).toBeInstanceOf(Date);

    await expect(service.markSiteDomainVerified(publicDomain.id)).rejects.toMatchObject({
      code: "site_domain.not_local",
    });
  });
});
